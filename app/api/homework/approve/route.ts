import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact, readArtefact } from '@/lib/pdf/store';
import { uploadToDrive, driveMocked } from '@/lib/drive';

export const runtime = 'nodejs';
export const maxDuration = 300;   // a browser cold start plus the print

/**
 * POST /api/homework/approve  { homeworkId }
 *
 * The teacher who set the homework approves it - not an HOD; homework is a teaching
 * aid, not a plan a head signs, the same rule the worksheet follows. Approval enters
 * it into the shared bank (approved = true) and delivers its printable PDF into the
 * school's Google Drive folder for that subject and year.
 *
 * The PDF is rendered here through the homework Standard pointed at its PDF renderer,
 * and read back out of the bucket before it is uploaded, so the bytes in Drive and the
 * bytes behind "Open it" are provably the same object.
 */
async function resolveFolder(
  db: ReturnType<typeof admin>, subjectId: string, yearGroup: string,
): Promise<string | null> {
  try {
    const { data } = await db.from('drive_folder').select('folder_id')
      .eq('artefact_type', 'homework').eq('academic_year', '2026-27')
      .eq('subject_id', subjectId).eq('year_group', yearGroup).maybeSingle();
    if (data?.folder_id) return data.folder_id;
  } catch { /* table not migrated yet - fall back */ }
  return process.env.DRIVE_DEFAULT_FOLDER_ID ?? null;
}

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { homeworkId } = await req.json();

  const { data: hw } = await db.from('homework')
    .select('id, author_id, subject_id, year_group, week_number, title, status')
    .eq('id', homeworkId).maybeSingle();
  if (!hw) return NextResponse.json({ error: 'Unknown homework' }, { status: 404 });

  const isReviewer = ['hod', 'coordinator', 'principal', 'admin'].includes(user.role);
  if (hw.author_id !== user.id && !isReviewer) {
    return NextResponse.json({ error: 'Only the teacher who set it can approve it' }, { status: 403 });
  }

  const { standard } = await engine.resolveWorkflow('homework');
  const pdfStd = { ...standard, renderer_id: 'homework-pdf' };

  const stored = await storeArtefact(pdfStd, homeworkId);
  if (!stored.ok || !stored.path) {
    return NextResponse.json({
      error: 'render_failed',
      message: 'The homework could not be prepared, so nothing was sent to Drive. Everything is saved.',
    }, { status: 500 });
  }
  const bytes = await readArtefact(stored.path);
  if (!bytes) {
    return NextResponse.json({
      error: 'render_failed',
      message: 'The homework PDF was rendered but could not be read back, so nothing was sent to Drive.',
    }, { status: 500 });
  }

  const folderId = await resolveFolder(db, hw.subject_id, hw.year_group);
  if (!folderId && !driveMocked()) {
    return NextResponse.json({
      error: 'no_folder',
      message: `No Drive folder is configured for ${hw.year_group} ${hw.subject_id}. Ask an administrator to map one before this homework can be sent to Drive.`,
    }, { status: 409 });
  }

  const safeName = (hw.title || 'Homework').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120);
  const drive = await uploadToDrive({
    folderId: folderId ?? 'mock-folder',
    filename: `${safeName} - ${hw.year_group} ${hw.subject_id} wk${hw.week_number}.pdf`,
    bytes, contentType: 'application/pdf',
  });
  if (!drive.ok) {
    console.error(`[drive] homework ${homeworkId}: ${drive.error}`);
    return NextResponse.json({
      error: 'drive_failed',
      message: 'The homework is saved and approved, but it could not be copied to the school Drive yet.',
    }, { status: 502 });
  }

  await db.from('homework').update({
    status: 'approved', approved: true, approved_at: new Date().toISOString(),
    drive_file_id: drive.fileId ?? null, drive_link: drive.link ?? null,
  }).eq('id', homeworkId);
  await audit(user.id, 'homework.approve', 'homework', homeworkId,
    { drive_file_id: drive.fileId, mock: drive.mock });

  return NextResponse.json({
    ok: true, status: 'approved',
    drive: { mock: drive.mock, link: drive.link, folderId: drive.folderId, fileId: drive.fileId },
  });
}
