import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/supabase';
import { SESSION_COOKIE, sessionDigest } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * POST /api/signout — end this device's session.
 *
 * The row is deleted rather than marked, so a stolen cookie stops working at
 * once and there is nothing left to un-expire. Signing out on one device leaves
 * the others alone; /admin/people is where a session on a device someone no
 * longer has is revoked.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await admin().from('user_session').delete().eq('token_hash', await sessionDigest(token));
    } catch { /* the cookie is cleared either way */ }
  }
  const res = NextResponse.redirect(new URL('/signin', req.url), 303);
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
