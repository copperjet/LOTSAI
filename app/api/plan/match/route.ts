import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { findMatches, RegistryWeek } from '@/lib/planner';
import { workKey } from '@/lib/workkey';

export const runtime = 'nodejs';

/**
 * POST /api/plan/match  { classId, weekNumber }
 *
 * Search before generate. This route calls no model, so it costs nothing.
 * It answers three questions: is the registry signed off for this subject,
 * has a colleague already planned this week, and is someone doing it right now.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { classId, weekNumber } = await req.json();

  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: reg } = await db.from('curriculum_week').select('*')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id)
    .eq('week_number', weekNumber).eq('academic_year', '2026-27').maybeSingle();

  if (!reg) {
    return NextResponse.json({
      blocked: 'no_registry',
      message: `The curriculum has nothing for ${klass.year_group} ${klass.subject_id}, week ${weekNumber} yet. That overview needs adding before it can be planned.`,
    });
  }

  // No sign-off, no generation (Addendum C section C7). This is the only defence
  // against a confident plan built on last year's file.
  if (!reg.signed_off_at) {
    return NextResponse.json({
      blocked: 'not_signed_off',
      message: `${klass.year_group} ${klass.subject_id} is waiting for its Head of Department to sign off this semester. Planning opens as soon as they do.`,
    });
  }

  const week = reg as RegistryWeek;
  const refs = week.objectives.map(o => o.ref).filter((r): r is string => !!r);
  const matches = await findMatches(week);

  const key = workKey({
    artefactType: 'planner', subjectId: klass.subject_id, yearGroup: klass.year_group,
    academicYear: '2026-27', weekNumber, refs,
  });

  // A claim, never a lock (Addendum B section B5).
  const { data: claim } = await db.from('work_claim')
    .select('user_id, app_user(full_name)')
    .eq('work_key', key).gt('expires_at', new Date().toISOString()).maybeSingle();

  await db.from('work_claim').upsert({
    work_key: key, user_id: user.id,
    claimed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  });

  await audit(user.id, 'plan.match', 'curriculum_week', reg.id, { matches: matches.length });

  const other = claim && claim.user_id !== user.id
    ? (claim as unknown as { app_user?: { full_name: string } }).app_user?.full_name ?? 'A colleague'
    : null;

  // Is there already a planner for this class and week? Generation upserts the
  // planner and deletes its lessons, so a caller that does not know this exists
  // would quietly destroy a teacher's draft and the evaluations hanging off it.
  const { data: schoolWeek } = await db.from('school_week').select('id')
    .eq('academic_year', '2026-27').eq('semester', reg.semester)
    .eq('week_number', weekNumber).maybeSingle();

  const { data: had } = schoolWeek
    ? await db.from('planner').select('id, status, teacher_id, app_user:teacher_id(full_name)')
        .eq('class_id', classId).eq('school_week', schoolWeek.id).maybeSingle()
    : { data: null };

  const { count: lessonCount } = had
    ? await db.from('lesson_entry').select('*', { count: 'exact', head: true }).eq('planner_id', had.id)
    : { count: 0 };

  return NextResponse.json({
    workKey: key,
    existing: had ? {
      plannerId: had.id,
      status: had.status,
      lessons: lessonCount ?? 0,
      mine: had.teacher_id === user.id,
      author: (had as unknown as { app_user?: { full_name: string } }).app_user?.full_name ?? null,
    } : null,
    registry: {
      topic: week.topic_label,
      objectives: week.objectives,
      refs,
      // An uncoded overview cannot be matched exactly. Say so rather than
      // pretending, and never invent a reference to make it matchable.
      uncoded: refs.length === 0,
    },
    matches,
    claimedBy: other,
  });
}
