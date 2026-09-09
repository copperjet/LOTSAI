import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/supabase';
import Mail from './Mail';

export const dynamic = 'force-dynamic';

/**
 * The teacher's own inbox, triaged.
 *
 * A page rather than a card in the chat shell, because mail is the one thing here a
 * teacher arrives already in the middle of. The chat shell opens by telling them what
 * the timetable says they owe; this opens by telling them what other people are
 * waiting on, which is a different question and deserves its own screen.
 *
 * There is no role gate. Everybody has a mailbox, and the connection is per person —
 * a head of department gets no more of it than a teacher does, because the token is
 * the teacher's own and lives against their id.
 */
export default async function MailPage() {
  let user;
  try { user = await currentUser(); } catch { notFound(); }
  return <Mail name={user.full_name} />;
}
