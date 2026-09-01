import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';

export const runtime = 'nodejs';

/** A reviewer signing off the whole school at once is still a reviewer; a request
 *  carrying thousands of subjects is a mistake or a probe. */
const MAX_AT_ONCE = 100;

/**
 * GET  /api/review                 the HOD's queue, with gate results attached
 * GET  /api/review?view=bank       the shared bank, ranked
 * GET  /api/review?view=registry   what is still blocking generation
 * GET  /api/review?view=coverage   computed coverage per class
 * POST /api/review  { action: 'sign_off', subjects: [{ yearGroup, subjectId }] }
 *                   { action: 'sign_off', yearGroup, subjectId }   - one, as before
 */
export async function GET(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const view = req.nextUrl.searchParams.get('view');

  if (view === 'bank') {
    // Department-wide by default; private artefacts leave the index (B rule 5).
    const { data } = await db.from('shared_artifact_ranked').select('*')
      .eq('approved', true).neq('visibility', 'private')
      .order('landed_rate', { ascending: false, nullsFirst: false })
      .order('reuse_count', { ascending: false })
      .limit(12);
    return NextResponse.json({ bank: data ?? [] });
  }

  if (view === 'registry') {
    const { data } = await db.from('curriculum_week')
      .select('year_group, subject_id, objectives, source_file, signed_off_at');

    const groups = new Map<string, { year_group: string; subject_id: string; weeks: number; uncoded: number; source: string; signed: boolean }>();
    for (const row of data ?? []) {
      const key = `${row.year_group}|${row.subject_id}`;
      const g = groups.get(key) ?? {
        year_group: row.year_group, subject_id: row.subject_id,
        weeks: 0, uncoded: 0, source: row.source_file ?? '', signed: true,
      };
      g.weeks++;
      if (!(row.objectives as { ref: string | null }[]).some(o => o.ref)) g.uncoded++;
      if (!row.signed_off_at) g.signed = false;
      groups.set(key, g);
    }
    // What never reached the registry at all: conflicts a human must decide,
    // files that could not be read, filenames that could not be placed. These
    // sit alongside the imported-but-unsigned subjects above — both are "not
    // plannable yet", for different reasons a reviewer needs told apart.
    const { data: gaps } = await db.from('registry_gap')
      .select('id, kind, year_group, subject, semester, detail, files, resolved_file')
      .eq('academic_year', '2026-27')
      .order('kind');

    return NextResponse.json({
      blocked: [...groups.values()].filter(g => !g.signed),
      gaps: gaps ?? [],
    });
  }

  if (view === 'coverage') {
    const { data: classes } = await db.from('klass').select('id, name');
    const coverage = [];
    for (const k of classes ?? []) {
      const { data } = await db.rpc('class_coverage', { p_class_id: k.id, p_semester: 1 });
      const row = Array.isArray(data) ? data[0] : data;
      coverage.push({ name: k.name, ...(row ?? { planned: 0, taught: 0, landed: 0 }) });
    }
    return NextResponse.json({ coverage });
  }

  const { data: queue } = await db.from('planner')
    .select('id, klass:class_id(name), app_user:teacher_id(full_name)')
    .eq('status', 'submitted');

  const rows = [];
  for (const p of queue ?? []) {
    const { data: gate } = await db.from('gate_result').select('*')
      .eq('planner_id', p.id).order('ran_at', { ascending: false }).limit(1).maybeSingle();
    const checks = (gate?.checks ?? []) as { status: string }[];
    rows.push({
      id: p.id,
      class_name: (p as unknown as { klass?: { name: string } }).klass?.name ?? 'A class',
      teacher_name: (p as unknown as { app_user?: { full_name: string } }).app_user?.full_name ?? 'A teacher',
      gate: gate ? { ...gate, passed: checks.filter(c => c.status === 'pass').length } : null,
    });
  }
  await audit(user.id, 'review.queue');
  return NextResponse.json({ queue: rows });
}

export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  if (!['hod', 'coordinator', 'principal', 'admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Only a reviewer can sign off the curriculum' }, { status: 403 });
  }

  const body = await req.json();
  const { action, yearGroup, subjectId } = body;
  if (action !== 'sign_off') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  // Twenty subjects waiting is twenty round trips if this only ever takes one, so it
  // takes a list. One subject is the list of one, which is what the older callers send.
  const asked: { yearGroup: string; subjectId: string }[] =
    Array.isArray(body.subjects) ? body.subjects : [{ yearGroup, subjectId }];

  const seen = new Set<string>();
  const subjects = asked
    .filter(s => s && s.yearGroup && s.subjectId)
    .filter(s => {
      const key = `${s.yearGroup}|${s.subjectId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_AT_ONCE);

  if (!subjects.length) {
    return NextResponse.json({ error: 'No subject named' }, { status: 400 });
  }

  // Sign-off is what opens generation for a subject (Addendum C section C7).
  // It is a named human act, and it is logged as one - so a batch of twenty is
  // twenty entries in the log, not one entry saying "twenty".
  const at = new Date().toISOString();
  let weeks = 0;
  for (const s of subjects) {
    const { count } = await db.from('curriculum_week')
      .update({ signed_off_by: user.id, signed_off_at: at }, { count: 'exact' })
      .match({ year_group: s.yearGroup, subject_id: s.subjectId, academic_year: '2026-27' });
    weeks += count ?? 0;
    await audit(user.id, 'registry.sign_off', 'curriculum_week',
      `${s.yearGroup}/${s.subjectId}`, { weeks: count });
  }

  return NextResponse.json({ ok: true, signed: subjects.length, weeks });
}
