import { NextRequest, NextResponse } from 'next/server';
import { admin, audit, currentUser } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';
import { viewUrl } from '@/lib/artefactUrl';
import { sourceCounts } from '@/lib/studypack/objectives';
import { pickTheme } from '@/lib/studypack/themes';
import { buildContext, YEAR, type LessonAsk } from '@/lib/lesson/context';
import { lessonWorkKey } from '@/lib/lesson/match';
import { bandFor } from '@/lib/lesson/ages';
import {
  insertLesson, lessonSummary, mayRead, readLesson, saveDeck, snapshot,
} from '@/lib/lesson/persist';
import { allowedFor, checkDeck, gateLesson, repairRequests } from '@/lib/lesson/gate';
import { repairLessonSlides, type GenerateLessonInput, type GenerateLessonResult } from '@/lib/lesson/generate';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/lesson/generate
 * GET  /api/lesson/generate?lessonId=<id>   - the whole deck, for the editor
 *
 * Build a lesson: the slides, the teaching guide, the timing and the quality
 * check. Runs through the same engine the planner, study pack, worksheet and
 * homework do - a different Standard, the same pipeline.
 *
 * WHAT THIS ROUTE DOES NOT DO is render the PowerPoint or the PDF. Generation
 * is already three model calls inside one request, and a Chromium cold start on
 * the end of that is how a teacher meets the 300 second ceiling. The deck's own
 * HTML is stored here because it is instant; the exports are built when they are
 * asked for (/api/lesson/pptx) and on approval.
 */
