import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { FORMAT } from '@/lib/pdf/store';

export const runtime = 'nodejs';

/**
 * GET /api/document/view?kind=<kind>&id=<uuid>
 *
 * Serve a stored artefact's bytes from our own domain.
 *
 * Supabase Storage deliberately serves stored .html as text/plain — user HTML
 * must not execute on their domain — which overrode the text/html we upload with
 * and made "Open the study pack" print its own source. text/plain also carries no
 * charset, so the browser guessed latin-1 and the title read `Weeks 10â€"12`. One
 * cause, both symptoms. Nothing is wrong with the generated HTML; it just cannot
 * be served from a signed storage URL.
 *
 * One route for every artefact rather than three, because the only thing that
 * differs is a storage prefix and a content type. Signed URLs stay for anything
 * that genuinely should download.
 */
const BUCKET = 'artefacts';

/**
 * Each kind names the workflow whose Standard owns the storage prefix, and the
 * renderer whose FORMAT entry gives the extension and content type. The prefix is
 * the *Standard key* (weekly_planner/…), which is not the renderer id (planner) —
 * resolving it through the engine is what stops the two drifting apart.
 */
const KIND: Record<string, { workflow: string; renderer: string; table: string | null }> = {
  'studypack-html': { workflow: 'study_pack',     renderer: 'studypack',     table: 'study_pack' },
  'studypack-pdf':  { workflow: 'study_pack',     renderer: 'studypack-pdf', table: null },
  worksheet:        { workflow: 'worksheet',      renderer: 'worksheet',     table: 'worksheet' },
  planner:          { workflow: 'weekly_planner', renderer: 'planner',       table: null },
};

export async function GET(req: NextRequest) {
  const db = admin();
  const user = await currentUser();

  const kind = req.nextUrl.searchParams.get('kind') ?? '';
  const id = req.nextUrl.searchParams.get('id') ?? '';
  const spec = KIND[kind];
  if (!spec || !id) {
    return NextResponse.json({ error: 'kind and id are required' }, { status: 400 });
  }

  // A planner is one teacher's own work until their HOD has it, so it follows the
  // same rule /api/plan/open does. Packs and worksheets are bank artefacts —
  // anyone past the gate may open one, which is the point of a shared bank.
  if (kind === 'planner') {
    const { data: planner } = await db.from('planner')
      .select('teacher_id').eq('id', id).maybeSingle();
    if (!planner) return NextResponse.json({ error: 'Unknown planner' }, { status: 404 });
    if (planner.teacher_id !== user.id && user.role !== 'hod') {
      return NextResponse.json({ error: 'Not yours to open' }, { status: 403 });
    }
  }

  const { standard } = await engine.resolveWorkflow(spec.workflow);
  const fmt = FORMAT[spec.renderer];

  // The row's own storage_path is what storeArtefact recorded; the derived path is
  // the fallback for a render made before that column was written.
  let path = `${standard.key}/${id}.${fmt.ext}`;
  if (spec.table) {
    const { data: row } = await db.from(spec.table)
      .select('storage_path').eq('id', id).maybeSingle();
    if (row?.storage_path) path = row.storage_path as string;
  }

  const { data: blob, error } = await db.storage.from(BUCKET).download(path);
  if (error || !blob) return notRendered();

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type': fmt.contentType,
      'Content-Disposition': `inline; filename="${id}.${fmt.ext}"`,
      // Private: the bytes are one school's work, and the gate cookie is what
      // authorised this response. A shared cache must never hand it to anyone else.
      'Cache-Control': 'private, max-age=300',
    },
  });
}

/**
 * A missing object means the render has not finished (or failed and is waiting for
 * a re-run). This opens in a tab the teacher just clicked into, so it answers in a
 * sentence rather than with a JSON body they would have to read as source.
 */
function notRendered() {
  return new NextResponse(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<title>Not ready yet</title>'
    + '<style>body{font:16px/1.6 system-ui,sans-serif;color:#26302A;margin:15vh auto;max-width:34rem;padding:0 1.5rem}</style>'
    + '</head><body><h1>Not ready yet</h1>'
    + '<p>This is saved, but it is not quite ready to open. Close this tab and try again in a moment.</p>'
    + '</body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
