import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { workKey } from '@/lib/workkey';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';

export const runtime = 'nodejs';

/**
 * POST /api/plan/submit   { plannerId }                     teacher submits
 * PUT  /api/plan/submit   { plannerId, decision, comment }  HOD approves or returns
 *
 * Approval is the moment an artefact enters the shared bank, which is why the
 * bank only ever contains work a named human signed off (Addendum B rule 3).
 */

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { plannerId } = await req.json();

  const { data: gate } = await db.from('gate_result').select('*')
    .eq('planner_id', plannerId).order('ran_at', { ascending: false }).limit(1).maybeSingle();

  // A blocked plan cannot be submitted. Warnings travel with it instead.
  if (gate && gate.blocking > 0) {
    return NextResponse.json({
      error: 'blocked',
      message: 'The quality gate is still blocking this plan. Fix the blocking items and try again.',
      checks: gate.checks,
    }, { status: 409 });
  }

  await db.from('planner').update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('id', plannerId).eq('teacher_id', user.id);
  await audit(user.id, 'plan.submit', 'planner', plannerId);

  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  if (!['hod', 'coordinator', 'principal', 'admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Only a reviewer can approve a planner' }, { status: 403 });
  }

  const { plannerId, decision, comment } = await req.json();

  await db.from('hod_review').insert({
    planner_id: plannerId, reviewer_id: user.id,
    comment: comment ?? null,     // written by the HOD, never by a model
    decision,
  });

  if (decision === 'returned') {
    await db.from('planner').update({ status: 'returned' }).eq('id', plannerId);
    await audit(user.id, 'plan.return', 'planner', plannerId);
    return NextResponse.json({ ok: true, status: 'returned' });
  }

  const { data: planner } = await db.from('planner')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', plannerId).select('*, klass:class_id(year_group, subject_id)').single();

  const { data: lessons } = await db.from('lesson_entry')
    .select('objectives').eq('planner_id', plannerId);
  const refs = [...new Set((lessons ?? []).flatMap(l =>
    (l.objectives as { ref: string | null }[]).map(o => o.ref).filter((r): r is string => !!r)))].sort();

  const { data: week } = await db.from('school_week').select('week_number')
    .eq('id', planner!.school_week).single();

  const klass = planner!.klass as unknown as { year_group: string; subject_id: string };

  // Into the bank, keyed so the next teacher finds it before generating anything.
  await db.from('shared_artifact').insert({
    work_key: workKey({
      artefactType: 'planner', subjectId: klass.subject_id, yearGroup: klass.year_group,
      academicYear: '2026-27', weekNumber: week!.week_number, refs,
    }),
    academic_year: '2026-27',
    year_group: klass.year_group,
    subject_id: klass.subject_id,
    week_number: week!.week_number,
    objective_refs: refs,
    planner_id: plannerId,
    author_id: planner!.teacher_id,   // the original author, not the reviewer
    approved: true,
  });

  await audit(user.id, 'plan.approve', 'planner', plannerId);

  // Render the approved planner to a PDF on the LOTS template and store it. This
  // is a rendering of the records (main spec §4), so it runs after the artefact is
  // already banked and never blocks approval if it fails (storeArtefact swallows).
  const workflow = await engine.resolveWorkflow('weekly_planner');
  const render = workflow.render?.on === 'approved' && workflow.standard.renderer_id
    ? await storeArtefact(workflow.standard, plannerId)
    : null;

  return NextResponse.json({ ok: true, status: 'approved', render });
}
