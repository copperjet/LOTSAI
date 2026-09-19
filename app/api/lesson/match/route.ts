import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/supabase';
import { sourceCounts } from '@/lib/studypack/objectives';
import { buildContext, type LessonAsk } from '@/lib/lesson/context';
import { findLessonMatches, lessonWorkKey } from '@/lib/lesson/match';
import { bandFor } from '@/lib/lesson/ages';
import { profileFor } from '@/lib/lesson/profiles';
import { approachFrom, blueprint, timingLine } from '@/lib/lesson/architecture';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/lesson/match
 *
 * Search before generate. No model call: the bank offers only lessons a named
 * human approved, and the index is exact because objective references come out
 * of the registry rather than out of a model (lib/workkey.ts).
 *
 * It also answers the two questions a teacher asks before they commit to
 * generating: what will be in it, and will it fit. Both are arithmetic
 * (lib/lesson/architecture.ts), so both are free, and a teacher who has asked
 * for six objectives in forty minutes is told here rather than after paying for
 * a deck that quietly dropped four of them.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  const ask = (await req.json()) as LessonAsk;

  const ctx = await buildContext(ask);
  if (ctx.blocked) {
    return NextResponse.json({ blocked: ctx.blocked.code, message: ctx.blocked.message });
  }

  const band = bandFor(ctx.yearGroup);
  const profile = profileFor(ctx.subjectId, ctx.subjectName);
  const plan = blueprint({
    durationMinutes: ctx.durationMinutes,
    band,
    approach: approachFrom(ask.approach ?? null),
    objectiveCount: ctx.objectives.length,
  });

  const refs = ctx.objectives.map(o => o.ref).filter(Boolean) as string[];
  const matches = await findLessonMatches(
    ctx.subjectId, ctx.yearGroup, refs, ctx.durationMinutes,
  );

  const carried = ctx.objectives.slice(0, plan.objectiveBudget);
  const deferred = ctx.objectives.slice(plan.objectiveBudget);

  return NextResponse.json({
    workKey: lessonWorkKey({
      subjectId: ctx.subjectId, yearGroup: ctx.yearGroup, academicYear: '2026-27',
      weekNumber: ctx.weekNumber, refs, durationMinutes: ctx.durationMinutes, topic: ctx.topic,
    }),
    who: {
      className: ctx.className, subjectId: ctx.subjectId, subjectName: ctx.subjectName,
      yearGroup: ctx.yearGroup, ageBand: band.name, subjectProfile: profile.name,
    },
    topic: ctx.topic,
    subtopic: ctx.subtopic,
    durationMinutes: ctx.durationMinutes,
    objectives: carried.map(o => ({ ref: o.ref, text: o.text, source: o.source })),
    // Said out loud rather than dropped silently: a forty minute lesson cannot
    // teach six objectives, and the teacher decides what to do about it.
    deferred: deferred.map(o => ({ ref: o.ref, text: o.text })),
    sources: sourceCounts(ctx.objectives),
    plan: {
      slides: plan.slideBudget,
      minStudentSlides: plan.minStudentSlides,
      phases: plan.phases.map(p => ({ label: p.label, minutes: p.minutes, slides: p.slides })),
      summary: timingLine(plan.phases),
    },
    hasMaterial: !!ctx.sourceText,
    hasActivities: !!ctx.activities,
    matches: matches.map(m => ({
      id: m.id, title: m.title, why: m.why, mode: m.mode, tier: m.tier,
      author: m.author, reuseCount: m.reuse_count, minutes: m.duration_minutes,
      mine: m.author_id === user.id,
    })),
  });
}
