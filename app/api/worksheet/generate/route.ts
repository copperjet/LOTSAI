import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { worksheetWorkKey, type WorksheetContent, type RegistryWeekLite } from '@/lib/worksheet';
import { storeArtefact } from '@/lib/pdf/store';
import { viewUrl } from '@/lib/artefactUrl';

export const runtime = 'nodejs';
export const maxDuration = 90;

/**
 * POST /api/worksheet/generate  { classId, weekNumber }
 * GET  /api/worksheet/generate?worksheetId=<id>   — a signed URL for the PDF
 *
 * Generate a differentiated worksheet for one class in one signed-off week, store
 * it, and render its printable PDF to the artefacts bucket. Objectives are
 * retrieved from the registry; the tasks and their three tiers are generated.
 * Runs through the same engine the planner and study pack do — a different
 * Standard, the same pipeline.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { classId, weekNumber } = await req.json();

  const workflow = await engine.resolveWorkflow('worksheet');
  const std = workflow.standard;

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
  // A worksheet is built only from a signed-off week (Addendum C §C7), the same
  // rule the study pack follows.
  if (!week.signed_off_at) {
    return NextResponse.json({ blocked: 'not_signed_off',
      message: `Week ${weekNumber} of ${klass.year_group} ${klass.subject_id} is not signed off. A worksheet is built only from a signed-off week.` });
  }

  const grounding: RegistryWeekLite = {
    week_number: week.week_number, topic_label: week.topic_label,
    objectives: week.objectives as RegistryWeekLite['objectives'],
  };

  const out = await engine.generate(std, {
    week: grounding, yearGroup: klass.year_group, subjectId: klass.subject_id, weekNumber,
  }, user.id) as { content: WorksheetContent; usage: unknown };
  const content = out.content;

  const key = worksheetWorkKey({ subjectId: klass.subject_id, yearGroup: klass.year_group, academicYear: '2026-27', weekNumber, refs: content.objective_refs });

  const { data: ws } = await db.from('worksheet').insert({
    work_key: key, academic_year: '2026-27', year_group: klass.year_group, subject_id: klass.subject_id,
    class_id: classId, week_number: weekNumber, title: content.title,
    objective_refs: content.objective_refs, content, author_id: user.id, status: 'draft',
  }).select('id').single();

  // Render the printable PDF and store it. Like the study pack, this never blocks
  // the response if it fails — the worksheet is saved and can be re-rendered.
  const render = ws ? await storeArtefact(std, ws.id) : null;
  if (render?.ok && ws) {
    await db.from('worksheet').update({ storage_path: render.path }).eq('id', ws.id);
  }

  await audit(user.id, 'worksheet.create', 'worksheet', ws?.id, { week: weekNumber, refs: content.objective_refs.length });

  return NextResponse.json({
    worksheetId: ws?.id ?? null,
    title: content.title,
    tasks: content.tasks.length,
    refs: content.objective_refs,
    render,
    usage: out.usage,
  });
}

export async function GET(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('worksheetId');
  if (!id) return NextResponse.json({ error: 'worksheetId required' }, { status: 400 });
  // reuse=1 means a colleague opened this approved worksheet unchanged from the
  // bank — count it, and only here, never on the author opening their own fresh one.
  const reuse = req.nextUrl.searchParams.get('reuse') === '1';

  const { data: ws } = await db.from('worksheet')
    .select('storage_path, title, reuse_count, approved').eq('id', id).maybeSingle();

  if (reuse && ws?.approved) {
    await db.from('worksheet').update({ reuse_count: (ws.reuse_count ?? 0) + 1 }).eq('id', id);
    await audit(user.id, 'worksheet.reuse', 'worksheet', id);
  }

  const path = ws?.storage_path ?? `worksheet/${id}.pdf`;
  return NextResponse.json({ title: ws?.title ?? null, path, url: viewUrl('worksheet', id) });
}
