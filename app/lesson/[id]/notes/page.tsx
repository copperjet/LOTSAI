import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/supabase';
import { mayRead, readLesson } from '@/lib/lesson/persist';
import Notes from './Notes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Presenter notes: the teaching guide, in a window of its own.
 *
 * Opened from the editor's Present mode and dragged to the teacher's own screen,
 * so the projector shows the slide and nothing else. It follows the presenting
 * window over a BroadcastChannel (app/lesson/[id]/Editor.tsx) and can move it on.
 *
 * Same gate as the editor: a teacher who guesses a colleague's lesson URL learns
 * that there is nothing here.
 */
export default async function NotesPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let user;
  try {
    user = await currentUser();
  } catch {
    notFound();
  }

  const row = await readLesson(id);
  if (!row || !mayRead(row, user)) notFound();

  return <Notes lessonId={id} deck={row.content} />;
}
