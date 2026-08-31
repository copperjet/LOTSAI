import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { reconcile } from '@/lib/ingest/reconcile';
import { cleanText, sourceNote, MAX_STORED_TEXT } from '@/lib/ingest/source';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/ingest/text   { text, subjectId, yearGroup, title? }
 *
 * The same door as /api/ingest/upload, for material that was never a file: notes typed
 * or pasted straight in, a lesson's outline copied out of an email, a topic list a
 * teacher writes on the spot. It is stored as a source_upload like any other, so
 * /api/studypack/from-upload turns it into a pack by exactly the same path - there is
 * no second, weaker route into the pack builder.
 *
 * Objective codes are reconciled against the registry here too. Text a teacher typed
 * carries no more authority than a PDF they scanned: an unresolved code is reported,
 * never accepted (main spec section 4).
 */

/** Below this there is not enough to build a pack from, and saying so beats trying. */
const MIN_TEXT = 120;

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();

  const body = await req.json().catch(() => null) as
    { text?: unknown; subjectId?: unknown; yearGroup?: unknown; title?: unknown } | null;

  const text = cleanText(String(body?.text ?? '')).trim();
  const subjectId = String(body?.subjectId ?? '');
  const yearGroup = String(body?.yearGroup ?? '');
  const title = String(body?.title ?? '').trim();

  if (!subjectId || !yearGroup) {
    return NextResponse.json({ error: 'subjectId and yearGroup are required - an objective only resolves against a subject and year.' }, { status: 400 });
  }
  if (text.length < MIN_TEXT) {
    return NextResponse.json({
      error: `That is ${text.length} characters. Send at least ${MIN_TEXT} - the topics to cover, or the outcomes the lesson is for.`,
    }, { status: 400 });
  }

  const result = await reconcile(text, subjectId, yearGroup);

  // `filename` is what the pack's footer and the upload list will show, so it is the
  // teacher's own title when they gave one rather than a generated id.
  const filename = title || 'Pasted text';

  const { data: upload, error: insertError } = await db.from('source_upload').insert({
    uploader: user.id, filename, kind: 'text', subject_id: subjectId, year_group: yearGroup,
    extracted: {
      text_length: text.length, refs_found: result.refsFound,
      files: [{ filename, kind: 'text', textLength: text.length }],
      text: text.slice(0, MAX_STORED_TEXT),
    },
    reconciled: { resolved: result.resolved.map(r => r.ref), unresolved: result.unresolved },
  }).select('id').single();

  if (insertError || !upload) {
    console.error(`[text] could not store ${filename}: ${insertError?.message ?? 'no row returned'}`);
    return NextResponse.json({
      error: 'text_not_stored',
      message: 'The text was read, but it could not be saved. Send it again.',
    }, { status: 500 });
  }

  await audit(user.id, 'ingest.text', 'source_upload', upload.id,
    { chars: text.length, refs: result.refsFound.length, unresolved: result.unresolved.length });

  return NextResponse.json({
    uploadId: upload.id,
    filename, kind: 'text', textLength: text.length,
    ...result,
    note: sourceNote({
      from: 'this text', refsFound: result.refsFound.length,
      unresolved: result.unresolved.length, subjectId, yearGroup,
    }),
  });
}
