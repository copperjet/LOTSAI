import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * GET /api/search?q=…
 *
 * Three groups, because there are exactly three things worth finding: a planner
 * you already have, a week in the registry, and somebody else's approved work.
 *
 * The whole searchable set is one academic year — tens of registry weeks, a
 * handful of planners per teacher — so this loads and filters in memory rather
 * than pushing ilike into Postgres. That is deliberate at this scale, and it is
 * the thing to change first when the registry holds every stage: the shape of
 * the response stays, the source becomes a query.
 */

interface Hit { id: string; label: string; note: string; kind: string; payload: Record<string, unknown> }

const SAYS: Record<string, string> = {
  draft: 'drafted, not submitted', submitted: 'submitted for review',
  reviewed: 'reviewed', approved: 'approved', returned: 'returned by your HOD',
};

export async function GET(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ planners: [], weeks: [], bank: [] });

  const hit = (s: unknown) => typeof s === 'string' && s.toLowerCase().includes(q);

  // ---- your planners -------------------------------------------------------
  // A teacher searches their own classes; an HOD searches the department's,
  // because reviewing everybody's work is the job.
  const klass = db.from('klass').select('id, name, subject_id, year_group');
  const { data: classes } = user.role === 'hod'
    ? await klass
    : await klass.eq('teacher_id', user.id);

  const classIds = (classes ?? []).map(k => k.id);
  const { data: planners } = classIds.length
    ? await db.from('planner')
        .select('id, class_id, status, school_week, week:school_week(week_number, week_commencing)')
        .in('class_id', classIds)
    : { data: [] };

  const plannerHits: Hit[] = [];
  for (const p of planners ?? []) {
    const k = (classes ?? []).find(c => c.id === p.class_id);
    const week = p.week as unknown as { week_number: number } | null;
    const label = `${k?.name ?? p.class_id} - Week ${week?.week_number ?? '?'}`;
    if (!hit(label) && !hit(p.status) && !hit(k?.subject_id) && `week ${week?.week_number}` !== q) continue;
    plannerHits.push({
      id: p.id, kind: 'planner',
      label, note: SAYS[p.status] ?? p.status,
      payload: { plannerId: p.id, classId: p.class_id, weekNumber: week?.week_number },
    });
  }

  // ---- the registry --------------------------------------------------------
  const { data: weeks } = await db.from('curriculum_week')
    .select('id, year_group, subject_id, week_number, topic_label, objectives, signed_off_at')
    .eq('academic_year', '2026-27').order('week_number');

  const weekHits: Hit[] = [];
  for (const w of weeks ?? []) {
    const objs = (w.objectives ?? []) as { ref: string | null; text: string }[];
    const matched = objs.find(o => hit(o.ref) || hit(o.text));
    if (!hit(w.topic_label) && !matched && !hit(`${w.year_group} ${w.subject_id}`)) continue;
    // A class of the user's teaching this subject is what makes a week actionable.
    const k = (classes ?? []).find(c => c.subject_id === w.subject_id && c.year_group === w.year_group);
    weekHits.push({
      id: w.id, kind: 'week',
      label: `Week ${w.week_number} · ${w.topic_label}`,
      note: matched?.ref
        ? `${w.year_group} ${w.subject_id} · ${matched.ref}`
        : `${w.year_group} ${w.subject_id}${w.signed_off_at ? '' : ' · not signed off'}`,
      payload: { classId: k?.id ?? null, weekNumber: w.week_number, signedOff: !!w.signed_off_at },
    });
  }

  // ---- the shared bank -----------------------------------------------------
  const { data: bank } = await db.from('shared_artifact_ranked')
    .select('*').eq('approved', true).neq('visibility', 'private');

  const bankHits: Hit[] = [];
  for (const a of bank ?? []) {
    const refs: string[] = a.objective_refs ?? [];
    if (!hit(a.author_name) && !refs.some(hit) && !hit(a.subject_id) && !hit(`week ${a.week_number}`)) continue;
    bankHits.push({
      id: a.id, kind: 'bank',
      label: `${a.author_name} - week ${a.week_number}`,
      note: [refs.join(', '), a.landed_rate != null ? `${a.landed_rate}% landed` : null]
        .filter(Boolean).join(' · '),
      payload: { artefactId: a.id },
    });
  }

  return NextResponse.json({
    planners: plannerHits.slice(0, 8),
    weeks: weekHits.slice(0, 10),
    bank: bankHits.slice(0, 6),
  });
}
