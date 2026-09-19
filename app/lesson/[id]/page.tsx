import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/supabase';
import { viewUrl } from '@/lib/artefactUrl';
import { gateLesson } from '@/lib/lesson/gate';
import { loadAssets } from '@/lib/lesson/assets';
import { mayEdit, mayRead, readLesson } from '@/lib/lesson/persist';
import Editor from './Editor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The lesson editor.
 *
 * A route of its own rather than a turn in the chat, following /mail: a server
 * shell that establishes who is asking and what they may see, and a client body
 * that does the work. A slide list, a 16:9 canvas and an inspector do not fit in
 * a chat bubble, and app/page.tsx is three thousand lines already.
 *
 * notFound() rather than a 403, as /admin does: a teacher who guesses a colleague's
 * lesson URL should learn that there is nothing there, not that there is
 * something there they cannot have.
 */
export default async function LessonPage(
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

  // The pictures are inlined here rather than fetched by the browser: the canvas
  // renders with the same code as the artefact, and that code takes data URIs
  // because /api/document/view is behind sign-in and the headless print has no
  // session (lib/lesson/render_html.ts).
  const [assets, gate] = await Promise.all([loadAssets(id), gateLesson(id)]);

  return (
    <Editor
      lessonId={id}
      deck={row.content}
      gate={gate}
      approved={row.approved}
      renderNote={row.render_note}
      driveLink={row.drive_link}
      canEdit={mayEdit(row, user) && !row.approved}
      assets={assets}
      urls={{
        html: viewUrl('lesson', id),
        pdf: viewUrl('lesson-pdf', id),
        pptx: viewUrl('lesson-pptx', id),
      }}
    />
  );
}
