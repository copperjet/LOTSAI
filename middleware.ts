import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

/**
 * One door: a personal session.
 *
 * Only the cookie's presence is checked here, because middleware runs on the
 * edge and must not query the database on every request; whether the token is
 * real, unexpired and attached to an active person is settled by currentUser()
 * in lib/supabase.ts, which every route already calls. A forged cookie
 * therefore gets past this line and no further.
 *
 * This door is what makes ai_usage.user_id and audit_log.actor_id worth
 * reading.
 */
export async function middleware(req: NextRequest) {
  const dev = process.env.NODE_ENV !== 'production';

  // Locally, DEMO_USER_EMAIL still stands in for a session so the seed scripts
  // and a bare `npm run dev` keep working. In production there is no such thing.
  if (!req.cookies.get(SESSION_COOKIE)?.value && (!dev || !process.env.DEMO_USER_EMAIL)) {
    return redirect(req, '/signin');
  }

  return NextResponse.next();
}

function redirect(req: NextRequest, pathname: string) {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = '';
  // Where to send them back to once they are through.
  const from = req.nextUrl.pathname + req.nextUrl.search;
  if (from && from !== '/') url.searchParams.set('next', from);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the door itself, the static files a browser needs to
  // render it, and Sprout.
  matcher: ['/((?!signin|api/signin|_next/static|_next/image|favicon.ico|sprout-walk).*)'],
};
