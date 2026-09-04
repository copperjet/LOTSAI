import { NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * GET /api/calendar
 *
 * The school year as the teacher's own classes see it: every week of this
 * semester, and for each of their classes, what already exists for that week.
 *
 * The agenda only ever offers the next unplanned week, which is right for the
 * opening sentence and wrong as the only door — a teacher who wants week 6 of
 * Mathematics in October has to be able to say so.
 */
export async function GET() {
  const db = admin();
  const user = await currentUser();
  const today = new Date().toISOString().slice(0, 10);

  const { data: weeks } = await db.from('school_week')
    .select('id, week_number, week_commencing, week_type, semester')
    .eq('academic_year', '2026-27').order('week_commencing');

  const { data: classes } = await db.from('klass')
    .select('id, name, subject_id, year_group').eq('teacher_id', user.id).order('name');

  const classIds = (classes ?? []).map(k => k.id);
  const { data: planners } = classIds.length
    ? await db.from('planner').select('id, class_id, school_week, status').in('class_id', classIds)
    : { data: [] };

  // Which subjects a HOD has signed off, per week — planning is disabled until
  // they have (Addendum C section C7), and the picker should say so rather than
  // offering a week that will be refused.
  const { data: reg } = await db.from('curriculum_week')
    .select('week_number, semester, subject_id, year_group, signed_off_at, topic_label')
    .eq('academic_year', '2026-27');

  // Keyed by semester as well as week number, because both semesters have a week 1.
  // Until the calendar carried semester 2 that was theoretical; it is not any more, and
  // a key without it would show semester 2 week 3 the topic of semester 1 week 3.
  const key = (yearGroup: string, subject: string, semester: number, week: number) =>
    `${yearGroup}:${subject}:${semester}:${week}`;

  const signed = new Set((reg ?? []).filter(r => r.signed_off_at)
    .map(r => key(r.year_group, r.subject_id, r.semester, r.week_number)));
  const topics = new Map((reg ?? []).map(r =>
    [key(r.year_group, r.subject_id, r.semester, r.week_number), r.topic_label]));

  const byWeekId = new Map((weeks ?? []).map(w => [w.id, w]));
  const status: Record<string, string> = {};
  for (const p of planners ?? []) {
    const w = byWeekId.get(p.school_week);
    if (w) status[`${p.class_id}:${w.semester}:${w.week_number}`] = p.status;
  }

  return NextResponse.json({
    today,
    weeks: weeks ?? [],
    classes: (classes ?? []).map(k => ({
      ...k,
      weeks: (weeks ?? []).filter(w => w.week_type === 'teaching').map(w => ({
        weekNumber: w.week_number,
        semester: w.semester,
        weekCommencing: w.week_commencing,
        status: status[`${k.id}:${w.semester}:${w.week_number}`] ?? null,
        signedOff: signed.has(key(k.year_group, k.subject_id, w.semester, w.week_number)),
        topic: topics.get(key(k.year_group, k.subject_id, w.semester, w.week_number)) ?? null,
      })),
    })),
  });
}
