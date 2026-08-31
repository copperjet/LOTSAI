import { NextRequest, NextResponse } from 'next/server';
import { admin, audit } from '@/lib/supabase';
import {
  SESSION_COOKIE, SESSION_DAYS, LOCK_AFTER, LOCK_MINUTES,
  hashPin, verifyPin, pinShape, newSessionToken, sessionDigest,
} from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * POST /api/signin  { who, pin, again?, next }
 *
 * Two jobs in one handler, because to the teacher they are one action: set a
 * PIN the first time, check it every time after.
 *
 * Every failure answers in the same shape and after the same delay. A person
 * standing at this form must not be able to tell an unknown name from a wrong
 * PIN from a locked account — the first of those would otherwise be a way to
 * enumerate the staff list, and the last a way to confirm you had found a real
 * account by getting it locked.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const who = String(form.get('who') ?? '');
  const pin = String(form.get('pin') ?? '');
  const again = String(form.get('again') ?? '');
  const next = String(form.get('next') ?? '/');

  // The same wait whatever happens, so timing says nothing.
  await new Promise(r => setTimeout(r, 400));

  const db = admin();
  const { data: user } = await db.from('app_user')
    .select('id, email, full_name, pin_hash, is_active, failed_attempts, locked_until')
    .eq('id', who).maybeSingle();

  if (!user || user.is_active === false) return back(req, 'nobody', next);

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return back(req, 'locked', next, who);
  }

  if (!user.pin_hash) {
    // First sign-in: this is where the PIN comes from.
    const wrong = pinShape(pin);
    if (wrong) return back(req, 'shape', next, who);
    if (pin !== again) return back(req, 'mismatch', next, who);
    await db.from('app_user')
      .update({ pin_hash: await hashPin(pin), pin_set_at: new Date().toISOString() })
      .eq('id', user.id);
    await audit(user.id, 'signin.pin_set');
  } else if (!(await verifyPin(pin, user.pin_hash))) {
    const attempts = (user.failed_attempts ?? 0) + 1;
    await db.from('app_user').update({
      failed_attempts: attempts,
      locked_until: attempts >= LOCK_AFTER
        ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
        : null,
    }).eq('id', user.id);
    return back(req, attempts >= LOCK_AFTER ? 'locked' : 'wrong', next, who);
  }

  const token = newSessionToken();
  await db.from('user_session').insert({
    user_id: user.id,
    token_hash: await sessionDigest(token),
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300),
    expires_at: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(),
  });
  await db.from('app_user')
    .update({ failed_attempts: 0, locked_until: null, last_seen_at: new Date().toISOString() })
    .eq('id', user.id);
  await audit(user.id, 'signin.success');

  const res = NextResponse.redirect(new URL(next.startsWith('/') ? next : '/', req.url), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400,
  });
  return res;
}

function back(req: NextRequest, problem: string, next: string, who?: string) {
  const url = new URL('/signin', req.url);
  url.searchParams.set('e', problem);
  if (who) url.searchParams.set('who', who);
  if (next && next !== '/') url.searchParams.set('next', next);
  return NextResponse.redirect(url, 303);
}
