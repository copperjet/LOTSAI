import { admin } from './supabase';
import type { GateInput } from './gate';

/**
 * Everything the gate needs about a planner, assembled from the database.
 *
 * The generate route built this inline. An edit has to re-run the gate too, and
 * two copies of this assembly would drift the moment either grew a field — so it
 * lives here and both callers use it.
 */
export async function buildGateInput(plannerId: string): Promise<GateInput> {
  const db = admin();

  const { data: planner } = await db.from('planner')
    .select('id, class_id, school_week').eq('id', plannerId).single();
  if (!planner) throw new Error(`No planner ${plannerId}`);

  const { data: klass } = await db.from('klass')
    .select('id, year_group, subject_id, periods_per_week').eq('id', planner.class_id).single();
  if (!klass) throw new Error(`No class ${planner.class_id}`);

  const { data: week } = await db.from('school_week')
    .select('week_number, week_commencing, semester').eq('id', planner.school_week).single();
  if (!week) throw new Error(`No school week ${planner.school_week}`);

  const { data: reg } = await db.from('curriculum_week').select('objectives')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id)
    .eq('semester', week.semester).eq('week_number', week.week_number)
    .eq('academic_year', '2026-27').maybeSingle();

  const { data: inv } = await db.from('resource_inventory').select('label')
    .eq('subject_id', klass.subject_id).eq('year_group', klass.year_group);

  const { data: flaggedRows } = await db.rpc('recent_flagged', {
    p_class_id: klass.id, p_weeks: 2,
  });

  const { data: lessons } = await db.from('lesson_entry')
    .select('day_of_week, lesson_date, objectives, methodology, resources, differentiation, is_recap')
    .eq('planner_id', plannerId).order('position');

  return {
    weekNumber: week.week_number,
    weekCommencing: week.week_commencing,
    periodsPerWeek: klass.periods_per_week,
    registryRefs: ((reg?.objectives ?? []) as { ref: string | null }[])
      .map(o => o.ref).filter((r): r is string => !!r),
    inventory: (inv ?? []).map(r => r.label),
    flaggedLastWeeks: ((flaggedRows ?? []) as { ref: string }[]).map(f => f.ref),
    classRoll: [],          // v1 holds no learner data, so there is no roll to check against
    lessons: (lessons ?? []) as GateInput['lessons'],
  };
}
