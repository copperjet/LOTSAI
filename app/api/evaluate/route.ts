import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { formatEvaluation } from '@/lib/evaluation';

export const runtime = 'nodejs';

/**
 * GET  /api/evaluate            — which of today's lessons still need a note
 * POST /api/evaluate  { lessonEntryId, raw, capturedAt? }
 *
 * capturedAt is sent by the client when the note was written offline, so the
 * record keeps the time the teacher actually spoke rather than the time the
 * phone found a signal.
 */

export async function GET() {
  const db = admin();
  const user = await currentUser();

  const { data } = await db.from('lesson_entry')
    .select('id, lesson_date, day_of_week, objectives, methodology, planner!inner(class_id, teacher_id, klass:class_id(name))')
    .eq('planner.teacher_id', user.id)
    .lte('lesson_date', new Date().toISOString().slice(0, 10))
    .order('lesson_date', { ascending: false })
    .limit(12);

  const ids = (data ?? []).map(l => l.id);
  const { data: done } = await db.from('evaluation').select('lesson_entry_id').in('lesson_entry_id', ids);
  const evaluated = new Set((done ?? []).map(e => e.lesson_entry_id));

  return NextResponse.json({
    outstanding: (data ?? []).filter(l => !evaluated.has(l.id)),
  });
}

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { lessonEntryId, raw, capturedAt } = await req.json();

  if (!raw?.trim()) return NextResponse.json({ error: 'Nothing to record' }, { status: 400 });

  const { data: lesson } = await db.from('lesson_entry')
    .select('*, planner!inner(class_id, klass:class_id(name))').eq('id', lessonEntryId).single();
  if (!lesson) return NextResponse.json({ error: 'Unknown lesson' }, { status: 404 });

  const className = (lesson as { planner?: { klass?: { name?: string } } }).planner?.klass?.name ?? 'this class';
  const day = new Date(lesson.lesson_date).toLocaleDateString('en-GB', { weekday: 'long' });

  const result = await formatEvaluation(raw, {
    objectives: lesson.objectives, methodology: lesson.methodology, className, day,
  }, user.id);

  const { data: saved } = await db.from('evaluation').insert({
    lesson_entry_id: lessonEntryId,
    teacher_id: user.id,
    raw_input: raw,
    formatted_comment: result.formatted_comment,
    objectives_landed: result.landed,
    objectives_flagged: result.flagged,
    captured_at: capturedAt ?? new Date().toISOString(),
    synced_at: new Date().toISOString(),
  }).select().single();

  // The formatted note is written into the planner's own comment box, so the
  // rendered document reads the way it always has.
  await db.from('lesson_entry')
    .update({ teacher_comment: result.formatted_comment }).eq('id', lessonEntryId);

  await audit(user.id, 'evaluation.record', 'lesson_entry', lessonEntryId,
    { landed: result.landed, flagged: result.flagged });

  return NextResponse.json({
    evaluation: saved,
    comment: result.formatted_comment,
    landed: result.landed,
    flagged: result.flagged,
    question: result.clarifying_question ?? null,
    usage: result.usage,
  });
}
