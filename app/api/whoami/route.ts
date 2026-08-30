import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, DEMO_COOKIE } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * GET  /api/whoami  — who I am, and who else this demo can be
 * POST /api/whoami  { email } — become that person
 *
 * v1 has no sign-in: everyone past the site password is already the same
 * seeded user, so letting the rail switch between the seeded people costs
 * nothing that was being protected, and it is the only way to see the HOD's
 * side of the app. It goes when Google Workspace SSO arrives, along with
 * middleware.ts and lib/sitegate.ts.
 */

export async function GET() {
  const user = await currentUser();
  const { data } = await admin().from('app_user')
    .select('email, full_name, role').order('role').order('full_name');
  return NextResponse.json({ current: user.email, people: data ?? [] });
}

export async function POST(req: NextRequest) {
  const { email } = await req.json();

  // Only somebody who already exists. The cookie is never trusted as a name.
  const { data } = await admin().from('app_user').select('email').eq('email', email).maybeSingle();
  if (!data) return NextResponse.json({ error: 'Unknown user' }, { status: 404 });

  const res = NextResponse.json({ ok: true, email: data.email });
  res.cookies.set(DEMO_COOKIE, data.email, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
