import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { homeworkWorkKey, type HomeworkContent, type RegistryWeekLite } from '@/lib/homework';
import { storeArtefact } from '@/lib/pdf/store';
import { viewUrl } from '@/lib/artefactUrl';

export const runtime = 'nodejs';
export const maxDuration = 90;

/**
 * POST /api/homework/generate  { classId, weekNumber }
 * GET  /api/homework/generate?homeworkId=<id>   — a URL for the rendered document
 *
 * Set homework for one class in one signed-off week, store it, and render the document
 * a learner works on. Objectives are retrieved from the registry; the sections, the
 * questions, the marks and the answers are generated. Runs through the same engine the
 * planner, study pack and worksheet do - a different Standard, the same pipeline.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const { classId, weekNumber } = await req.json();

  const { standard: std } = await engine.resolveWorkflow('homework');

  const { data: klass } = await db.from('klass').select('*').eq('id', classId).single();
  if (!klass) return NextResponse.json({ error: 'Unknown class' }, { status: 404 });

  const { data: week } = await db.from('curriculum_week')
    .select('week_number, topic_label, objectives, signed_off_at')
    .eq('year_group', klass.year_group).eq('subject_id', klass.subject_id).eq('academic_year', '2026-27')
    .eq('week_number', weekNumber).maybeSingle();

  if (!week) {
    return NextResponse.json({ blocked: 'no_registry',
      message: `The curriculum has nothing for ${klass.year_group} ${klass.subject_id}, week ${weekNumber} yet.` });
  }
  // Homework is set only from a signed-off week (Addendum C §C7), the same rule the
  // worksheet and the study pack follow.
  if (!week.signed_off_at) {
    return NextResponse.json({ blocked: 'not_signed_off',
      message: `Week ${weekNumber} of ${klass.year_group} ${klass.subject_id} is waiting for a Head of Department to sign it off. Homework is only set from weeks that have been.` });
  }

  const grounding: RegistryWeekLite = {
    week_number: week.week_number, topic_label: week.topic_label,
    objectives: week.objectives as RegistryWeekLite['objectives'],
  };

  const out = await engine.generate(std, {
    week: grounding, yearGroup: klass.year_group, subjectId: klass.subject_id, weekNumber,
  }, user.id) as { content: HomeworkContent; usage: unknown };
  const content = out.content;

  const key = homeworkWorkKey({
    subjectId: klass.subject_id, yearGroup: klass.year_group,
    academicYear: '2026-27', weekNumber, refs: content.objective_refs,
  });

  const { data: hw, error } = await db.from('homework').insert({
    work_key: key, academic_year: '2026-27', year_group: klass.year_group, subject_id: klass.subject_id,
    class_id: classId, week_number: weekNumber, title: content.title,
    objective_refs: content.objective_refs, content, author_id: user.id, status: 'draft',
  }).select('id').single();

  if (error || !hw) {
    // Almost certainly migration 0015 not applied yet. Say which, rather than a code.
    return NextResponse.json({
      error: 'not_ready',
      message: 'Homework is not switched on for this school yet. The database needs migration 0015.',
    }, { status: 503 });
  }

  // Render the document and store it. Like the study pack, a failed render never
  // blocks the response - the homework is saved and can be re-rendered.
  const render = await storeArtefact(std, hw.id);
  if (render.ok) await db.from('homework').update({ storage_path: render.path }).eq('id', hw.id);

  await audit(user.id, 'homework.create', 'homework', hw.id,
    { week: weekNumber, refs: content.objective_refs.length });

  const questions = (content.sections ?? []).reduce((n, s) => n + (s.questions?.length ?? 0), 0);
  return NextResponse.json({
    homeworkId: hw.id,
    title: content.title,
    sections: content.sections.length,
    questions,
    marks: (content.sections ?? []).flatMap(s => s.questions ?? []).reduce((n, q) => n + (q.marks || 0), 0),
    minutes: content.duration_minutes,
    refs: content.objective_refs,
    render,
  });
}

export async function GET(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('homeworkId');
  if (!id) return NextResponse.json({ error: 'homeworkId required' }, { status: 400 });
  // reuse=1 means a colleague opened this approved homework unchanged from the bank -
  // count it, and only here, never on the author opening their own fresh one.
  const reuse = req.nextUrl.searchParams.get('reuse') === '1';

  const { data: hw } = await db.from('homework')
    .select('storage_path, title, reuse_count, approved').eq('id', id).maybeSingle();

  if (reuse && hw?.approved) {
    await db.from('homework').update({ reuse_count: (hw.reuse_count ?? 0) + 1 }).eq('id', id);
    await audit(user.id, 'homework.reuse', 'homework', id);
  }

  const path = hw?.storage_path ?? `homework/${id}.html`;
  return NextResponse.json({ title: hw?.title ?? null, path, url: viewUrl('homework', id) });
}
