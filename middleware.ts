import { NextRequest, NextResponse } from 'next/server';
import { GATE_COOKIE, gateToken, sameToken } from '@/lib/sitegate';

/**
 * Nothing is served until the shared password has been given — the pages and
 * the API routes alike, because the API is the part that reads planners and
 * spends credits.
 *
 * Fails closed: a production deployment with no SITE_PASSWORD set serves the
 * gate and nothing else. Forgetting the variable should mean a locked door, not
 * an open one. Locally, with no SITE_PASSWORD, the gate stands aside.
 */
export async function middleware(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  const dev = process.env.NODE_ENV !== 'production';

  if (!password) {
    if (dev) return NextResponse.next();
    return gateRedirect(req, 'unset');
  }

  const carried = req.cookies.get(GATE_COOKIE)?.value;
  if (sameToken(carried, await gateToken(password))) return NextResponse.next();

  return gateRedirect(req, null);
}

function gateRedirect(req: NextRequest, problem: string | null) {
  const url = req.nextUrl.clone();
  url.pathname = '/gate';
  url.search = '';
  if (problem) url.searchParams.set('e', problem);
  // Where to send them back to once they are through.
  const from = req.nextUrl.pathname + req.nextUrl.search;
  if (from && from !== '/') url.searchParams.set('next', from);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the gate itself and the static files a browser needs to
  // render it.
  matcher: ['/((?!gate|api/gate|_next/static|_next/image|favicon.ico).*)'],
};