export async function POST(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const ask = (await req.json()) as LessonAsk & { mode?: string };

  const ctx = await buildContext(ask);
  if (ctx.blocked) {
    return NextResponse.json({ blocked: ctx.blocked.code, message: ctx.blocked.message });
  }

  // Can the lesson be stored at all? Asked before a single model call, because
  // the first run against an unapplied 0028 generated a whole deck - three paid
  // calls - and only then found there was nowhere to put it.
  const probe = await db.from('lesson').select('id').limit(0);
  if (probe.error) {
    console.error(`[lesson] lesson table unavailable: ${probe.error.code} ${probe.error.message}`);
    return NextResponse.json({
      error: 'lesson_unavailable',
      message: 'Lessons are not switched on for this school yet. The database needs migration 0028.',
    }, { status: 503 });
  }

  const { standard: std } = await engine.resolveWorkflow('lesson');
  const refs = ctx.objectives.map(o => o.ref).filter(Boolean) as string[];
  const workKey = lessonWorkKey({
    subjectId: ctx.subjectId, yearGroup: ctx.yearGroup, academicYear: YEAR,
    weekNumber: ctx.weekNumber, refs, durationMinutes: ctx.durationMinutes, topic: ctx.topic,
  });

  // The destructive-write guard every generator here carries: regenerating over
  // approved work would replace something a colleague may already be reusing.
  const { data: prior } = await db.from('lesson')
    .select('id, status, approved').eq('work_key', workKey).eq('author_id', user.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const OPEN = ['draft', 'returned'];
  if (prior && !OPEN.includes(prior.status as string)) {
    return NextResponse.json({
      error: 'not_open',
      message: 'You have already approved a lesson for this. Regenerating would replace work '
        + 'your colleagues may be reusing. Open it and change it instead.',
      lessonId: prior.id,
      status: prior.status,
    }, { status: 409 });
  }

  const input: GenerateLessonInput = {
    subjectId: ctx.subjectId,
    subjectName: ctx.subjectName,
    yearGroup: ctx.yearGroup,
    className: ctx.className,
    academicYear: YEAR,
    semester: ctx.semester,
    weekNumber: ctx.weekNumber,
    topic: ctx.topic,
    subtopic: ctx.subtopic,
    durationMinutes: ctx.durationMinutes,
    approach: ask.approach ?? null,
    keyQuestion: ask.keyQuestion ?? null,
    priorKnowledge: ask.priorKnowledge ?? null,
    context: ask.context ?? null,
    objectives: ctx.objectives,
    curriculum: ctx.curriculum,
    sourceText: ctx.sourceText,
    activities: ctx.activities,
    workKey,
  };

  let out: GenerateLessonResult;
  try {
    out = await engine.generate(std, input, user.id) as unknown as GenerateLessonResult;
  } catch (e) {
    console.error(`[lesson] generation failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({
      error: 'generate_failed',
      message: 'The lesson could not be written just now. Try again in a moment.',
    }, { status: 502 });
  }

  const deck = out.deck;
  let calls = out.calls;

  // ---- quality control, before the teacher ever sees it
  const band = bandFor(ctx.yearGroup);
  let gate = checkDeck(deck, band);
  let repaired = 0;

  if (gate.blocking) {
    const requests = repairRequests(deck, gate, allowedFor(deck));
    if (requests.length) {
      try {
        const fix = await repairLessonSlides(deck, requests, user.id);
        repaired = fix.changed;
        if (fix.usage) calls++;
        // Re-checked once. If it still blocks the deck is saved anyway and the
        // teacher is shown what is wrong - an editor they can fix it in beats a
        // loop they are waiting on.
        gate = checkDeck(deck, band);
      } catch (e) {
        console.error(`[lesson] repair failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ---- store
  const row = await insertLesson({
    author_id: user.id,
    class_id: ctx.classId,
    subject_id: ctx.subjectId,
    year_group: ctx.yearGroup,
    academic_year: YEAR,
    semester: ctx.semester,
    week_number: ctx.weekNumber,
    topic: ctx.topic,
    subtopic: ctx.subtopic,
    duration_minutes: ctx.durationMinutes,
    approach: ask.approach ?? null,
    title: deck.title,
    content: deck,
    objective_refs: deck.objective_refs,
    objective_sources: deck.objectives,
    work_key: workKey,
    theme: deck.theme ?? pickTheme(ctx.subjectId, workKey).id,
    status: 'draft',
    source_upload_id: ask.sourceUploadId ?? ask.sourceUploadIds?.[0] ?? null,
  });

  if (!row) {
    return NextResponse.json({
      error: 'lesson_unavailable',
      message: 'Lessons are not switched on for this school yet. The database needs migration 0028.',
    }, { status: 503 });
  }

  await snapshot(row.id, deck, null, user.id);

  // The deck's own HTML, stored now because it is instant and needs no browser.
  const render = await storeArtefact(std, row.id);
  if (render.ok) await saveDeck(row.id, deck, { storage_path: render.path });

  await audit(user.id, 'lesson.create', 'lesson', row.id, {
    slides: deck.slides.length, minutes: ctx.durationMinutes, calls,
    refs: deck.objective_refs.length, repaired,
  });

  return NextResponse.json({
    lessonId: row.id,
    ...lessonSummary(deck),
    sources: sourceCounts(deck.objectives),
    gate,
    repaired,
    calls,
    failedGroups: out.failedGroups,
    editorUrl: `/lesson/${row.id}`,
    url: viewUrl('lesson', row.id),
    pptxUrl: viewUrl('lesson-pptx', row.id),
    render,
  });
}

/** The whole deck, for the editor. */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('lessonId');
  if (!id) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });

  const row = await readLesson(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!mayRead(row, user)) {
    return NextResponse.json({ error: 'not_yours' }, { status: 403 });
  }

  return NextResponse.json({
    lessonId: row.id,
    deck: row.content,
    status: row.status,
    approved: row.approved,
    renderNote: row.render_note,
    driveLink: row.drive_link,
    mine: row.author_id === user.id,
    gate: await gateLesson(row.id),
    url: viewUrl('lesson', row.id),
    pptxUrl: viewUrl('lesson-pptx', row.id),
    pdfUrl: viewUrl('lesson-pdf', row.id),
  });
}
