import { NextRequest, NextResponse } from 'next/server';
import { admin, audit, currentUser } from '@/lib/supabase';
import { REVIEWER_ROLES } from '@/lib/admin';
import * as engine from '@/lib/engine';
import { readArtefact, storeArtefact } from '@/lib/pdf/store';
import { driveMocked, uploadToDrive } from '@/lib/drive';
import { viewUrl } from '@/lib/artefactUrl';
import { YEAR } from '@/lib/lesson/context';
import { gateLesson } from '@/lib/lesson/gate';
import { mayEdit, readLesson } from '@/lib/lesson/persist';

export const runtime = 'nodejs';
export const maxDuration = 300;   // the PowerPoint, then a browser cold start for the PDF

/**
 * POST /api/lesson/approve  { lessonId }
 * PUT  /api/lesson/approve  { lessonId, action: 'return', comment? }
 *
 * The teacher who wrote the lesson approves it, as they do a worksheet and a
 * homework - a lesson is their own teaching, not a plan a head signs. Approval
 * puts it in the shared bank so the next teacher taking that class through that
 * week is offered it before they generate, and copies the PowerPoint into the
 * school's Drive folder.
 *
 * THE POWERPOINT IS WHAT GOES TO DRIVE, not the PDF. It is the file a colleague
 * can actually use: open it, change the two slides that do not suit their class,
 * and teach from it. A PDF of somebody else's lesson is a picture of a lesson.
 *
 * A blocking quality failure refuses the approval. The gate's checks are the
 * Standard's non-negotiables (0028), and approving past them would put a lesson
 * with no assessment, or one that teaches an objective it does not name, into
 * the bank under somebody's name.
 */
async function resolveFolder(
  db: ReturnType<typeof admin>, subjectId: string, yearGroup: string,
): Promise<string | null> {
  try {
    const { data } = await db.from('drive_folder').select('folder_id')
      .eq('artefact_type', 'lesson').eq('academic_year', YEAR)
      .eq('subject_id', subjectId).eq('year_group', yearGroup).maybeSingle();
    if (data?.folder_id) return data.folder_id;
  } catch { /* 0009 not applied, or no mapping for lessons yet - fall back */ }
  return process.env.DRIVE_DEFAULT_FOLDER_ID ?? null;
}

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { lessonId } = await req.json() as { lessonId?: string };
  if (!lessonId) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });

  const row = await readLesson(lessonId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayEdit(row, user)) {
    return NextResponse.json({
      error: 'not_yours',
      message: 'Only the teacher who wrote this lesson can approve it.',
    }, { status: 403 });
  }
  if (row.approved) {
    return NextResponse.json({ ok: true, status: 'approved', already: true });
  }

  // ---- the quality gate has the last word
  const gate = await gateLesson(lessonId);
  if (gate.blocking) {
    const problems = gate.checks.filter(c => c.status === 'block');
    return NextResponse.json({
      error: 'blocked',
      message: problems.length === 1
        ? `${problems[0].title}. ${problems[0].detail}`
        : `${problems.length} things have to be fixed before this can go in the shared bank.`,
      gate,
    }, { status: 409 });
  }

  const { standard } = await engine.resolveWorkflow('lesson');

  // ---- the PowerPoint: the artefact, and the thing that goes to Drive
  const pptx = await storeArtefact({ ...standard, renderer_id: 'lesson-pptx' }, lessonId);
  if (!pptx.ok || !pptx.path) {
    console.error(`[lesson] approve: pptx render failed: ${pptx.error}`);
    return NextResponse.json({
      error: 'render_failed',
      message: 'The PowerPoint could not be built, so nothing was approved. Your lesson is saved.',
    }, { status: 500 });
  }
  const bytes = await readArtefact(pptx.path);
  if (!bytes) {
    return NextResponse.json({
      error: 'render_failed',
      message: 'The PowerPoint was built but could not be read back, so nothing was sent to Drive.',
    }, { status: 500 });
  }

  const folderId = await resolveFolder(db, row.subject_id, row.year_group);
  if (!folderId && !driveMocked()) {
    return NextResponse.json({
      error: 'no_folder',
      message: `No Drive folder is set up for ${row.year_group} ${row.subject_id}. Ask an `
        + 'administrator to map one before this lesson can be sent to Drive.',
    }, { status: 409 });
  }

  const safeName = (row.title || 'Lesson').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120);
  const week = row.week_number ? ` wk${row.week_number}` : '';
  const drive = await uploadToDrive({
    folderId: folderId ?? 'mock-folder',
    filename: `${safeName} - ${row.year_group} ${row.subject_id}${week}.pptx`,
    bytes,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  if (!drive.ok) {
    console.error(`[drive] lesson ${lessonId}: ${drive.error}`);
    return NextResponse.json({
      error: 'drive_failed',
      message: 'The lesson is saved, but it could not be copied to the school Drive yet.',
    }, { status: 502 });
  }

  await db.from('lesson').update({
    status: 'approved', approved: true, approved_at: new Date().toISOString(),
    pptx_path: pptx.path,
    drive_file_id: drive.fileId ?? null, drive_link: drive.link ?? null,
  }).eq('id', lessonId);

  // ---- the printable copy, last and optional
  //
  // It needs Chromium, which cold-starts inside this request and is the one
  // thing here that can time out. The lesson is already approved and in Drive by
  // this point, so a failure is recorded on the row and shown in /admin/health
  // rather than failing an approval that has otherwise succeeded.
  let pdfPath: string | null = null;
  try {
    const pdf = await storeArtefact({ ...standard, renderer_id: 'lesson-pdf' }, lessonId);
    if (pdf.ok && pdf.path) {
      pdfPath = pdf.path;
      await db.from('lesson').update({ pdf_path: pdf.path }).eq('id', lessonId);
    }
  } catch (e) {
    console.error(`[lesson] approve: pdf render failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await audit(user.id, 'lesson.approve', 'lesson', lessonId, {
    drive_file_id: drive.fileId, mock: drive.mock, pdf: !!pdfPath,
  });

  return NextResponse.json({
    ok: true,
    status: 'approved',
    gate,
    pptxUrl: viewUrl('lesson-pptx', lessonId),
    pdfUrl: pdfPath ? viewUrl('lesson-pdf', lessonId) : null,
    drive: { mock: drive.mock, link: drive.link, folderId: drive.folderId, fileId: drive.fileId },
  });
}

/**
 * PUT - take an approved lesson back out of the bank so it can be changed.
 *
 * Its author, or a reviewer. The bank's whole value is that everything in it was
 * signed off by a named person, so coming back out is an action with a name on
 * it too.
 */
export async function PUT(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { lessonId, comment } = await req.json() as { lessonId?: string; comment?: string };
  if (!lessonId) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });

  const row = await readLesson(lessonId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (row.author_id !== user.id && !REVIEWER_ROLES.includes(user.role)) {
    return NextResponse.json({ error: 'not_yours' }, { status: 403 });
  }

  await db.from('lesson').update({
    status: 'returned', approved: false, approved_at: null,
  }).eq('id', lessonId);
  await audit(user.id, 'lesson.return', 'lesson', lessonId, { comment: comment ?? null });

  return NextResponse.json({ ok: true, status: 'returned' });
}
