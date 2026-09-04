import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { RegistryWeek } from '@/lib/planner';
import * as engine from '@/lib/engine';

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
const body = await req.json();
  const { classId, weekNumber, mode, basisArtifactId } = body;
  // A week number belongs to a semester: both have a week 1, and the registry keys on
  // the pair. Older callers send no semester, so it defaults to 1 - what every stored
  // row was written as before the calendar carried the rest of the year.
  const semester = Number(body.semester) === 2 ? 2 : 1;


  // The workflow + its Standard drive generation and gating. Falls back to the
  // built-in weekly_planner config if migration 0007 has not been applied, so the
  // route behaves identically before and after the engine's tables exist.
  const workflow = await engine.resolveWorkflow('weekly_planner');
  const std = workflow.standard;

  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: reg } = await db.from('curriculum_week').select('*')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id)
    .eq('week_number', weekNumber).eq('semester', semester).eq('academic_year', '2026-27').single();
  if (!reg?.signed_off_at) {
    return NextResponse.json({ error: 'not_signed_off', message: 'This subject is still waiting to be signed off for the semester.' }, { status: 409 });
  }

  const { data: week } = await db.from('school_week').select('*')
    .eq('academic_year', '2026-27').eq('semester', reg.semester)
    .eq('week_number', weekNumber).single();
  if (!week) return NextResponse.json({ error: 'No such school week' }, { status: 404 });

  /**
   * A submitted or approved planner is a record, and this route is destructive:
   * it upserts the planner back to `draft` and deletes every lesson_entry under
   * it. On an approved planner that also guts the `shared_artifact` the bank
   * points at, so a colleague's reuse would silently resolve to nothing.
   *
   * `/api/plan/lesson` already refuses to edit a planner in these states. The
   * same rule has to live here, not only in the caller: /api/plan/match reports
   * `existing` so the UI can warn, but a route that destroys approved work must
   * not depend on every future caller remembering to ask first. Same failure as
   * the draft-destroying bug, one status further on.
   */
  const OPEN = ['draft', 'returned'];
  const { data: prior } = await db.from('planner')
    .select('id, status, teacher_id, app_user:teacher_id(full_name)')
    .eq('class_id', classId).eq('school_week', week.id).maybeSingle();

  if (prior && !OPEN.includes(prior.status)) {
    const who = (prior as unknown as { app_user?: { full_name: string } }).app_user?.full_name;
    return NextResponse.json({
      error: 'not_open',
      message: prior.status === 'approved'
        ? `This week is already approved${who ? ` for ${who}` : ''}. Regenerating would replace work the department is already reusing. Ask the HOD to return it first.`
        : `This week has already been submitted${who ? ` by ${who}` : ''} and is waiting on the HOD. It cannot be regenerated until it is returned.`,
      plannerId: prior.id,
      status: prior.status,
    }, { status: 409 });
  }

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

  if (mode === 'reuse' && basisRows.length) {
    lessons = basisRows.map((r, position) => ({
      position, day_of_week: r.day_of_week, lesson_date: dateFor(r.day_of_week),
      objectives: r.objectives, methodology: r.methodology, resources: r.resources,
      differentiation: r.differentiation, is_recap: r.is_recap,
    }));
  } else {
    const out = await engine.generate(std, {
      reg: reg as RegistryWeek,
      periodsPerWeek: klass.periods_per_week,
      weekCommencing: week.week_commencing,
      inventory, flagged, basis,
    }, user.id);
    lessons = out.lessons as LessonRow[];
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

  const gate = await engine.gate(std, planner!.id, user.id);

  await db.from('gate_result').insert({
    planner_id: planner!.id, checks: gate.checks,
    blocking: gate.blocking, warnings: gate.warnings,
  });
  await audit(user.id, `plan.${mode}`, 'planner', planner!.id);

  return NextResponse.json({ plannerId: planner!.id, mode, status: 'draft', lessons: stored, gate });
}
