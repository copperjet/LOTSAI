import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/studypack/pdf  { studyPackId }        — render the printable PDF, return a signed URL
 * GET  /api/studypack/pdf?studyPackId=<id>        — a signed URL for the stored PDF
 *
 * The printable companion to a study pack. It renders the same stored pack the
 * interactive HTML does, through a Standard whose renderer is 'studypack-pdf' — the
 * engine's renderer registry does the rest, and storeArtefact writes it to
 * study_pack/<id>.pdf alongside the .html. Rendering on demand (not at creation)
 * keeps generation cheap; most packs are used on screen and never printed.
 */
const BUCKET = 'artefacts';

/** The study-pack Standard, but pointed at the PDF renderer instead of the HTML one. */
async function pdfStandard() {
  const { standard } = await engine.resolveWorkflow('study_pack');
  return { ...standard, renderer_id: 'studypack-pdf' };
}

export async function GET(req: NextRequest) {
  const db = admin();
  await currentUser();
  const id = req.nextUrl.searchParams.get('studyPackId');
  if (!id) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });

  const std = await pdfStandard();
  const path = `${std.key}/${id}.pdf`;
  const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  return NextResponse.json({ path, url: signed?.signedUrl ?? null });
}

export async function POST(req: NextRequest) {
  const db = admin();
  await currentUser();
  const { studyPackId } = await req.json();
  if (!studyPackId) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });

  const std = await pdfStandard();
  const result = await storeArtefact(std, studyPackId);
  if (!result.ok) return NextResponse.json(result, { status: 500 });

  const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(result.path!, 60 * 60);
  return NextResponse.json({ ...result, url: signed?.signedUrl ?? null });
}
