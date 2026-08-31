import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact, readArtefact } from '@/lib/pdf/store';
import { uploadToDrive, driveMocked } from '@/lib/drive';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/studypack/approve  { studyPackId, decision? }
 *
 * A study pack is approved by the teacher who built it (not an HOD — a study pack
 * is a teaching aid, not a plan a head signs). Approval does two things: it enters
 * the pack into the shared bank (approved = true, so the next teacher is matched to
 * it before generating), and it delivers the printable PDF into the school's Google
 * Drive folder for that subject and year. Delivery is server-side via a service
 * account (lib/drive.ts) and is mocked cleanly until the credential is set.
 *
 * A reviewer may still return a pack; that path stays for the bank's sake.
 */
async function resolveFolder(db: ReturnType<typeof admin>, subjectId: string, yearGroup: string): Promise<string | null> {
  try {
    const { data } = await db.from('drive_folder').select('folder_id')
      .eq('artefact_type', 'study_pack').eq('academic_year', '2026-27')
      .eq('subject_id', subjectId).eq('year_group', yearGroup).maybeSingle();
    if (data?.folder_id) return data.folder_id;
  } catch { /* table not migrated yet — fall back */ }
  return process.env.DRIVE_DEFAULT_FOLDER_ID ?? null;
}

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { studyPackId, decision } = await req.json();

  const { data: pack } = await db.from('study_pack')
    .select('id, author_id, subject_id, year_group, title, status')
    .eq('id', studyPackId).maybeSingle();
  if (!pack) return NextResponse.json({ error: 'Unknown study pack' }, { status: 404 });

  // The author approves their own; a reviewer may act on any.
  const isReviewer = ['hod', 'coordinator', 'principal', 'admin'].includes(user.role);
  if (pack.author_id !== user.id && !isReviewer) {
    return NextResponse.json({ error: 'Only the pack’s author can approve it' }, { status: 403 });
  }

  if (decision === 'returned') {
    if (!isReviewer) return NextResponse.json({ error: 'Only a reviewer can return a pack' }, { status: 403 });
    await db.from('study_pack').update({ status: 'returned', approved: false }).eq('id', studyPackId);
    await audit(user.id, 'studypack.return', 'study_pack', studyPackId);
    return NextResponse.json({ ok: true, status: 'returned' });
  }

  // Render the printable PDF (same renderer /api/studypack/pdf uses) and store it.
  //
  // Storing is the point: this used to render its own copy, send it to Drive and
  // discard it, so the bucket kept whatever had been rendered at creation. Any
  // change to a renderer or to the inlined crest between creation and approval
  // left "Open the PDF" showing one document and Drive holding another. Going
  // through storeArtefact keeps pdf_jobs as the single record of what was drawn,
  // and reading the bytes back out is what makes the two copies provably equal.
  //
  // The pack's own storage_path is deliberately left alone: it names the
  // interactive HTML, which is the pack's primary rendering, and the PDF lives
  // beside it at the same id.
  const { standard } = await engine.resolveWorkflow('study_pack');
  const pdfStd = { ...standard, renderer_id: 'studypack-pdf' };

  const stored = await storeArtefact(pdfStd, studyPackId);
  if (!stored.ok || !stored.path) {
    return NextResponse.json({
      error: 'render_failed',
      message: 'The printable version could not be prepared, so nothing was sent to Drive. Everything is saved.',
    }, { status: 500 });
  }
  const bytes = await readArtefact(stored.path);
  if (!bytes) {
    return NextResponse.json({
      error: 'render_failed',
      message: 'The printable PDF was rendered but could not be read back, so nothing was sent to Drive.',
    }, { status: 500 });
  }

  // Resolve the Drive folder for this subject/year. In mock, a placeholder is fine;
  // live, a missing folder is a real configuration error the teacher should see.
  const folderId = await resolveFolder(db, pack.subject_id, pack.year_group);
  if (!folderId && !driveMocked()) {
    return NextResponse.json({
      error: 'no_folder',
      message: `No Drive folder is configured for ${pack.year_group} ${pack.subject_id}. Ask an administrator to map one before this pack can be sent to Drive.`,
    }, { status: 409 });
  }

  const safeName = (pack.title || 'Study Pack').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120);
  const drive = await uploadToDrive({
    folderId: folderId ?? 'mock-folder',
    filename: `${safeName} - ${pack.year_group} ${pack.subject_id}.pdf`,
    bytes, contentType: 'application/pdf',
  });
  if (!drive.ok) {
    console.error(`[drive] study pack ${studyPackId}: ${drive.error}`);
    return NextResponse.json({
      error: 'drive_failed',
      message: 'The pack is saved and approved, but it could not be copied to the school Drive yet.',
    }, { status: 502 });
  }

  // Core approval always applies. The drive_* columns are best-effort so approval
  // still works before migration 0009 is applied (DDL is manual — see README).
  await db.from('study_pack').update({
    status: 'approved', approved: true, approved_at: new Date().toISOString(),
  }).eq('id', studyPackId);
  await db.from('study_pack')
    .update({ drive_file_id: drive.fileId ?? null, drive_link: drive.link ?? null })
    .eq('id', studyPackId)
    .then(r => r, () => null);   // ignore if the columns do not exist yet
  await audit(user.id, 'studypack.approve', 'study_pack', studyPackId, { drive_file_id: drive.fileId, mock: drive.mock });

  return NextResponse.json({
    ok: true, status: 'approved',
    drive: { mock: drive.mock, link: drive.link, folderId: drive.folderId, fileId: drive.fileId },
  });
}
