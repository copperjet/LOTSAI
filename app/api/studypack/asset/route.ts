import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { generateImage } from '@/lib/llm';
import {
  IMAGE_TYPES, MAX_UPLOAD_BYTES, listAssets, saveAsset,
} from '@/lib/studypack/assets';
import { extractFile, kindOf } from '@/lib/ingest/extract';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * The pictures and the material a teacher hands to a pack they are looking at.
 *
 * POST multipart: file (one or more), studyPackId
 *   A picture becomes an asset the pack can place ("include this on page 8"); a .pdf
 *   or a .docx becomes text handed straight back, for the revise call to work from.
 *   Both in one request, because a teacher attaching three things does not sort them.
 *
 * POST json: { studyPackId, draw, alt }
 *   Draw one. Deliberately a separate, explicit request rather than something a
 *   revision does on its own: it costs money per picture, and a generated
 *   illustration is the wrong answer more often than a diagram is - most requests to
 *   "make this clearer" are better served by a `diagram` block, which the revise pass
 *   composes for free (lib/studypack/schema.ts).
 *
 * GET ?studyPackId=<id>  - what this pack already holds.
 */

const MAX_FILES = 5;

/** What a picture is allowed to be of. Not a content filter - a scope one. A study
 *  pack is a document for children, and this is the sentence that says so. */
const DRAW_SYSTEM =
  'A clear, friendly educational illustration for a primary school study pack. '
  + 'Simple shapes, plain background, no text or lettering of any kind, nothing frightening. ';

/** Anyone who may change the pack may add to it. Same rule as the revise route. */
async function mayEdit(studyPackId: string, userId: string, role: string) {
  const { data: pack } = await admin().from('study_pack')
    .select('id, author_id, approved').eq('id', studyPackId).maybeSingle();
  if (!pack) return { error: 'Unknown study pack', status: 404 as const };

  const isReviewer = ['hod', 'coordinator', 'principal', 'admin'].includes(role);
  if (pack.author_id !== userId && !isReviewer) {
    return { error: 'Only the pack’s author can change it', status: 403 as const };
  }
  if (pack.approved) {
    return {
      error: 'approved', status: 400 as const,
      message: 'This pack has been approved and sent to the school Drive, so nothing more '
        + 'can be added to it.',
    };
  }
  return { pack };
}

export async function GET(req: NextRequest) {
  await currentUser();
  const id = req.nextUrl.searchParams.get('studyPackId');
  if (!id) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });
  return NextResponse.json({ assets: await listAssets(id) });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  const type = req.headers.get('content-type') ?? '';

  return type.includes('multipart/form-data')
    ? attach(req, user)
    : draw(req, user);
}

/** Files the teacher attached: pictures stored, documents read. */
async function attach(req: NextRequest, user: { id: string; role: string }) {
  const form = await req.formData();
  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  const studyPackId = String(form.get('studyPackId') ?? '');

  if (!studyPackId) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });
  if (!files.length) return NextResponse.json({ error: 'No file' }, { status: 400 });
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Up to ${MAX_FILES} files at a time.` }, { status: 413 });
  }

  const allowed = await mayEdit(studyPackId, user.id, user.role);
  if ('error' in allowed) {
    return NextResponse.json({ error: allowed.error, message: allowed.message }, { status: allowed.status });
  }

  const added: unknown[] = [];
  const text: string[] = [];
  const refused: string[] = [];

  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    if ((IMAGE_TYPES as readonly string[]).includes(file.type)) {
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        refused.push(`${file.name} is too large to put in a pack.`);
        continue;
      }
      try {
        // The file name stands in until the teacher says what it shows. It is a poor
        // description and a poor description is still better than none: the block
        // refuses to render without one, and a picture with no description is a
        // picture nobody reading the pack aloud can use.
        added.push(await saveAsset({
          studyPackId, bytes, contentType: file.type,
          alt: file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'A picture the teacher added',
          kind: 'upload', authorId: user.id,
        }));
      } catch (e) {
        refused.push(`${file.name}: ${e instanceof Error ? e.message : 'could not be added'}`);
      }
      continue;
    }

    // Not a picture: read it, and hand the text back for the revision to work from.
    // The same extraction the composer's paperclip already uses.
    const kind = kindOf(file);
    if (!kind) {
      refused.push(`${file.name} is not something I can read.`);
      continue;
    }
    try {
      const out = (await extractFile(file, kind, user.id)).trim();
      if (out) text.push(`--- ${file.name}\n${out}`);
      else refused.push(`${file.name} had no text in it I could read.`);
    } catch {
      refused.push(`${file.name} could not be read.`);
    }
  }

  if (added.length) await audit(user.id, 'studypack.asset.add', 'study_pack', studyPackId);

  return NextResponse.json({ ok: true, assets: added, material: text.join('\n\n'), refused });
}

/** A picture drawn on request. */
async function draw(req: NextRequest, user: { id: string; role: string }) {
  const body = await req.json();
  const studyPackId = String(body?.studyPackId ?? '');
  const what = String(body?.draw ?? '').trim();
  if (!studyPackId || !what) {
    return NextResponse.json({ error: 'studyPackId and draw are required' }, { status: 400 });
  }

  const allowed = await mayEdit(studyPackId, user.id, user.role);
  if ('error' in allowed) {
    return NextResponse.json({ error: allowed.error, message: allowed.message }, { status: allowed.status });
  }

  try {
    const img = await generateImage({
      prompt: `${DRAW_SYSTEM}${what}`,
      workflow: 'studypack_illustration',
      userId: user.id,
    });
    const asset = await saveAsset({
      studyPackId, bytes: img.bytes, contentType: img.contentType,
      // The teacher's own words are the description. They asked for a picture of
      // something, and that is what the picture is of.
      alt: String(body?.alt ?? '').trim() || what.slice(0, 160),
      kind: 'generated', prompt: what, authorId: user.id,
    });
    await audit(user.id, 'studypack.asset.draw', 'study_pack', studyPackId);
    return NextResponse.json({ ok: true, asset });
  } catch (e) {
    console.error(`[studypack-asset] draw failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({
      error: 'draw_failed',
      message: 'I could not draw that just now. Nothing has been added to the pack.',
    }, { status: 502 });
  }
}
