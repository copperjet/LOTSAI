import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { packWorkKey, type PackContent, type RegistryWeekLite } from '@/lib/studypack';
import type { Objective } from '@/lib/planner';
import { storeArtefact } from '@/lib/pdf/store';

export const runtime = 'nodejs';
export const maxDuration = 90;

/**
 * POST /api/studypack/from-upload  { uploadId }
 *
 * Turn a reconciled upload into a study pack. The upload has already been matched
 * against the registry by /api/ingest/upload; here only the *resolved* references
 * seed the pack — the objectives are re-read from curriculum_week, never from the
 * file's own words. Unresolved codes are reported back and never used. This is the
 * founding rule (main spec §4): objectives are retrieved, never generated, and a
 * code the school's curriculum does not hold cannot enter an artefact.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { uploadId } = await req.json();
  if (!uploadId) return NextResponse.json({ error: 'uploadId required' }, { status: 400 });

  const { data: upload } = await db.from('source_upload')
    .select('id, filename, subject_id, year_group, reconciled').eq('id', uploadId).maybeSingle();
  if (!upload) return NextResponse.json({ error: 'Unknown upload' }, { status: 404 });

  const reconciled = (upload.reconciled ?? {}) as { resolved?: string[]; unresolved?: string[] };
  const resolvedRefs = reconciled.resolved ?? [];
  const unresolved = reconciled.unresolved ?? [];
  if (!resolvedRefs.length) {
    return NextResponse.json({
      error: 'nothing_resolved',
      message: `None of the objectives in ${upload.filename} are in the ${upload.year_group} ${upload.subject_id} curriculum, so there is nothing to build a pack from.`,
      unresolved,
    }, { status: 409 });
  }

  // Re-read the objectives from the registry the school actually holds — the file's
  // wording is never used. Group the resolved refs back into their curriculum weeks.
  const { data: weeks } = await db.from('curriculum_week')
    .select('week_number, topic_label, objectives')
    .eq('subject_id', upload.subject_id).eq('year_group', upload.year_group).eq('academic_year', '2026-27')
    .order('week_number');

  const want = new Set(resolvedRefs);
  const byWeek = new Map<number, RegistryWeekLite>();
  for (const w of weeks ?? []) {
    for (const o of (w.objectives as Objective[]) ?? []) {
      if (!o.ref || !want.has(o.ref)) continue;
      let bucket = byWeek.get(w.week_number);
      if (!bucket) { bucket = { week_number: w.week_number, topic_label: w.topic_label, objectives: [] }; byWeek.set(w.week_number, bucket); }
      bucket.objectives.push(o);
    }
  }

  const grounding = [...byWeek.values()].sort((a, b) => a.week_number - b.week_number);
  if (!grounding.length) {
    // The refs were resolved when uploaded, but the registry no longer holds them.
    return NextResponse.json({
      error: 'stale_refs',
      message: 'The curriculum has changed since this file was read. Send it again so it can be checked afresh.',
    }, { status: 409 });
  }

  const weekNumbers = grounding.map(w => w.week_number);
  const weekFrom = Math.min(...weekNumbers);
  const weekTo = Math.max(...weekNumbers);

  const workflow = await engine.resolveWorkflow('study_pack');
  const std = workflow.standard;

  const out = await engine.generate(std, {
    weeks: grounding, yearGroup: upload.year_group, subjectId: upload.subject_id, weekFrom, weekTo,
  }, user.id) as { content: PackContent; usage: unknown };
  const content = out.content;

  const key = packWorkKey({ subjectId: upload.subject_id, yearGroup: upload.year_group, academicYear: '2026-27', weekFrom, refs: content.objective_refs });

  const { data: pack } = await db.from('study_pack').insert({
    work_key: key, academic_year: '2026-27', year_group: upload.year_group, subject_id: upload.subject_id,
    class_id: null, week_from: weekFrom, week_to: weekTo, title: content.title,
    objective_refs: content.objective_refs, content, author_id: user.id, status: 'draft',
  }).select('id').single();

  const render = pack ? await storeArtefact(std, pack.id) : null;
  if (render?.ok && pack) {
    await db.from('study_pack').update({ storage_path: render.path }).eq('id', pack.id);
  }

  await audit(user.id, 'studypack.from_upload', 'study_pack', pack?.id,
    { uploadId, resolved: resolvedRefs.length, unresolved: unresolved.length, refs: content.objective_refs.length });

  return NextResponse.json({
    studyPackId: pack?.id ?? null,
    title: content.title,
    units: content.units.map(u => ({ label: u.unit_label, topics: u.topics.length })),
    refs: content.objective_refs,
    glossary: content.glossary.length,
    fromUpload: { filename: upload.filename, resolved: resolvedRefs.length, unresolved },
    render,
  });
}
