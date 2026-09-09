import { NextRequest, NextResponse } from 'next/server';
import { currentUser, audit } from '@/lib/supabase';
import { consentUrl, signState, mailMocked } from '@/lib/mail/oauth';
import { canStoreTokens } from '@/lib/mail/crypto';

export const runtime = 'nodejs';

/**
 * GET /api/mail/connect — send the teacher to Google.
 *
 * A GET that redirects, because it is reached from a link the teacher clicks and
 * Google's consent screen is the next page they see. The `state` is signed with the
 * teacher's id (lib/mail/oauth.ts): it is the only thing tying the callback to the
 * person who started, and an unsigned one would let a link in an email connect an
 * attacker's mailbox to a teacher's account.
 *
 * Refuses before it starts rather than halfway through. Sending someone to Google,
 * having them read a consent screen listing their whole mailbox, and only then
 * discovering there is nowhere safe to put the token is the worst order to do this
 * in — the grant exists at that point and nobody has recorded it.
 */
export async function GET(req: NextRequest) {
  const user = await currentUser();

  if (mailMocked()) {
    return back(req, 'mock');
  }
  if (!canStoreTokens()) {
    return back(req, 'nokey');
  }

  await audit(user.id, 'mail.connect.start');
  return NextResponse.redirect(consentUrl(req.nextUrl.origin, signState(user.id)));
}

function back(req: NextRequest, why: string) {
  const url = req.nextUrl.clone();
  url.pathname = '/mail';
  url.search = `?problem=${why}`;
  return NextResponse.redirect(url);
}
