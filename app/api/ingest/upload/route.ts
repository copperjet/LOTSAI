import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { reconcile } from '@/lib/ingest/reconcile';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/ingest/upload   multipart: file, subjectId, yearGroup
 *
 * Extract a .pdf/.docx upload's text, then reconcile every objective code it
 * carries against the registry. Nothing here writes curriculum — it reports what
 * resolved and what did not, so a human decides. An unresolved code is never
 * accepted as truth (main spec §4); this is the foundation the Phase-2
 * "turn this into a study pack" path stands on.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();

  const form = await req.formData();
  const file = form.get('file');
  const subjectId = String(form.get('subjectId') ?? '');
  const yearGroup = String(form.get('yearGroup') ?? '');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file' }, { status: 400 });
  if (!subjectId || !yearGroup) {
    return NextResponse.json({ error: 'subjectId and yearGroup are required - an objective only resolves against a subject and year.' }, { status: 400 });
  }

  const name = file.name;
  const kind = name.toLowerCase().endsWith('.pdf') ? 'pdf'
    : /\.docx?$/i.test(name) ? 'docx' : null;
  if (!kind) return NextResponse.json({ error: 'Only .pdf and .docx are supported.' }, { status: 415 });

  const bytes = new Uint8Array(await file.arrayBuffer());

  let text: string;
  try {
    text = kind === 'pdf' ? await extractPdf(bytes) : await extractDocx(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Could not read the file: ${msg}` }, { status: 422 });
  }

  const result = await reconcile(text, subjectId, yearGroup);

  const { data: upload } = await db.from('source_upload').insert({
    uploader: user.id, filename: name, kind, subject_id: subjectId, year_group: yearGroup,
    extracted: { text_length: text.length, refs_found: result.refsFound },
    reconciled: { resolved: result.resolved.map(r => r.ref), unresolved: result.unresolved },
  }).select('id').single();

  await audit(user.id, 'ingest.upload', 'source_upload', upload?.id,
    { refs: result.refsFound.length, unresolved: result.unresolved.length });

  return NextResponse.json({
    uploadId: upload?.id ?? null,
    filename: name, kind, textLength: text.length,
    ...result,
    // Say plainly when something the file claims is not in the school's curriculum.
    note: result.unresolved.length
      ? `${result.unresolved.length} objective code(s) in this file are not in the ${yearGroup} ${subjectId} registry. They will not be used until a human confirms them.`
      : 'Every objective code in this file resolves against the registry.',
  });
}

/** PDF text via pdfjs (legacy build runs in Node; no worker needed for text). */
async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += (content.items as { str?: string }[]).map(it => it.str ?? '').join(' ') + '\n';
  }
  return text;
}

/** DOCX raw text via mammoth. */
async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}
