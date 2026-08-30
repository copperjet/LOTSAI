/**
 * Render an artefact and store it, keeping the pdf_jobs row as the ledger.
 *
 * Render is synchronous here — a planner PDF is small and pdf-lib runs in-process,
 * so there is no worker to wait for (see the migration comment). The job row is
 * still written: it records success/failure with the storage path, and
 * /api/pdf/run reprocesses a failed or queued one. The shape (status, attempts,
 * last_error) mirrors eScholr's queue so the async worker can be added later
 * without changing callers.
 *
 * It never throws. Approval must not fail because a render did — the artefact is
 * already in the bank; the PDF is a rendering of it and can be regenerated.
 */
import { admin } from '@/lib/supabase';
import { render, type Standard } from '@/lib/engine';

const BUCKET = 'artefacts';

export interface StoreResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Output format per renderer: a planner is a PDF, a study pack is HTML. */
const FORMAT: Record<string, { ext: string; contentType: string }> = {
  planner: { ext: 'pdf', contentType: 'application/pdf' },
  studypack: { ext: 'html', contentType: 'text/html; charset=utf-8' },
  'studypack-pdf': { ext: 'pdf', contentType: 'application/pdf' },
  worksheet: { ext: 'pdf', contentType: 'application/pdf' },
};

export async function storeArtefact(std: Standard, docId: string): Promise<StoreResult> {
  const db = admin();
  const docType = std.key;
  const fmt = FORMAT[std.renderer_id ?? ''] ?? FORMAT.planner;

  // Claim (or reopen) the one active job for this document.
  const jobId = await claimJob(db, docType, docId);

  try {
    const bytes = await render(std, docId);
    if (!bytes) {
      await settle(db, jobId, 'failed', null, 'standard has no renderer');
      return { ok: false, error: 'no renderer' };
    }

    const path = `${docType}/${docId}.${fmt.ext}`;
    const up = await db.storage.from(BUCKET).upload(path, bytes, {
      contentType: fmt.contentType, upsert: true, cacheControl: '3600',
    });
    if (up.error) {
      await settle(db, jobId, 'failed', null, `upload: ${up.error.message}`);
      return { ok: false, error: up.error.message };
    }

    await settle(db, jobId, 'success', path, null);
    return { ok: true, path };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await settle(db, jobId, 'failed', null, msg);
    return { ok: false, error: msg };
  }
}

/** Insert a running job, or reopen the existing active one (partial unique index). */
async function claimJob(db: ReturnType<typeof admin>, docType: string, docId: string): Promise<string | null> {
  const started = new Date().toISOString();
  const ins = await db.from('pdf_jobs')
    .insert({ doc_type: docType, doc_id: docId, status: 'running', attempts: 1, started_at: started })
    .select('id').single();
  if (!ins.error) return ins.data.id;

  // An active row already exists — reuse it.
  const { data } = await db.from('pdf_jobs')
    .select('id, attempts').eq('doc_type', docType).eq('doc_id', docId)
    .in('status', ['queued', 'running']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  await db.from('pdf_jobs').update({ status: 'running', started_at: started, attempts: (data.attempts ?? 0) + 1 })
    .eq('id', data.id);
  return data.id;
}

async function settle(db: ReturnType<typeof admin>, jobId: string | null, status: 'success' | 'failed', path: string | null, error: string | null) {
  if (!jobId) return;
  await db.from('pdf_jobs').update({
    status, storage_path: path, last_error: error, finished_at: new Date().toISOString(),
  }).eq('id', jobId);
}
