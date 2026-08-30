import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { worksheetWorkKey, findWorksheetMatches } from '@/lib/worksheet';

export const runtime = 'nodejs';

/**
 * POST /api/worksheet/match  { classId, weekNumber }
 *
 * Search before generate, for worksheets. No model call. Answers: is the week
 * signed off, what objectives does it cover, and has a colleague already had an
 * approved worksheet for the same objectives — so a later teacher is offered it
 * before anything is generated.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { classId, weekNumber } = await req.json();

  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: week } = await db.from('curriculum_week')
    .select('week_number, topic_label, objectives, signed_off_at')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id).eq('academic_year', '2026-27')
    .eq('week_number', weekNumber).maybeSingle();

  if (!week) {
    return NextResponse.json({ blocked: 'no_registry',
      message: `The registry holds nothing for ${klass.year_group} ${klass.subject_id}, week ${weekNumber}.` });
  }
  if (!week.signed_off_at) {
    return NextResponse.json({ blocked: 'not_signed_off',
      message: `Week ${weekNumber} of ${klass.year_group} ${klass.subject_id} is not signed off. A worksheet is built only from a signed-off week.` });
  }

  const refs = [...new Set((week.objectives as { ref: string | null }[])
    .map(o => o.ref).filter((r): r is string => !!r))].sort();

  const key = worksheetWorkKey({ subjectId: klass.subject_id, yearGroup: klass.year_group, academicYear: '2026-27', weekNumber, refs });
  const matches = await findWorksheetMatches(klass.subject_id, klass.year_group, refs);

  await audit(user.id, 'worksheet.match', 'klass', classId, { week: weekNumber, matches: matches.length });

  return NextResponse.json({
    workKey: key,
    week: { weekNumber, topic: week.topic_label },
    refs,
    uncoded: refs.length === 0,
    matches,
    costs: { reuse: 0, create: 0.03 },
  });
}
