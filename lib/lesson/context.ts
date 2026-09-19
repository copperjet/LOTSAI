/**
 * Assembling what a lesson is built from.
 *
 * Shared by /api/lesson/match and /api/lesson/generate, because the two have to
 * agree: the bank search is only useful if it searches on the same objective
 * references the generator is about to use. Doing it twice in two routes is how
 * a "no match found" turns into a duplicate of a colleague's approved lesson.
 *
 * Every one of these steps is deterministic. There is no model call anywhere in
 * this file: objectives come out of the registry, a teacher's own typed
 * objectives are matched to it by trigram similarity, and their uploaded
 * material was already extracted to text by the ingest routes.
 */
import { admin } from '@/lib/supabase';
import type { PackObjective } from '@/lib/studypack/schema';
import { fromRegistry, matchToRegistry } from '@/lib/studypack/objectives';
import { publishedActivities } from '@/lib/schemeOfWork';

/** The one academic year this pilot runs in, as every other route spells it. */
export const YEAR = '2026-27';

export interface LessonAsk {
  classId?: string | null;
  subjectId?: string | null;
  yearGroup?: string | null;
  weekNumber?: number | null;
  semester?: number | null;
  topic?: string | null;
  subtopic?: string | null;
  durationMinutes?: number | null;
  /** Objectives the teacher typed, one per line. */
  objectives?: string[] | null;
  keyQuestion?: string | null;
  priorKnowledge?: string | null;
  context?: string | null;
  approach?: string | null;
  /** One uploaded or pasted source. Kept for callers that send only one. */
  sourceUploadId?: string | null;
  /**
   * Everything the teacher handed over - a PDF, a photographed page and some
   * pasted notes arrive as separate source_upload rows, one per ingest call.
   */
  sourceUploadIds?: string[] | null;
}

/** Past this many sources the prefix is the teacher's material and nothing else. */
const MAX_SOURCES = 6;

export interface LessonContext {
  classId: string | null;
  className: string | null;
  subjectId: string;
  subjectName: string;
  yearGroup: string;
  weekNumber: number | null;
  semester: number | null;
  topic: string;
  subtopic: string | null;
  durationMinutes: number;
  objectives: PackObjective[];
  curriculum: string | null;
  activities: string | null;
  sourceText: string | null;
  /** Set when the lesson could not be grounded. The UI shows the message. */
  blocked?: { code: string; message: string };
}

/** Durations the picker offers. Anything else a teacher sends is clamped to this range. */
export const DURATIONS = [30, 40, 60, 80, 90] as const;
const MIN_DURATION = 15;
const MAX_DURATION = 180;

export function clampDuration(n: unknown): number {
  const v = Math.round(Number(n) || 60);
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, v));
}

/**
 * Everything the generator needs, resolved from the database and the ask.
 *
 * Three ways in, in order of how much the school stands behind the result:
 *   1. a signed-off curriculum week - the objectives are the registry's own;
 *   2. objectives the teacher typed, matched back to the registry by text so
 *      the ones that exist keep the curriculum's wording and the ones that do
 *      not are carried verbatim and flagged;
 *   3. neither, in which case the lesson is built from the topic alone and the
 *      gate says so.
 *
 * A lesson is deliberately allowed on all three. A planner is not - a week that
 * has not been signed off cannot be planned - but a teacher preparing tomorrow's
 * lesson on a topic the registry has not caught up with still has a lesson to
 * teach, and refusing them is how a tool stops being used.
 */
