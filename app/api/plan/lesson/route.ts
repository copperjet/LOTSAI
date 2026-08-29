import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { buildGateInput } from '@/lib/gateContext';
import { runGate } from '@/lib/gate';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * PATCH /api/plan/lesson  { lessonEntryId, field, value }
 *
 * One field of one lesson, changed by the teacher. Two things happen besides the
 * update: the change is recorded in edit_event (Addendum D section D5 rule 3 —
 * the edit is the feedback signal), and the gate re-runs, because methodology,
 * resources and differentiation are exactly what it judges.
 *
 * Objectives are not editable here. They are retrieved from the registry, and
 * editing them would break both coverage counting and the work key.
 */

const EDITABLE = ['methodology', 'resources', 'differentiation'] as const;
type Field = (typeof EDITABLE)[number];

const OPEN = ['draft', 'returned'];

export async function PATCH(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { lessonEntryId, field, value } = await req.json();

  if (!EDITABLE.includes(field as Field)) {
    return NextResponse.json({
      error: 'field',
      message: 'Only methodology, resources and differentiation are editable. Objectives come from the registry.',
    }, { status: 400 });
  }

  const { data: lesson } = await db.from('lesson_entry')
    .select('id, planner_id, methodology, resources, differentiation')
    .eq('id', lessonEntryId).single();
  if (!lesson) return NextResponse.json({ error: 'Unknown lesson' }, { status: 404 });

  const { data: planner } = await db.from('planner')
    .select('id, status, origin, teacher_id').eq('id', lesson.planner_id).single();
  if (!planner) return NextResponse.json({ error: 'Unknown planner' }, { status: 404 });

  // A submitted or approved plan is a record, not a draft.
  if (!OPEN.includes(planner.status)) {
    return NextResponse.json({
      error: 'closed',
      message: planner.status === 'submitted'
        ? 'This plan is with your HOD. It can be edited again if it comes back to you.'
        : 'This plan is approved and in the shared bank, so it is no longer editable.',
      status: planner.status,
    }, { status: 409 });
  }

  const before = (lesson[field as Field] ?? '') as string;
  const after = typeof value === 'string' ? value.trim() : '';

  // Focus and blur with nothing typed is not an edit, and should not fill the history.
  if (after === before.trim()) return NextResponse.json({ ok: true, unchanged: true });
  if (!after) {
    return NextResponse.json({
      error: 'empty', message: 'That field cannot be left empty.',
    }, { status: 400 });
  }

  await db.from('edit_event').insert({
    lesson_entry_id: lesson.id,
    planner_id: planner.id,
    editor_id: user.id,
    field,
    before_text: before,
    after_text: after,
    origin: planner.origin,
  });

  await db.from('lesson_entry').update({ [field]: after }).eq('id', lesson.id);

  // The gate judges these three fields, so it has to see the edit. runGate skips
  // its model pass whenever anything is blocking, so most edits cost nothing.
  const gate = await runGate(await buildGateInput(planner.id), user.id);
  await db.from('gate_result').insert({
    planner_id: planner.id, checks: gate.checks,
    blocking: gate.blocking, warnings: gate.warnings,
  });

  await audit(user.id, 'lesson.edit', 'lesson_entry', lesson.id, { field });

  return NextResponse.json({ ok: true, gate });
}
