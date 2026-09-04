import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { packWorkKey, findPackMatches } from '@/lib/studypack';
import { dedupeObjectives, type Objective } from '@/lib/planner';

export const runtime = 'nodejs';

/**
 * POST /api/studypack/match  { classId, weekFrom, weekTo }
 *
 * Search before generate, for study packs. No model call. Answers: is the
 * registry signed off across this span, what objectives does it cover, and has a
 * colleague already built an approved pack for the same objectives.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
const body = await req.json();
  const { classId, weekFrom, weekTo } = body;
  // A week number belongs to a semester: both have a week 1, and the registry keys on
  // the pair. Older callers send no semester, so it defaults to 1 - what every stored
  // row was written as before the calendar carried the rest of the year.
  const semester = Number(body.semester) === 2 ? 2 : 1;


  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: weeks } = await db.from('curriculum_week')
    .select('week_number, topic_label, objectives, signed_off_at')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id).eq('academic_year', '2026-27')
    .eq('semester', semester).gte('week_number', weekFrom).lte('week_number', weekTo)
    .order('week_number');

  if (!weeks?.length) {
    return NextResponse.json({ blocked: 'no_registry',
      message: `The curriculum has nothing for ${klass.year_group} ${klass.subject_id}, weeks ${weekFrom}-${weekTo} yet.` });
  }
  // A pack may only be built from signed-off weeks (Addendum C §C7). If any week
  // in the span is not signed off, say which rather than silently dropping it.
  const unsigned = weeks.filter(w => !w.signed_off_at).map(w => w.week_number);
  if (unsigned.length) {
    return NextResponse.json({ blocked: 'not_signed_off',
      message: `Weeks ${unsigned.join(', ')} of ${klass.year_group} ${klass.subject_id} are waiting for a Head of Department to sign them off. Packs are only built from weeks that have been.` });
  }

  const objectives = dedupeObjectives(weeks.flatMap(w => w.objectives as Objective[]));
  const refs = [...new Set(objectives.map(o => o.ref).filter((r): r is string => !!r))].sort();

  const key = packWorkKey({ subjectId: klass.subject_id, yearGroup: klass.year_group, academicYear: '2026-27', weekFrom, refs });
  const matches = await findPackMatches(klass.subject_id, klass.year_group, refs);

  await audit(user.id, 'studypack.match', 'klass', classId, { weeks: `${weekFrom}-${weekTo}`, matches: matches.length });

  return NextResponse.json({
    workKey: key,
    span: { weekFrom, weekTo, weeks: weeks.map(w => ({ week: w.week_number, topic: w.topic_label })) },
    refs,
    // The codes and what they say, across the whole span.
    objectives,
    uncoded: refs.length === 0,
    matches,
  });
}
