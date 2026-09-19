import { NextRequest, NextResponse } from 'next/server';
import { audit, currentUser } from '@/lib/supabase';
import { admin } from '@/lib/supabase';
import { bandById } from '@/lib/lesson/ages';
import { allowedFor, checkDeck } from '@/lib/lesson/gate';
import { mayEdit, readLesson, saveDeck, snapshot } from '@/lib/lesson/persist';
import { repairLessonSlides, typesForRepair } from '@/lib/lesson/generate';
import { storeArtefact } from '@/lib/pdf/store';
import * as engine from '@/lib/engine';
import type { LessonPhase } from '@/lib/lesson/schema';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** A whole-deck instruction touches every slide, so it goes in batches. */
const BATCH = 6;

/**
 * POST /api/lesson/revise
 *   { lessonId, instruction, phase? }     - a section, or the whole lesson
 *   { lessonId, instruction, slideIds[] } - named slides
 *
 * "Make the whole thing more practical." "Redo the independent practice."
 *
 * This is the middle of the three ways to change a lesson, and the three do
 * different jobs: /api/lesson/slide is a teacher typing (free, instant),
 * /api/lesson/improve is one slide and one named action (one call), and this is
 * an instruction in the teacher's own words applied across a section or the
 * deck. It reuses the repair pass, because "rewrite these slides to satisfy
 * this" is the same operation whether the instruction came from the quality
 * gate or from the teacher.
 *
 * It costs one call per six slides, so revising a whole twenty slide deck is
 * four calls - which is why the phase filter exists and the editor offers it.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  const body = await req.json() as {
    lessonId?: string; instruction?: string; phase?: string; slideIds?: string[];
  };

  const lessonId = body.lessonId;
  const instruction = String(body.instruction ?? '').trim();
  if (!lessonId || !instruction) {
    return NextResponse.json({
      error: 'empty',
      message: 'Say what you would like changed.',
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
  const allowed = allowedFor(deck);

  // Which slides the instruction is about.
  const wanted = body.slideIds?.length
    ? deck.slides.filter(s => body.slideIds!.includes(s.id))
    : body.phase
      ? deck.slides.filter(s => s.phase === (body.phase as LessonPhase))
      : deck.slides;

  if (!wanted.length) {
    return NextResponse.json({
      error: 'nothing_to_change',
      message: 'There are no slides in that part of the lesson.',
    }, { status: 404 });
  }

  await snapshot(lessonId, deck, instruction, user.id);

  let changed = 0;
  let calls = 0;
  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = wanted.slice(i, i + BATCH);
    try {
      const out = await repairLessonSlides(deck, batch.map(s => ({
        slideId: s.id,
        problem: `The teacher asked: "${instruction}". Rewrite this slide accordingly, keeping `
          + 'what it teaches and the objectives it addresses.',
        types: typesForRepair(s, allowed, false),
      })), user.id);
      changed += out.changed;
      if (out.usage) calls++;
    } catch (e) {
      console.error(`[lesson] revise batch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!changed) {
    return NextResponse.json({
      error: 'revise_failed',
      message: 'Nothing could be rewritten just now. The lesson is unchanged - try again in a moment.',
    }, { status: 502 });
  }

  const ok = await saveDeck(lessonId, deck);
  if (!ok) {
    return NextResponse.json({
      error: 'save_failed',
      message: 'The changes could not be saved. Try again in a moment.',
    }, { status: 502 });
  }

  // Re-render the stored HTML so "Open the lesson" is not the old one.
  try {
    const { standard: std } = await engine.resolveWorkflow('lesson');
    const render = await storeArtefact(std, lessonId);
    if (render.ok) await admin().from('lesson').update({ storage_path: render.path }).eq('id', lessonId);
  } catch {
    /* the deck is saved; the rendering is a copy of it and can be remade */
  }

  await audit(user.id, 'lesson.revise', 'lesson', lessonId, {
    instruction: instruction.slice(0, 200), slides: changed, calls,
  });

  return NextResponse.json({
    ok: true,
    changed,
    calls,
    deck,
    minutes: deck.slides.reduce((n, s) => n + s.minutes, 0),
    gate: checkDeck(deck, band),
  });
}

/**
 * PUT /api/lesson/revise   { lessonId, to }
 *
 * Put a revision back. Undo everywhere, confirm nowhere - the same rule the
 * planner's inline editing follows, and the reason every change here writes a
 * snapshot first.
 */
export async function PUT(req: NextRequest) {
  const user = await currentUser();
  const { lessonId, to } = await req.json() as { lessonId?: string; to?: number };
  if (!lessonId || !Number.isFinite(to)) {
    return NextResponse.json({ error: 'lessonId and to are required' }, { status: 400 });
  }

  const row = await readLesson(lessonId);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayEdit(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });

  const { data: rev } = await admin().from('lesson_revision')
    .select('content, n').eq('lesson_id', lessonId).eq('n', Math.round(Number(to))).maybeSingle();
  if (!rev?.content) return NextResponse.json({ error: 'no_such_revision' }, { status: 404 });

  // The version being replaced is kept too, so reverting is itself undoable.
  await snapshot(lessonId, row.content, `reverted to ${rev.n}`, user.id);

  const deck = rev.content as typeof row.content;
  const ok = await saveDeck(lessonId, deck);
  if (!ok) return NextResponse.json({ error: 'save_failed' }, { status: 502 });

  await audit(user.id, 'lesson.revert', 'lesson', lessonId, { to: rev.n });
  return NextResponse.json({
    ok: true, deck, gate: checkDeck(deck, bandById(deck.meta.ageBand)),
  });
}

/** The history, for the editor. */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('lessonId');
  if (!id) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });

  const row = await readLesson(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayEdit(row, user)) return NextResponse.json({ error: 'not_yours' }, { status: 403 });

  try {
    const { data } = await admin().from('lesson_revision')
      .select('n, instruction, created_at').eq('lesson_id', id).order('n');
    return NextResponse.json({ revisions: data ?? [] });
  } catch {
    return NextResponse.json({ revisions: [] });
  }
}
