import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { generatePlan, RegistryWeek } from '@/lib/planner';
import { runGate } from '@/lib/gate';
import { buildGateInput } from '@/lib/gateContext';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface LessonRow {
  position: number; day_of_week: number; lesson_date: string;
  objectives: { ref: string | null; text: string }[];
  methodology: string; resources: string; differentiation: string; is_recap: boolean;
}

/**
 * POST /api/plan/generate  { classId, weekNumber, mode, basisArtifactId? }
 *
 * mode 'reuse'  — copies an approved plan verbatim. No model call, costs nothing.
 * mode 'adapt'  — sends the approved plan plus this class's deltas, asks for the difference.
 * mode 'create' — full generation from the registry.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { classId, weekNumber, mode, basisArtifactId } = await req.json();

  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: reg } = await db.from('curriculum_week').select('*')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id)
    .eq('week_number', weekNumber).eq('academic_year', '2026-27').single();
  if (!reg?.signed_off_at) {
    return NextResponse.json({ error: 'Registry not signed off for this subject' }, { status: 409 });
  }

  const { data: week } = await db.from('school_week').select('*')
    .eq('academic_year', '2026-27').eq('semester', reg.semester)
    .eq('week_number', weekNumber).single();
  if (!week) return NextResponse.json({ error: 'No such school week' }, { status: 404 });

  const { data: inv } = await db.from('resource_inventory').select('label')
    .eq('subject_id', klass.subject_id).eq('year_group', klass.year_group);
  const inventory = (inv ?? []).map(r => r.label);

  // What this class did not land recently. This is the whole reason an adapted
  // plan differs from the approved one it started from (Addendum B rule 1).
  const { data: flaggedRows } = await db.rpc('recent_flagged', { p_class_id: classId, p_weeks: 2 });
  const flagged = (flaggedRows ?? []) as { ref: string; text: string; note: string }[];

  let basis: { day_of_week: number; methodology: string; resources: string; differentiation: string }[] | undefined;
  let basisPlannerId: string | null = null;
  let basisRows: LessonRow[] = [];

  if (mode !== 'create' && basisArtifactId) {
    const { data: art } = await db.from('shared_artifact')
      .select('planner_id').eq('id', basisArtifactId).single();
    basisPlannerId = art?.planner_id ?? null;
    if (basisPlannerId) {
      const { data: rows } = await db.from('lesson_entry').select('*')
        .eq('planner_id', basisPlannerId).order('position');
      basisRows = (rows ?? []) as LessonRow[];
      basis = basisRows.map(r => ({
        day_of_week: r.day_of_week, methodology: r.methodology,
        resources: r.resources, differentiation: r.differentiation,
      }));
    }
  }

  const monday = new Date(week.week_commencing);
  const dateFor = (day: number) => {
    const d = new Date(monday); d.setDate(monday.getDate() + (day - 1));
    return d.toISOString().slice(0, 10);
  };

  let lessons: LessonRow[];
  let usage = null;

  if (mode === 'reuse' && basisRows.length) {
    lessons = basisRows.map((r, position) => ({
      position, day_of_week: r.day_of_week, lesson_date: dateFor(r.day_of_week),
      objectives: r.objectives, methodology: r.methodology, resources: r.resources,
      differentiation: r.differentiation, is_recap: r.is_recap,
    }));
  } else {
    const out = await generatePlan({
      reg: reg as RegistryWeek,
      periodsPerWeek: klass.periods_per_week,
      weekCommencing: week.week_commencing,
      inventory, flagged, basis,
    }, user.id);
    lessons = out.lessons as LessonRow[];
    usage = out.usage;
  }

  const { data: planner } = await db.from('planner').upsert({
    class_id: classId, teacher_id: user.id, school_week: week.id,
    status: 'draft', origin: mode, adapted_from: basisPlannerId,
  }, { onConflict: 'class_id,school_week' }).select().single();

  await db.from('lesson_entry').delete().eq('planner_id', planner!.id);
  // Return the stored rows, not the local ones: the client needs the row ids to
  // edit a cell in place (PATCH /api/plan/lesson).
  const { data: saved } = await db.from('lesson_entry')
    .insert(lessons.map(l => ({ ...l, planner_id: planner!.id })))
    .select();
  const stored = (saved ?? []).slice().sort((a, b) => a.position - b.position);

  if (basisArtifactId && mode !== 'create') {
    await db.from('reuse_event').insert({
      shared_artifact_id: basisArtifactId, reusing_user_id: user.id, class_id: classId, mode,
    });
    await db.rpc('bump_artifact', { p_id: basisArtifactId, p_mode: mode });
  }

  const gate = await runGate(await buildGateInput(planner!.id), user.id);

  await db.from('gate_result').insert({
    planner_id: planner!.id, checks: gate.checks,
    blocking: gate.blocking, warnings: gate.warnings,
  });
  await audit(user.id, `plan.${mode}`, 'planner', planner!.id);

  return NextResponse.json({ plannerId: planner!.id, mode, status: 'draft', lessons: stored, gate, usage });
}
