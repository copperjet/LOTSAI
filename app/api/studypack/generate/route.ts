import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { packWorkKey, type PackContent, type RegistryWeekLite } from '@/lib/studypack';
import { storeArtefact } from '@/lib/pdf/store';

export const runtime = 'nodejs';
export const maxDuration = 90;

/**
 * POST /api/studypack/generate  { classId, weekFrom, weekTo }
 * GET  /api/studypack/generate?studyPackId=<id>   — a signed URL for the HTML
 *
 * Generate a study pack over a span of signed-off weeks, store it, render the
 * interactive HTML to the artefacts bucket. Objectives are retrieved from the
 * registry; the pedagogy is generated. Runs through the same engine the planner
 * does — a different Standard, the same pipeline.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { classId, weekFrom, weekTo } = await req.json();

  const workflow = await engine.resolveWorkflow('study_pack');
  const std = workflow.standard;

  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: weeks } = await db.from('curriculum_week')
    .select('week_number, topic_label, objectives, signed_off_at')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id).eq('academic_year', '2026-27')
    .gte('week_number', weekFrom).lte('week_number', weekTo)
    .order('week_number');

  const signed = (weeks ?? []).filter(w => w.signed_off_at);
  if (!signed.length) {
    return NextResponse.json({ error: 'No signed-off weeks in this span' }, { status: 409 });
  }

  const grounding: RegistryWeekLite[] = signed.map(w => ({
    week_number: w.week_number, topic_label: w.topic_label,
    objectives: w.objectives as RegistryWeekLite['objectives'],
  }));

  const out = await engine.generate(std, {
    weeks: grounding, yearGroup: klass.year_group, subjectId: klass.subject_id, weekFrom, weekTo,
  }, user.id) as { content: PackContent; usage: unknown };
  const content = out.content;

  const key = packWorkKey({ subjectId: klass.subject_id, yearGroup: klass.year_group, academicYear: '2026-27', weekFrom, refs: content.objective_refs });

  const { data: pack } = await db.from('study_pack').insert({
    work_key: key, academic_year: '2026-27', year_group: klass.year_group, subject_id: klass.subject_id,
    class_id: classId, week_from: weekFrom, week_to: weekTo, title: content.title,
    objective_refs: content.objective_refs, content, author_id: user.id, status: 'draft',
  }).select('id').single();

  // Render the interactive HTML and store it. Like the planner, this never blocks
  // the response if it fails — the pack is saved and can be re-rendered.
  const render = pack ? await storeArtefact(std, pack.id) : null;
  if (render?.ok && pack) {
    await db.from('study_pack').update({ storage_path: render.path }).eq('id', pack.id);
  }

  await audit(user.id, 'studypack.create', 'study_pack', pack?.id, { weeks: `${weekFrom}-${weekTo}`, refs: content.objective_refs.length });

  return NextResponse.json({
    studyPackId: pack?.id ?? null,
    title: content.title,
    units: content.units.map(u => ({ label: u.unit_label, topics: u.topics.length })),
    refs: content.objective_refs,
    glossary: content.glossary.length,
    render,
    usage: out.usage,
  });
}

export async function GET(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('studyPackId');
  if (!id) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });
  // reuse=1 means a colleague opened this approved pack unchanged from the bank —
  // that is what reuse_count ranks the bank by, so count it here (and only here,
  // never on the author opening their own fresh pack).
  const reuse = req.nextUrl.searchParams.get('reuse') === '1';

  const { data: pack } = await db.from('study_pack')
    .select('storage_path, title, reuse_count, approved').eq('id', id).maybeSingle();

  if (reuse && pack?.approved) {
    await db.from('study_pack').update({ reuse_count: (pack.reuse_count ?? 0) + 1 }).eq('id', id);
    await audit(user.id, 'studypack.reuse', 'study_pack', id);
  }

  const path = pack?.storage_path ?? `study_pack/${id}.html`;
  const { data: signed } = await db.storage.from('artefacts').createSignedUrl(path, 60 * 60);
  return NextResponse.json({ title: pack?.title ?? null, path, url: signed?.signedUrl ?? null });
}