export async function buildContext(ask: LessonAsk): Promise<LessonContext> {
  const db = admin();

  let classId = ask.classId ?? null;
  let className: string | null = null;
  let subjectId = String(ask.subjectId ?? '').trim();
  let yearGroup = String(ask.yearGroup ?? '').trim();

  if (classId) {
    const { data: klass } = await db.from('klass')
      .select('id, name, year_group, subject_id').eq('id', classId).maybeSingle();
    if (!klass) {
      return blocked(ask, 'unknown_class', 'That class is not one the school has on record.');
    }
    className = (klass.name ?? null) as string | null;
    subjectId = klass.subject_id as string;
    yearGroup = klass.year_group as string;
  } else {
    classId = null;
  }

  if (!subjectId || !yearGroup) {
    return blocked(ask, 'no_class',
      'Choose a class, or say which subject and year group the lesson is for.');
  }

  const { data: subject } = await db.from('subject')
    .select('id, name').eq('id', subjectId).maybeSingle();
  const subjectName = (subject?.name as string | undefined) ?? subjectId;

  const semester = ask.semester === 2 ? 2 : ask.semester === 1 ? 1 : null;
  const weekNumber = Number.isFinite(Number(ask.weekNumber)) && Number(ask.weekNumber) > 0
    ? Math.round(Number(ask.weekNumber)) : null;

  // ---- objectives, by whichever of the three routes applies
  let objectives: PackObjective[] = [];
  let topic = String(ask.topic ?? '').trim();
  let curriculum: string | null = null;

  if (weekNumber) {
    const q = db.from('curriculum_week')
      .select('week_number, topic_label, objectives, signed_off_at')
      .eq('year_group', yearGroup).eq('subject_id', subjectId)
      .eq('academic_year', YEAR).eq('week_number', weekNumber);
    const { data: week } = await (semester ? q.eq('semester', semester) : q).maybeSingle();
    if (week) {
      objectives = fromRegistry((week.objectives ?? []) as { ref: string | null; text: string }[]);
      if (!topic) topic = (week.topic_label as string) ?? '';
      curriculum = `Curriculum week ${weekNumber}${week.signed_off_at ? '' : ' (not yet signed off)'}`;
    }
  }

  const typed = (ask.objectives ?? []).map(o => String(o ?? '').trim()).filter(Boolean);
  if (typed.length) {
    // The teacher's own wording, matched back to the registry. Where it matches,
    // the registry's wording wins: the curriculum's words are the school's.
    const matched = await matchToRegistry(typed, subjectId, yearGroup);
    const seen = new Set(objectives.map(o => o.ref ?? o.text));
    for (const m of matched) {
      const key = m.ref ?? m.text;
      if (!seen.has(key)) { seen.add(key); objectives.push(m); }
    }
  }

  if (!topic) {
    return blocked(ask, 'no_topic', 'Say what the lesson is about.');
  }

  // ---- the school's own activities for these objectives
  let activities: string | null = null;
  if (objectives.length) {
    try {
      const published = await publishedActivities(subjectId, yearGroup, objectives, topic);
      const lines = published.flatMap(p => [
        `  ${p.key}${p.objective_text ? ` - ${p.objective_text}` : ''}`,
        ...p.activities.map(a => `    activity: ${a}`),
        ...p.resources.map(r => `    resource: ${r}`),
      ]);
      if (lines.length) activities = lines.join('\n');
    } catch {
      /* the scheme of work is not loaded for every subject, and that is fine */
    }
  }

  // ---- the teacher's own material
  let sourceText: string | null = null;
  const ids = [...new Set([
    ...(ask.sourceUploadIds ?? []),
    ...(ask.sourceUploadId ? [ask.sourceUploadId] : []),
  ].filter(Boolean))].slice(0, MAX_SOURCES);
  if (ids.length) {
    try {
      const { data: rows } = await db.from('source_upload')
        .select('id, filename, extracted').in('id', ids);
      // In the order the teacher attached them, each under its own name, so the
      // model can tell a worked example from a scheme of work.
      const parts = ids.map(id => {
        const row = (rows ?? []).find(r => r.id === id);
        const text = (row?.extracted as { text?: string } | null)?.text?.trim();
        return text ? `=== ${row?.filename ?? 'Pasted notes'} ===\n${text}` : null;
      }).filter(Boolean) as string[];
      sourceText = parts.join('\n\n') || null;
    } catch {
      /* an upload we cannot read is a lesson without it, not a failed lesson */
    }
  }

  return {
    classId, className, subjectId, subjectName, yearGroup,
    weekNumber, semester,
    topic,
    subtopic: String(ask.subtopic ?? '').trim() || null,
    durationMinutes: clampDuration(ask.durationMinutes),
    objectives,
    curriculum,
    activities,
    sourceText,
  };
}

function blocked(ask: LessonAsk, code: string, message: string): LessonContext {
  return {
    classId: ask.classId ?? null, className: null,
    subjectId: String(ask.subjectId ?? ''), subjectName: '',
    yearGroup: String(ask.yearGroup ?? ''),
    weekNumber: null, semester: null,
    topic: String(ask.topic ?? ''), subtopic: null,
    durationMinutes: clampDuration(ask.durationMinutes),
    objectives: [], curriculum: null, activities: null, sourceText: null,
    blocked: { code, message },
  };
}
