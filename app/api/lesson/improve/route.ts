import { NextRequest, NextResponse } from 'next/server';
import { audit, currentUser } from '@/lib/supabase';
import { bandById } from '@/lib/lesson/ages';
import { checkDeck } from '@/lib/lesson/gate';
import { mayEdit, readLesson, saveDeck, snapshot } from '@/lib/lesson/persist';
import {
  IMPROVE_ACTIONS, IMPROVE_LABEL, improveSlide, type ImproveAction,
} from '@/lib/lesson/improve';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/lesson/improve
 *   { lessonId, slideId, action, instruction? }
 *
 * One slide, one instruction, one model call against a prefix the deck's
 * generation already warmed. The eight actions are in lib/lesson/improve.ts.
 *
 * The deck as it was is snapshotted first, so "that was worse" is a revert
 * rather than an apology.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  const body = await req.json() as {
    lessonId?: string; slideId?: string; action?: string; instruction?: string;
  };

  const { lessonId, slideId } = body;
  const action = String(body.action ?? '') as ImproveAction;
  if (!lessonId || !slideId) {
    return NextResponse.json({ error: 'lessonId and slideId are required' }, { status: 400 });
  }
  if (!IMPROVE_ACTIONS.includes(action)) {
    return NextResponse.json({
      error: 'unknown_action',
      message: `Choose one of: ${IMPROVE_ACTIONS.map(a => IMPROVE_LABEL[a]).join(', ')}.`,
    }, { status: 400 });
  }

  const row = await readLesson(lessonId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayEdit(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });
  if (row.approved) {
    return NextResponse.json({
      error: 'not_open',
      message: 'This lesson is approved and in the shared bank. Ask for it to be returned before '
        + 'changing it.',
    }, { status: 409 });
  }

  const deck = row.content;
  const band = bandById(deck.meta.ageBand);

  // Before, not after: the point of the snapshot is the version being replaced.
  await snapshot(lessonId, deck, `${IMPROVE_LABEL[action]} (${slideId})`, user.id);

  let result;
  try {
    result = await improveSlide({
      deck, slideId, action, instruction: body.instruction ?? null, userId: user.id, band,
    });
  } catch (e) {
    console.error(`[lesson] improve failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({
      error: 'improve_failed',
      message: 'That could not be rewritten just now. The slide is unchanged - try again in a moment.',
    }, { status: 502 });
  }

  if (!result) return NextResponse.json({ error: 'no_such_slide' }, { status: 404 });

  const ok = await saveDeck(lessonId, deck);
  if (!ok) {
    return NextResponse.json({
      error: 'save_failed',
      message: 'The new slide could not be saved. Try again in a moment.',
    }, { status: 502 });
  }

  await audit(user.id, 'lesson.improve', 'lesson', lessonId, { slide: slideId, action });

  return NextResponse.json({
    ok: true,
    slide: result.slide,
    note: result.note,
    minutes: deck.slides.reduce((n, s) => n + s.minutes, 0),
    gate: checkDeck(deck, band),
    usage: { cost: result.usage.cost, model: result.usage.model },
  });
}

/** The menu, so the editor never hardcodes it. */
export async function GET() {
  await currentUser();
  return NextResponse.json({
    actions: IMPROVE_ACTIONS.map(id => ({ id, label: IMPROVE_LABEL[id] })),
  });
}
