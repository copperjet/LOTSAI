import { NextRequest, NextResponse } from 'next/server';
import { audit, currentUser } from '@/lib/supabase';
import { generateImage } from '@/lib/llm';
import { bandById } from '@/lib/lesson/ages';
import { checkDeck } from '@/lib/lesson/gate';
import { mayEdit, readLesson, saveDeck, snapshot } from '@/lib/lesson/persist';
import { repairDeck, settleLayout } from '@/lib/lesson/repair';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, listAssets, saveAsset } from '@/lib/lesson/assets';
import {
  STUDENT_BLOCKS, VISUAL_BLOCKS, type ImageBlock, type LessonDeck, type Slide,
} from '@/lib/lesson/schema';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST multipart: { lessonId, slideId, file, alt }             - a picture the teacher has
 * POST json:      { lessonId, slideId, draw, alt }             - a picture drawn for them
 * GET  ?lessonId=                                             - the pictures a lesson holds
 *
 * "Replace this visual." A picture enters a lesson only here, because a teacher
 * asked: generation never draws one (lib/lesson/generate.ts). A photograph of the
 * apparatus the class will actually use, or a screenshot of the program they
 * will actually open, is the one visual a diagram cannot replace - and the one
 * thing the model has no way to know.
 *
 * WHERE IT GOES on the slide: over the slide's existing visual if it has one
 * (that is what "replace" means); otherwise beside the text if the age band
 * allows two blocks; otherwise in place of the explanation, never in place of
 * what the class is asked to do. A slide that loses its question to a picture has
 * stopped being the class's turn.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  const isForm = (req.headers.get('content-type') ?? '').includes('multipart/form-data');

  let lessonId = '', slideId = '', alt = '', draw = '';
  let file: File | null = null;
  if (isForm) {
    const form = await req.formData();
    lessonId = String(form.get('lessonId') ?? '');
    slideId = String(form.get('slideId') ?? '');
    alt = String(form.get('alt') ?? '').trim();
    const f = form.get('file');
    file = f instanceof File ? f : null;
  } else {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    lessonId = String(body.lessonId ?? '');
    slideId = String(body.slideId ?? '');
    alt = String(body.alt ?? '').trim();
    draw = String(body.draw ?? '').trim();
  }

  if (!lessonId || !slideId) {
    return NextResponse.json({ error: 'lessonId and slideId are required' }, { status: 400 });
  }
  if (!file && !draw) {
    return NextResponse.json({ error: 'empty', message: 'Attach a picture, or say what to draw.' },
      { status: 400 });
  }

  const row = await readLesson(lessonId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayEdit(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });
  if (row.approved) {
    return NextResponse.json({
      error: 'not_open',
      message: 'This lesson is approved and in the shared bank. Ask for it to be returned before changing it.',
    }, { status: 409 });
  }

  const deck = row.content;
  const slide = deck.slides.find(s => s.id === slideId);
  if (!slide) return NextResponse.json({ error: 'no_such_slide' }, { status: 404 });

  // Refused before any bytes are drawn or stored: a picture the slide has no room
  // for is a paid drawing and an orphaned file.
  const band = bandById(deck.meta.ageBand);
  if (!placeImage(JSON.parse(JSON.stringify(slide)) as Slide, {
    type: 'image', asset_id: 'probe', alt: 'probe', caption: null,
  }, band.maxBlocksPerSlide)) {
    return NextResponse.json({
      error: 'no_room',
      message: 'This slide is the class’s turn and has no room for a picture without losing '
        + 'what they are asked to do. Add a slide before it and put the picture there.',
    }, { status: 409 });
  }

  // ---- the bytes
  let bytes: Uint8Array;
  let contentType: string;
  let kind: 'upload' | 'generated';
  if (file) {
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
      return NextResponse.json({
        error: 'field', message: 'That is not a picture. Use a PNG, JPEG or WebP.',
      }, { status: 415 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({
        error: 'field', message: 'That picture is too large. Anything under 12 MB will do.',
      }, { status: 413 });
    }
    bytes = new Uint8Array(await file.arrayBuffer());
    contentType = file.type;
    kind = 'upload';
  } else {
    try {
      // The teacher's own words, framed so the model draws teaching material and
      // not decoration, and never writes text into the picture - text in a
      // generated image is where the spelling mistakes live.
      const img = await generateImage({
        workflow: 'lesson_illustration',
        userId: user.id,
        size: '1536x1024',
        prompt: `A clear, simple illustration for a school lesson slide, for ${deck.meta.yearGroup} `
          + `${deck.meta.subjectName} learners, on a plain light background. Show: ${draw}. `
          + 'Accurate, uncluttered, no text or labels in the image.',
      });
      bytes = img.bytes;
      contentType = img.contentType;
      kind = 'generated';
    } catch (e) {
      console.error(`[lesson-asset] draw failed: ${e instanceof Error ? e.message : String(e)}`);
      return NextResponse.json({
        error: 'draw_failed',
        message: 'The picture could not be drawn just now. The slide is unchanged.',
      }, { status: 502 });
    }
  }

  const asset = await saveAsset({
    lessonId, bytes, contentType, kind,
    alt: alt || draw || 'Picture',
    prompt: draw || null,
  });
  if (!asset) {
    return NextResponse.json({
      error: 'save_failed', message: 'The picture could not be saved. Try again in a moment.',
    }, { status: 502 });
  }

  // ---- onto the slide
  await snapshot(lessonId, deck, `picture on ${slideId}`, user.id);
  placeImage(slide, {
    type: 'image', asset_id: asset.id, alt: alt || draw || 'Picture', caption: null,
  }, band.maxBlocksPerSlide);
  repairDeck(deck, band);
  const fixed = deck.slides.find(s => s.id === slideId);
  if (fixed) fixed.layout = settleLayout(fixed);

  if (!(await saveDeck(lessonId, deck))) {
    return NextResponse.json({ error: 'save_failed' }, { status: 502 });
  }
  await audit(user.id, 'lesson.picture', 'lesson', lessonId, { slide: slideId, kind });

  return NextResponse.json({
    ok: true,
    assetId: asset.id,
    // The editor draws the canvas from data URIs, so it gets the new one back
    // rather than re-reading every picture in the deck.
    dataUri: `data:${contentType === 'image/png' ? 'image/png' : 'image/jpeg'};base64,`
      + Buffer.from(bytes).toString('base64'),
    slide: fixed,
    gate: checkDeck(deck as LessonDeck, band),
  });
}

/**
 * Replace the visual; else sit beside the text; else take the explanation's place.
 * False when the slide has no room and everything on it is the class's turn -
 * a picture never costs a slide its question.
 */
function placeImage(slide: Slide, img: ImageBlock, maxBlocks: number): boolean {
  const visual = slide.blocks.findIndex(b => VISUAL_BLOCKS.includes(b.type));
  if (visual >= 0) { slide.blocks[visual] = img; return true; }
  if (slide.blocks.length < maxBlocks) { slide.blocks.unshift(img); return true; }
  const explaining = slide.blocks.findIndex(b => !STUDENT_BLOCKS.includes(b.type));
  if (explaining >= 0) { slide.blocks[explaining] = img; return true; }
  return false;
}

export async function GET(req: NextRequest) {
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('lessonId');
  if (!id) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });
  const row = await readLesson(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayEdit(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });
  return NextResponse.json({ assets: await listAssets(id) });
}
