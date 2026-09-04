import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { reconcile } from '@/lib/ingest/reconcile';
import { kindOf, extractFile, MAX_IMAGE_BYTES, type Kind } from '@/lib/ingest/extract';
import { cleanText, sourceNote, MAX_STORED_TEXT } from '@/lib/ingest/source';

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

const MAX_FILES = 5;

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
        error: `${file.name} is not a kind of file I can read. Send a PDF, a Word document, or a photograph.`,
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
    let text: string;
    try {
      text = await extractFile(file, kind, user.id);
    } catch (e) {
      console.error(`[upload] ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      return NextResponse.json({
        error: `${file.name} could not be read. If it is a photograph, take it again in better light.`,
      }, { status: 422 });
    }
    texts.push(text);
    parts.push({ filename: file.name, kind, textLength: text.length });
  }

  // One document, so one reconciliation: a code that appears on page three of a
  // photographed worksheet belongs to the same pack as one on page one.
  const text = cleanText(texts.join('\n\n'));
  const result = await reconcile(text, subjectId, yearGroup);

  // `kind` is the shape of the upload as a whole. Mixed sets are rare and the
  // per-file kinds are kept in `extracted` either way.
  const kinds = [...new Set(parts.map(p => p.kind))];
  const kind: string = kinds.length === 1 ? kinds[0] : 'mixed';
  const filename = parts.length === 1
    ? parts[0].filename
    : `${parts[0].filename} and ${parts.length - 1} more`;

  const { data: upload, error: insertError } = await db.from('source_upload').insert({
    uploader: user.id, filename, kind, subject_id: subjectId, year_group: yearGroup,
    // The text itself is kept, not just its length. A study pack built from an
    // upload is written from the teacher's own material; before this it was
    // rebuilt from registry objectives alone and the file's content was thrown
    // away. Capped so a scanned book cannot fill a jsonb column.
    extracted: { text_length: text.length, refs_found: result.refsFound, files: parts, text: text.slice(0, MAX_STORED_TEXT) },
    reconciled: { resolved: result.resolved.map(r => r.ref), unresolved: result.unresolved },
  }).select('id').single();

  // This used to be discarded, so a failed insert answered 200 with uploadId: null -
  // which reads as success, and then "turn this into a study pack" failed with nothing
  // to explain it.
  if (insertError || !upload) {
    console.error(`[upload] could not store ${filename}: ${insertError?.message ?? 'no row returned'}`);
    return NextResponse.json({
      error: 'upload_not_stored',
      message: `${filename} was read, but it could not be saved. Send it again.`,
    }, { status: 500 });
  }

  await audit(user.id, 'ingest.upload', 'source_upload', upload?.id,
    { files: parts.length, kind, refs: result.refsFound.length, unresolved: result.unresolved.length });

  return NextResponse.json({
    uploadId: upload?.id ?? null,
    filename, kind, files: parts, textLength: text.length,
    ...result,
    // Say plainly when something the file claims is not in the school's curriculum.
    note: sourceNote({
      from: parts.length === 1 ? 'this file' : `these ${parts.length} files`,
      refsFound: result.refsFound.length, unresolved: result.unresolved.length,
      subjectId, yearGroup,
    }),
  });
}
