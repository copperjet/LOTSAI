import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact, readArtefact } from '@/lib/pdf/store';
import { uploadToDrive, driveMocked } from '@/lib/drive';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/worksheet/approve  { worksheetId }
 *
 * The teacher who built the worksheet approves it (not an HOD — a worksheet is a
 * teaching aid, not a plan a head signs). Approval enters it into the shared bank
 * (approved = true) and delivers its printable PDF into the school's Google Drive
 * folder for that subject and year — the same path an approved study pack takes
 * (lib/drive.ts, service account, mocked until the credential is set).
 */
async function resolveFolder(db: ReturnType<typeof admin>, subjectId: string, yearGroup: string): Promise<string | null> {
  try {
    const { data } = await db.from('drive_folder').select('folder_id')
      .eq('artefact_type', 'worksheet').eq('academic_year', '2026-27')
      .eq('subject_id', subjectId).eq('year_group', yearGroup).maybeSingle();
    if (data?.folder_id) return data.folder_id;
  } catch { /* table not migrated yet — fall back */ }
  return process.env.DRIVE_DEFAULT_FOLDER_ID ?? null;
}

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { worksheetId } = await req.json();

  const { data: ws } = await db.from('worksheet')
    .select('id, author_id, subject_id, year_group, week_number, title, status')
    .eq('id', worksheetId).maybeSingle();
  if (!ws) return NextResponse.json({ error: 'Unknown worksheet' }, { status: 404 });

  const isReviewer = ['hod', 'coordinator', 'principal', 'admin'].includes(user.role);
  if (ws.author_id !== user.id && !isReviewer) {
    return NextResponse.json({ error: 'Only the worksheet’s author can approve it' }, { status: 403 });
  }

  // Render the printable PDF via the worksheet Standard's own renderer, and store
  // it. This used to render its own copy, send it to Drive and discard it, so the
  // bucket kept whatever had been rendered at creation and "Open the worksheet
  // PDF" could serve an older document than the one the school received. Going
  // through storeArtefact keeps pdf_jobs as the single record of what was drawn,
  // and reading the bytes back out is what makes the two copies provably equal.
  const { standard } = await engine.resolveWorkflow('worksheet');

  const stored = await storeArtefact(standard, worksheetId);
  if (!stored.ok || !stored.path) {
    return NextResponse.json({
      error: 'render_failed',
      message: `The worksheet PDF could not be rendered, so nothing was sent to Drive.${stored.error ? ` (${stored.error})` : ''}`,
    }, { status: 500 });
  }
  const bytes = await readArtefact(stored.path);
  if (!bytes) {
    return NextResponse.json({
      error: 'render_failed',
      message: 'The worksheet PDF was rendered but could not be read back, so nothing was sent to Drive.',
    }, { status: 500 });
  }

  const folderId = await resolveFolder(db, ws.subject_id, ws.year_group);
  if (!folderId && !driveMocked()) {
    return NextResponse.json({
      error: 'no_folder',
      message: `No Drive folder is configured for ${ws.year_group} ${ws.subject_id}. Ask an administrator to map one before this worksheet can be sent to Drive.`,
    }, { status: 409 });
  }

  const safeName = (ws.title || 'Worksheet').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120);
  const drive = await uploadToDrive({
    folderId: folderId ?? 'mock-folder',
    filename: `${safeName} - ${ws.year_group} ${ws.subject_id} wk${ws.week_number}.pdf`,
    bytes, contentType: 'application/pdf',
  });
  if (!drive.ok) {
    return NextResponse.json({ error: 'drive_failed', message: `The worksheet was not sent to Drive: ${drive.error}` }, { status: 502 });
  }

  await db.from('worksheet').update({
    status: 'approved', approved: true, approved_at: new Date().toISOString(),
    drive_file_id: drive.fileId ?? null, drive_link: drive.link ?? null,
  }).eq('id', worksheetId);
  await audit(user.id, 'worksheet.approve', 'worksheet', worksheetId, { drive_file_id: drive.fileId, mock: drive.mock });

  return NextResponse.json({
    ok: true, status: 'approved',
    drive: { mock: drive.mock, link: drive.link, folderId: drive.folderId, fileId: drive.fileId },
  });
}
