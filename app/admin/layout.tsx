import { notFound } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/lib/supabase';
import { ADMIN_ROLES } from '@/lib/admin';
import { CREST } from '@/lib/crest';

export const dynamic = 'force-dynamic';

/**
 * The technical side of LOTS AI: spend, models, latency, failures, and who is
 * using the thing.
 *
 * Everything here was taken off the teacher's screen, not deleted. A teacher
 * planning week four has no use for a cache-hit ratio and no way to act on a
 * Storage error; whoever answers to the board for the bill has both.
 *
 * The check runs in the layout, so every page beneath it inherits the gate and
 * no route can be added that forgets to ask. It answers notFound() rather than
 * 403: a teacher who guesses the URL should learn that there is nothing here,
 * not that there is something here they cannot have. Nothing in the teacher UI
 * links to /admin.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let user;
  try { user = await currentUser(); } catch { notFound(); }
  if (!ADMIN_ROLES.includes(user.role)) notFound();

  return (
    <div className="admin">
      <header className="ahead">
        <div className="abrand">
          <img src={CREST} alt="" />
          <div>
            <b>LOTS AI</b>
            <span>Administration</span>
          </div>
        </div>
        <nav className="atabs">
          <Link href="/admin">Overview</Link>
          <Link href="/admin/people">People</Link>
          <Link href="/admin/activity">Activity</Link>
          <Link href="/admin/health">Health</Link>
          <Link href="/" className="aback">Back to LOTS AI</Link>
        </nav>
        <span className="awho">{user.full_name}</span>
      </header>
      <main className="abody">{children}</main>
    </div>
  );
}
