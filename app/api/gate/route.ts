import { NextRequest, NextResponse } from 'next/server';
import { GATE_COOKIE, gateToken } from '@/lib/sitegate';

export const runtime = 'nodejs';

/**
 * POST /api/gate — the only route the middleware lets through unauthenticated.
 *
 * A wrong password is answered slowly and identically every time, so the form
 * cannot be used to measure anything.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const given = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/');
  const password = process.env.SITE_PASSWORD;

  // Same delay whether or not the password is set, and whether or not it matched.
  await new Promise(r => setTimeout(r, 400));

  const ok = !!password && (await gateToken(given)) === (await gateToken(password));
  if (!ok) {
    const back = new URL('/gate', req.url);
    back.searchParams.set('e', password ? 'wrong' : 'unset');
    if (next && next !== '/') back.searchParams.set('next', next);
    return NextResponse.redirect(back, 303);
  }

  // Only ever redirect somewhere on this site.
  const target = new URL(next.startsWith('/') ? next : '/', req.url);
  const res = NextResponse.redirect(target, 303);
  res.cookies.set(GATE_COOKIE, await gateToken(password!), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,   // a month; a term would be too long to revoke
  });
  return res;
}
