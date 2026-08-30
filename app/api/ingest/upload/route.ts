import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { reconcile } from '@/lib/ingest/reconcile';
import { extractTextFromImage, isImageType } from '@/lib/ingest/ocr';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/ingest/upload   multipart: file (one or more), subjectId, yearGroup
 *
 * Extract an upload's text - .pdf, .docx, or a photograph of the page - then
 * reconcile every objective code it carries against the registry. Nothing here
 * writes curriculum: it reports what resolved and what did not, so a human
 * decides. An unresolved code is never accepted as truth (main spec section 4);
 * this is the foundation the "turn this into a study pack" path stands on, and it
 * is exactly the same guard whether the codes were parsed from a PDF or read off
 * a photograph by a model.
 *
 * Several files are read as one document. A worksheet photographed over three
 * pages is one worksheet, so the text is concatenated and reconciled once,
 * yielding one study pack rather than three.
 */

/** Beyond this a photograph is a scan, and base64 of it is a request nobody wants. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

type Kind = 'pdf' | 'docx' | 'image';

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();

  const form = await req.formData();
  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  const subjectId = String(form.get('subjectId') ?? '');
  const yearGroup = String(form.get('yearGroup') ?? '');

  if (!files.length) return NextResponse.json({ error: 'No file' }, { status: 400 });
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Up to ${MAX_FILES} files at a time.` }, { status: 413 });
  }
  if (!subjectId || !yearGroup) {
    return NextResponse.json({ error: 'subjectId and yearGroup are required - an objective only resolves against a subject and year.' }, { status: 400 });
  }

  // Every file is classified before any of them is read, so an unsupported one
  // fails the request before a single model call has been paid for.
  const jobs: { file: File; kind: Kind }[] = [];
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) {
      return NextResponse.json({
        error: `${file.name}: only .pdf, .docx and photographs (PNG, JPEG, WebP) are supported.`,
      }, { status: 415 });
    }
    if (kind === 'image' && file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({
        error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Photographs must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB - take it again at a lower resolution.`,
      }, { status: 413 });
    }
    jobs.push({ file, kind });
  }

  const parts: { filename: string; kind: Kind; textLength: number }[] = [];
  const texts: string[] = [];
  for (const { file, kind } of jobs) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text: string;
    try {
      text = kind === 'pdf' ? await extractPdf(bytes)
        : kind === 'docx' ? await extractDocx(bytes)
        : (await extractTextFromImage(bytes, file.type, user.id)).text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Could not read ${file.name}: ${msg}` }, { status: 422 });
    }
    texts.push(text);
    parts.push({ filename: file.name, kind, textLength: text.length });
  }

  // One document, so one reconciliation: a code that appears on page three of a
  // photographed worksheet belongs to the same pack as one on page one.
  const text = texts.join('\n\n');
  const result = await reconcile(text, subjectId, yearGroup);

  // `kind` is the shape of the upload as a whole. Mixed sets are rare and the
  // per-file kinds are kept in `extracted` either way.
  const kinds = [...new Set(parts.map(p => p.kind))];
  const kind: string = kinds.length === 1 ? kinds[0] : 'mixed';
  const filename = parts.length === 1
    ? parts[0].filename
    : `${parts[0].filename} and ${parts.length - 1} more`;

  const { data: upload } = await db.from('source_upload').insert({
    uploader: user.id, filename, kind, subject_id: subjectId, year_group: yearGroup,
    extracted: { text_length: text.length, refs_found: result.refsFound, files: parts },
    reconciled: { resolved: result.resolved.map(r => r.ref), unresolved: result.unresolved },
  }).select('id').single();

  await audit(user.id, 'ingest.upload', 'source_upload', upload?.id,
    { files: parts.length, kind, refs: result.refsFound.length, unresolved: result.unresolved.length });

  return NextResponse.json({
    uploadId: upload?.id ?? null,
    filename, kind, files: parts, textLength: text.length,
    ...result,
    // Say plainly when something the file claims is not in the school's curriculum.
    note: noteFor(result.unresolved.length, result.refsFound.length, parts.length, yearGroup, subjectId),
  });
}

function kindOf(file: File): Kind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (/\.docx?$/.test(name)) return 'docx';
  if (isImageType(file.type)) return 'image';
  return null;
}

function noteFor(unresolved: number, found: number, fileCount: number, yearGroup: string, subjectId: string) {
  const from = fileCount === 1 ? 'this file' : `these ${fileCount} files`;
  if (!found) {
    return `No objective codes were found in ${from}. Nothing can be built from it until a code the ${yearGroup} ${subjectId} registry holds appears in it.`;
  }
  if (unresolved) {
    return `${unresolved} objective code(s) in ${from} are not in the ${yearGroup} ${subjectId} registry. They will not be used until a human confirms them.`;
  }
  return `Every objective code in ${from} resolves against the registry.`;
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
