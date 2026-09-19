import { NextRequest, NextResponse } from 'next/server';
import { audit, currentUser } from '@/lib/supabase';
import { bandById } from '@/lib/lesson/ages';
import { checkDeck } from '@/lib/lesson/gate';
import { mayEdit, readLesson, saveDeck, snapshotIfStale } from '@/lib/lesson/persist';
import { repairDeck, settleLayout, settleTeacher } from '@/lib/lesson/repair';
import {
  ARRANGEMENTS, type Arrangement, type Audience, type SlideBlock, type TeacherNote,
} from '@/lib/lesson/schema';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * PATCH /api/lesson/slide
 *   { lessonId, slideId, patch: { title?, purpose?, minutes?, audience?, blocks?, teacher? } }
 *
 * One teacher's edit to one slide. No model call, and deliberately so: a teacher
 * retyping a title should not cost anything or wait for anything.
 *
 * The whole deck is repaired afterwards rather than just the slide, because
 * every interesting property of a deck is a property of all of it: changing one
 * slide's minutes changes the running total the teacher is planning against,
 * and changing its blocks changes the assessment list and the objective
 * coverage the gate reads. Repairing one slide in isolation is how those drift.
 */
export async function PATCH(req: NextRequest) {
  const user = await currentUser();
  const body = await req.json() as {
    lessonId?: string; slideId?: string;
    patch?: {
      title?: string; purpose?: string; minutes?: number; audience?: Audience;
      blocks?: SlideBlock[]; teacher?: Partial<TeacherNote>;
      objective_indexes?: number[];
      arrange?: Arrangement;
    };
  };

  const { lessonId, slideId, patch } = body;
  if (!lessonId || !slideId || !patch) {
    return NextResponse.json({ error: 'lessonId, slideId and patch are required' }, { status: 400 });
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
  const slide = deck.slides.find(s => s.id === slideId);
  if (!slide) return NextResponse.json({ error: 'no_such_slide' }, { status: 404 });

  const before = JSON.stringify(slide);

  // A restore point before a burst of hand edits, so "that was worse" has an
  // answer that is not the deck as generated. Throttled - see snapshotIfStale.
  // Named for the burst, not the slide: one restore point covers every hand edit
  // in the next few minutes, whichever slides they land on.
  await snapshotIfStale(lessonId, deck, 'Hand edits', user.id);

  if (typeof patch.title === 'string') slide.title = patch.title;
  if (typeof patch.purpose === 'string') slide.purpose = patch.purpose;
  if (Number.isFinite(patch.minutes)) slide.minutes = Math.max(0, Math.round(Number(patch.minutes)));
  if (patch.audience === 'student_facing' || patch.audience === 'teacher_led') {
    slide.audience = patch.audience;
  }
  if (Array.isArray(patch.blocks)) slide.blocks = patch.blocks;
  if (Array.isArray(patch.objective_indexes)) slide.objective_indexes = patch.objective_indexes;
  if (patch.teacher) slide.teacher = settleTeacher({ ...slide.teacher, ...patch.teacher });
  if (patch.arrange && (ARRANGEMENTS as readonly string[]).includes(patch.arrange)) {
    slide.arrange = patch.arrange === 'auto' ? undefined : patch.arrange;
  }

  const band = bandById(deck.meta.ageBand);
  repairDeck(deck, band);
  const fixed = deck.slides.find(s => s.id === slideId);
  if (fixed) fixed.layout = settleLayout(fixed);

  const ok = await saveDeck(lessonId, deck);
  if (!ok) {
    return NextResponse.json({
      error: 'save_failed',
      message: 'That did not save. Your text is still on the screen - try again in a moment.',
    }, { status: 502 });
  }

  // The edit trail.
  //
  // Not `edit_event`: that table is the planner's, and deliberately so - its
  // columns are `planner_id` and `lesson_entry_id`, both not null, and `field`
  // carries a CHECK of the three planner fields a teacher may change. A lesson
  // edit does not fit it, and widening it would weaken the constraint that makes
  // the planner's edit signal trustworthy (0003's comment: the edit IS the
  // feedback signal). So the trail is audit_log, which is where cross-artefact
  // actions already go.
  if (before !== JSON.stringify(fixed)) {
    await audit(user.id, 'lesson.edit', 'lesson', lessonId, {
      slide: slideId, fields: Object.keys(patch),
    });
  }

  return NextResponse.json({
    ok: true,
    slide: fixed,
    minutes: deck.slides.reduce((n, s) => n + s.minutes, 0),
    gate: checkDeck(deck, band),
  });
}
