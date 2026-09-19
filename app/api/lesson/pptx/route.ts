import { NextRequest, NextResponse } from 'next/server';
import { admin, audit, currentUser } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';
import { viewUrl } from '@/lib/artefactUrl';
import { mayRead, readLesson } from '@/lib/lesson/persist';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/lesson/pptx  { lessonId }   - build it and store it
 * GET  /api/lesson/pptx?lessonId=<id>   - where to download it from
 *
 * The PowerPoint is built on demand rather than at generation, for two reasons.
 * Generation is already three model calls inside one request and adding a
 * rasterising pass to the end of it is how a teacher meets the 300 second
 * ceiling; and most decks are edited before anyone exports one, so building it
 * at generation would mostly be building the wrong version.
 *
 * It needs no browser, which is what makes it the export a teacher is pointed
 * at: the PDF depends on Chromium starting inside a serverless container, and
 * this depends on nothing but the bytes already in the database.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { lessonId } = await req.json() as { lessonId?: string };
  if (!lessonId) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });

  const row = await readLesson(lessonId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayRead(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });

  const { standard: std } = await engine.resolveWorkflow('lesson');
  // storeArtefact dispatches by the Standard's renderer_id, and the Standard's
  // own renderer is the HTML. Naming the PowerPoint renderer here is how one
  // document gets three renderings without three Standards.
  const render = await storeArtefact({ ...std, renderer_id: 'lesson-pptx' }, lessonId);

  if (!render.ok) {
    console.error(`[lesson] pptx render failed: ${render.error}`);
    return NextResponse.json({
      error: 'render_failed',
      message: 'The PowerPoint could not be built just now. Your lesson is saved - try again in a '
        + 'moment.',
    }, { status: 502 });
  }

  await db.from('lesson').update({ pptx_path: render.path }).eq('id', lessonId);
  await audit(user.id, 'lesson.pptx', 'lesson', lessonId);

  // Re-read: the renderer records on the row when a diagram had to degrade.
  const after = await readLesson(lessonId);

  return NextResponse.json({
    ok: true,
    path: render.path,
    url: viewUrl('lesson-pptx', lessonId),
    renderNote: after?.render_note ?? null,
  });
}

export async function GET(req: NextRequest) {
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('lessonId');
  if (!id) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });

  const row = await readLesson(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayRead(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });

  return NextResponse.json({
    // Null until it has been built once, which is what tells the editor to
    // build it rather than to link straight to bytes that are not there.
    path: row.pptx_path,
    url: viewUrl('lesson-pptx', id),
    renderNote: row.render_note,
  });
}
