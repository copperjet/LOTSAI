import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { packWorkKey } from '@/lib/studypack';
import type { GeneratePackV2Input, RegistryWeekLite } from '@/lib/studypack/generate';
import type { Objective } from '@/lib/planner';
import type { PackObjective, PackV2 } from '@/lib/studypack/schema';
import { extractStatedOutcomes, matchToRegistry, fromRegistry, sourceCounts } from '@/lib/studypack/objectives';
import { insertPack, packSummary } from '@/lib/studypack/persist';
import { storeArtefact } from '@/lib/pdf/store';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/studypack/from-upload  { uploadId }
 *
 * Turn a reconciled upload into a study pack.
 *
 * Two doors, tried in that order. If the file names objective codes, those are the
 * pack's objectives and they are re-read from curriculum_week, never from the file's
 * own words — the founding rule (main spec §4): a code the school's curriculum does
 * not hold cannot enter an artefact.
 *
 * If it names none — which is the ordinary case for a document like "ART LS1 STUDY
 * PACK S1 2026-2027.pdf", whose objectives are prose — the outcomes it states are
 * read and matched against the registry by text. A match keeps the *registry's*
 * wording and code; anything unmatched is carried verbatim, marked as coming from the
 * file, and reported back for a human to confirm. Refusing to build (the old 409)
 * made this path useless for the documents teachers actually have, and refusing was
 * never what protected the registry — provenance is.
 *
 * Either way the pack is built from the teacher's own material, which is what the
 * upload extracted and stored.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { uploadId } = await req.json();
  if (!uploadId) return NextResponse.json({ error: 'uploadId required' }, { status: 400 });

  const { data: upload } = await db.from('source_upload')
    .select('id, filename, subject_id, year_group, reconciled, extracted').eq('id', uploadId).maybeSingle();
  if (!upload) return NextResponse.json({ error: 'Unknown upload' }, { status: 404 });

  const reconciled = (upload.reconciled ?? {}) as { resolved?: string[]; unresolved?: string[] };
  const extracted = (upload.extracted ?? {}) as { text?: string };
  const resolvedRefs = reconciled.resolved ?? [];
  const unresolved = reconciled.unresolved ?? [];
  const text = String(extracted.text ?? '');

  const workflow = await engine.resolveWorkflow('study_pack');
  const std = workflow.standard;

  // The subject's name, not its code, is what goes on the page furniture.
  const { data: subject } = await db.from('subject').select('name').eq('id', upload.subject_id).maybeSingle();
  const subjectName = subject?.name ?? null;

  let input: GeneratePackV2Input;
  let sourceKind: 'registry' | 'document';
  let weekFrom = 0, weekTo = 0;

  if (resolvedRefs.length) {
    // ---- codes resolved: the registry supplies the objectives, grouped by week ----
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

    const nums = grounding.map(w => w.week_number);
    weekFrom = Math.min(...nums); weekTo = Math.max(...nums);
    sourceKind = 'document';
    // The registry objectives lead, but the teacher's own material is still what the
    // pack is written from — that is the whole point of uploading it.
    input = {
      source: {
        kind: 'document', text, filename: upload.filename,
        objectives: fromRegistry(grounding.flatMap(w => w.objectives)),
      },
      subjectId: upload.subject_id, yearGroup: upload.year_group, subjectName,
    };
  } else {
    // ---- no codes: read the outcomes the file states and match them by text ----
    if (!text.trim()) {
      return NextResponse.json({
        error: 'no_text',
        message: `Nothing could be read out of ${upload.filename}. If it is a photograph, take it again in better light; if it is a scan, send the original file.`,
      }, { status: 409 });
    }
    const outcomes = await extractStatedOutcomes(text, user.id);
    const objectives: PackObjective[] = await matchToRegistry(outcomes, upload.subject_id, upload.year_group);
    if (!objectives.length) {
      return NextResponse.json({
        error: 'no_objectives',
        message: `${upload.filename} states no learning outcomes I can find, and names no objective codes, so there is nothing to build a pack around. Add what learners should be able to do by the end, and send it again.`,
        unresolved,
      }, { status: 409 });
    }
    sourceKind = 'document';
    input = {
      source: { kind: 'document', text, filename: upload.filename, objectives },
      subjectId: upload.subject_id, yearGroup: upload.year_group, subjectName,
    };
  }

  const out = await engine.generate(std, input, user.id) as { content: PackV2; usage: unknown };
  const content = out.content;

  const key = packWorkKey({
    subjectId: upload.subject_id, yearGroup: upload.year_group,
    academicYear: '2026-27', weekFrom, refs: content.objective_refs,
  });

  const pack = await insertPack({
    work_key: key, academic_year: '2026-27', year_group: upload.year_group, subject_id: upload.subject_id,
    class_id: null, week_from: weekFrom, week_to: weekTo, title: content.title,
    objective_refs: content.objective_refs, content, author_id: user.id, status: 'draft',
  }, { content_version: 2, layout: content.layout, source_kind: sourceKind, objective_sources: content.objectives });

  const render = pack ? await storeArtefact(std, pack.id) : null;
  if (render?.ok && pack) {
    await db.from('study_pack').update({ storage_path: render.path }).eq('id', pack.id);
  }

  const counts = sourceCounts(content.objectives);
  await audit(user.id, 'studypack.from_upload', 'study_pack', pack?.id,
    { uploadId, resolved: resolvedRefs.length, unresolved: unresolved.length, ...counts });

  return NextResponse.json({
    studyPackId: pack?.id ?? null,
    ...packSummary(content),
    objectiveSources: counts,
    // The teacher has to be able to see exactly which objectives are not the school's.
    fromFile: content.objectives.filter(o => o.source !== 'registry')
      .map(o => ({ ref: o.ref, text: o.text, source: o.source })),
    fromUpload: { filename: upload.filename, resolved: resolvedRefs.length, unresolved },
    render,
  });
}
