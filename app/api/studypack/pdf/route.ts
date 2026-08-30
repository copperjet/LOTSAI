import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';
import { viewUrl } from '@/lib/artefactUrl';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/studypack/pdf  { studyPackId }        — render the printable PDF, return its URL
 * GET  /api/studypack/pdf?studyPackId=<id>        — the URL of the stored PDF
 *
 * The printable companion to a study pack. It renders the same stored pack the
 * interactive HTML does, through a Standard whose renderer is 'studypack-pdf' — the
 * engine's renderer registry does the rest, and storeArtefact writes it to
 * study_pack/<id>.pdf alongside the .html. Rendering on demand (not at creation)
 * keeps generation cheap; most packs are used on screen and never printed.
 */
/** The study-pack Standard, but pointed at the PDF renderer instead of the HTML one. */
async function pdfStandard() {
  const { standard } = await engine.resolveWorkflow('study_pack');
  return { ...standard, renderer_id: 'studypack-pdf' };
}

export async function GET(req: NextRequest) {
  await currentUser();
  const id = req.nextUrl.searchParams.get('studyPackId');
  if (!id) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });

  const std = await pdfStandard();
  const path = `${std.key}/${id}.pdf`;
  return NextResponse.json({ path, url: viewUrl('studypack-pdf', id) });
}

export async function POST(req: NextRequest) {
  await currentUser();
  const { studyPackId } = await req.json();
  if (!studyPackId) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });

  const std = await pdfStandard();
  const result = await storeArtefact(std, studyPackId);
  if (!result.ok) return NextResponse.json(result, { status: 500 });

  return NextResponse.json({ ...result, url: viewUrl('studypack-pdf', studyPackId) });
}
