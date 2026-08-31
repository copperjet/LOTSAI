import { NextRequest, NextResponse } from 'next/server';
import { GATE_COOKIE, gateToken, sameToken } from '@/lib/sitegate';
import { SESSION_COOKIE } from '@/lib/auth';

/**
 * Two doors, in order.
 *
 * 1. The shared school password. Nothing is served without it — the pages and
 *    the API routes alike, because the API is the part that reads planners and
 *    spends credits. Fails closed: a production deployment with no
 *    SITE_PASSWORD serves the door and nothing else. Locally, with no
 *    SITE_PASSWORD, it stands aside.
 *
 * 2. A personal session. Only its presence is checked here, because middleware
 *    runs on the edge and must not query the database on every request; whether
 *    the token is real, unexpired and attached to an active person is settled
 *    by currentUser() in lib/supabase.ts, which every route already calls.
 *    A forged cookie therefore gets past this line and no further.
 *
 * The second door is what makes ai_usage.user_id and audit_log.actor_id worth
 * reading. Before it, everyone past the password was the same seeded person.
 */
export async function middleware(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  const dev = process.env.NODE_ENV !== 'production';

  if (!password) {
    if (!dev) return redirect(req, '/gate', 'unset');
  } else {
    const carried = req.cookies.get(GATE_COOKIE)?.value;
    if (!sameToken(carried, await gateToken(password))) return redirect(req, '/gate', null);
  }

  // Locally, DEMO_USER_EMAIL still stands in for a session so the seed scripts
  // and a bare `npm run dev` keep working. In production there is no such thing.
  if (!req.cookies.get(SESSION_COOKIE)?.value && (!dev || !process.env.DEMO_USER_EMAIL)) {
    return redirect(req, '/signin', null);
  }

  return NextResponse.next();
}

function redirect(req: NextRequest, pathname: string, problem: string | null) {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = '';
  if (problem) url.searchParams.set('e', problem);
  // Where to send them back to once they are through.
  const from = req.nextUrl.pathname + req.nextUrl.search;
  if (from && from !== '/') url.searchParams.set('next', from);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the two doors themselves, the static files a browser
  // needs to render them, and Sprout.
  matcher: ['/((?!gate|api/gate|signin|api/signin|_next/static|_next/image|favicon.ico|sprout-walk).*)'],
};
