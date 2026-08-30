import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET  /api/pdf/run?plannerId=<id>  — a signed URL for the stored planner PDF
 * POST /api/pdf/run  { plannerId }   — (re)render and store it
 *
 * Render is synchronous on approval; this route is the manual re-run for a job
 * that failed, and how the app fetches a finished artefact from the private
 * bucket. doc_type is the Standard's key, so it always matches what storeArtefact
 * wrote — never a second string that could drift.
 */
const BUCKET = 'artefacts';

export async function GET(req: NextRequest) {
  const db = admin();
  await currentUser();
  const plannerId = req.nextUrl.searchParams.get('plannerId');
  if (!plannerId) return NextResponse.json({ error: 'plannerId required' }, { status: 400 });

  const { standard } = await engine.resolveWorkflow('weekly_planner');
  const path = `${standard.key}/${plannerId}.pdf`;

  // The job row is the ledger; fall back to a direct path check so a render made
  // before pdf_jobs existed (migration 0007 pending) is still fetchable.
  const { data: job } = await db.from('pdf_jobs')
    .select('status, storage_path, last_error').eq('doc_type', standard.key).eq('doc_id', plannerId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  const storagePath = job?.storage_path ?? path;
  const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
  return NextResponse.json({
    status: job?.status ?? 'unknown', path: storagePath,
    url: signed?.signedUrl ?? null, error: job?.last_error ?? null,
  });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!['hod', 'coordinator', 'principal', 'admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Only a reviewer can re-render an artefact' }, { status: 403 });
  }
  const { plannerId } = await req.json();
  if (!plannerId) return NextResponse.json({ error: 'plannerId required' }, { status: 400 });

  const { standard } = await engine.resolveWorkflow('weekly_planner');
  const result = await storeArtefact(standard, plannerId);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
