import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { packWorkKey, findPackMatches } from '@/lib/studypack';

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
  const { classId, weekFrom, weekTo } = await req.json();

  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: weeks } = await db.from('curriculum_week')
    .select('week_number, topic_label, objectives, signed_off_at')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id).eq('academic_year', '2026-27')
    .gte('week_number', weekFrom).lte('week_number', weekTo)
    .order('week_number');

  if (!weeks?.length) {
    return NextResponse.json({ blocked: 'no_registry',
      message: `The registry holds nothing for ${klass.year_group} ${klass.subject_id}, weeks ${weekFrom}-${weekTo}.` });
  }
  // A pack may only be built from signed-off weeks (Addendum C §C7). If any week
  // in the span is not signed off, say which rather than silently dropping it.
  const unsigned = weeks.filter(w => !w.signed_off_at).map(w => w.week_number);
  if (unsigned.length) {
    return NextResponse.json({ blocked: 'not_signed_off',
      message: `Weeks ${unsigned.join(', ')} of ${klass.year_group} ${klass.subject_id} are not signed off. A study pack is built only from signed-off weeks.` });
  }

  const refs = [...new Set(weeks.flatMap(w =>
    (w.objectives as { ref: string | null }[]).map(o => o.ref).filter((r): r is string => !!r)))].sort();

  const key = packWorkKey({ subjectId: klass.subject_id, yearGroup: klass.year_group, academicYear: '2026-27', weekFrom, refs });
  const matches = await findPackMatches(klass.subject_id, klass.year_group, refs);

  await audit(user.id, 'studypack.match', 'klass', classId, { weeks: `${weekFrom}-${weekTo}`, matches: matches.length });

  return NextResponse.json({
    workKey: key,
    span: { weekFrom, weekTo, weeks: weeks.map(w => ({ week: w.week_number, topic: w.topic_label })) },
    refs,
    uncoded: refs.length === 0,
    matches,
    costs: { reuse: 0, create: 0.03 },
  });
}
