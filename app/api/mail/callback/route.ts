import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { exchangeCode, readState, whoami, SCOPES } from '@/lib/mail/oauth';
import { seal, toHex } from '@/lib/mail/crypto';
import { forget } from '@/lib/mail/gmail';

export const runtime = 'nodejs';

/**
 * GET /api/mail/callback — where Google sends the teacher back.
 *
 * Everything arriving here is in a query string a browser was handed, so nothing in
 * it is trusted until the signature on `state` says who started the flow. Two checks,
 * both of which must pass:
 *
 *   1. `state` is signed, unexpired, and names a user.
 *   2. That user is the one holding this session. Without this the flow is still
 *      forgeable by anyone who can get a signed state — for instance the teacher's
 *      own, replayed in somebody else's browser.
 *
 * The refresh token is encrypted before it is written and never logged. `error` from
 * Google is the ordinary case, not an exception: it is what a teacher who reads the
 * consent screen and decides against it produces, and it should return them to the
 * page saying so rather than to a stack trace.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;

  if (q.get('error')) return back(req, q.get('error') === 'access_denied' ? 'declined' : 'refused');

  const state = readState(q.get('state') ?? '');
  const code = q.get('code');
  if (!state || !code) return back(req, 'state');

  let user;
  try { user = await currentUser(); } catch { return back(req, 'state'); }
  if (user.id !== state.userId) return back(req, 'state');

  try {
    const t = await exchangeCode(code, req.nextUrl.origin);

    // No refresh token means Google decided this was a re-consent it had already
    // granted. An access token alone is an hour of mail and then a mailbox that
    // silently stops working, so it is refused here rather than stored.
    if (!t.refreshToken) return back(req, 'norefresh');

    // A teacher can untick scopes on the consent screen. Sending them back with the
    // reason beats letting them find out when the archive button does nothing.
    const missing = SCOPES.filter(s => !t.scopes.includes(s));
    if (missing.length) return back(req, 'partial');

    const email = await whoami(t.accessToken);

    await admin().from('mail_account').upsert({
      user_id: user.id,
      email,
      refresh_token: toHex(seal(t.refreshToken)),
      scopes: t.scopes,
      connected_at: new Date().toISOString(),
      revoked_at: null,
    }, { onConflict: 'user_id' });

    // A reconnect may be a different Google account; a token cached for the old one
    // would keep working until it expired.
    forget(user.id);

    await admin().from('mail_action').insert({
      user_id: user.id, kind: 'connect', approved_by: user.id,
      detail: { email, scopes: t.scopes },
    });
    await audit(user.id, 'mail.connect', 'mail_account', user.id, { email });

    return back(req, null);
  } catch {
    // The message is not shown: it can carry fragments of a token exchange, and the
    // teacher can do nothing with it. /admin/health is where the detail belongs.
    return back(req, 'failed');
  }
}

function back(req: NextRequest, problem: string | null) {
  const url = req.nextUrl.clone();
  url.pathname = '/mail';
  url.search = problem ? `?problem=${problem}` : '?connected=1';
  return NextResponse.redirect(url);
}
