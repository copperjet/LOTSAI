import { call } from './claude';
import { admin } from './supabase';
import type { Objective } from './planner';
import { workKey, overlap } from './workkey';

/**
 * The Homework Standard — the third generated artefact.
 *
 * WHY IT EXISTS. Asked to "create a homework for my CP4A Mathematics class", LOTS AI
 * had nowhere to send the request: the router knew planners, worksheets and study
 * packs, so it fell through to lib/ask.ts, which answered it as though a homework were
 * a fact from the school's records and wrote the whole thing into the chat as prose.
 * Asked next to "put it on a document, make it interactive and colourful" - the one
 * half of that exchange this product is actually for - it returned the open-ended-work
 * boundary. Both halves were wrong, and the fix is a workflow, not a better refusal.
 *
 * WHY NOT A WORKSHEET. A worksheet is one task at three tiers - support, core,
 * extension - for a lesson a teacher is standing in. Homework is a paper a learner
 * does alone: sections, a time to finish it in, marks that add up, room to write, and
 * an answer key for whoever marks it. Same objectives, different document.
 *
 * Five parts, as Addendum C §C2 asks:
 *   1. Schema        — HOMEWORK_SCHEMA below.
 *   2. Render        — lib/homework/render_html.ts, which composes the study pack's own
 *                      block vocabulary rather than inventing a third page design.
 *   3. Non-negotiables — objectives retrieved verbatim, never written; every question
 *                      carries marks and answer space; an answer for every question;
 *                      no learner names; a stated duration.
 *   4. Quality gate  — gateHomework() below: deterministic, structural, free.
 *   5. Exemplars     — the rendered output is the style ground truth, as the study
 *                      pack's template is.
 */

export interface RegistryWeekLite {
  week_number: number; topic_label: string; objectives: Objective[];
}

const HOMEWORK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'intro', 'duration_minutes', 'sections', 'teacher_note'],
  properties: {
    title: { type: 'string' },
    intro: { type: 'string' },                         // one or two lines to the learner
    duration_minutes: { type: 'integer' },             // how long it should take
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['heading', 'instructions', 'objective_indexes', 'questions'],
        properties: {
          heading: { type: 'string' },
          instructions: { type: 'string' },
          // Indexes into the supplied objective list — the model selects, never
          // writes an objective. The same guard the planner, study pack and
          // worksheet carry.
          objective_indexes: { type: 'array', items: { type: 'integer' } },
          questions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['text', 'marks', 'answer_lines', 'answer'],
              properties: {
                text: { type: 'string' },
                marks: { type: 'integer' },
                answer_lines: { type: 'integer' },     // ruled lines to leave
                answer: { type: 'string' },            // for the key, never printed with the paper
              },
            },
          },
        },
      },
    },
    // What to do if a learner cannot get started, in the teacher's own register.
    teacher_note: { type: 'string' },
  },
} as const;

const SYSTEM = `You write homework for Lusaka Oaktree School, a Cambridge primary/lower-secondary school
in Zambia.

You are given the curriculum objectives for one week. You never write, reword, renumber or invent an
objective - you only choose which of the supplied objectives each section addresses, by index.

Homework is not a worksheet. It is done alone, at home, without a teacher to explain it, so:
- Every instruction must be followable by a learner of this age with nobody to ask.
- Build the paper in three or four short sections, easiest first, so a learner who is struggling
  still finishes something.
- Every question carries marks, and the marks add up to a sensible total for the time you set.
- Give answer_lines: 1 or 2 for recall, 4 or more for anything that needs explaining or working.
- Give the expected answer for every question. It is for the teacher's key and is never printed
  with the paper.
- Finish with a teacher_note saying what to reduce for a learner who cannot get started.

Write plain British English pitched at the year group. Never use a learner's name. Never include a
web address. Do not write anything a teacher or head of department would sign - no comments, no
marking, no grades.

Never use an em dash or an en dash. Use a plain hyphen.`;

export interface GenerateHomeworkInput {
  week: RegistryWeekLite;
  yearGroup: string; subjectId: string; weekNumber: number;
}

export interface HomeworkQuestion {
  text: string; marks: number; answer_lines: number; answer: string;
}
export interface HomeworkSection {
  heading: string; instructions: string;
  objectives: Objective[];
  questions: HomeworkQuestion[];
}
export interface HomeworkContent {
  title: string; intro: string; duration_minutes: number;
  sections: HomeworkSection[];
  teacher_note: string;
  objective_refs: string[];
}

/** Sensible bounds when the model gives a figure that would print badly. */
const MAX_ANSWER_LINES = 12;
const DEFAULT_DURATION = 45;

export async function generateHomework(
  input: GenerateHomeworkInput, userId: string,
): Promise<{ content: HomeworkContent; usage: unknown }> {
  // One flat, indexed objective list - the model tags into it, so an index always
  // resolves to a real registry objective.
  const flat: Objective[] = [];
  const cachedLines: string[] = [
    `CURRICULUM - ${input.yearGroup} ${input.subjectId}, week ${input.weekNumber}: ${input.week.topic_label}`,
  ];
  for (const o of input.week.objectives ?? []) {
    cachedLines.push(`  [${flat.length}] ${o.ref ? o.ref + ' - ' : ''}${o.text}`);
    flat.push(o);
  }

  const { data, usage } = await call<{
    title: string; intro: string; duration_minutes: number; teacher_note: string;
    sections: {
      heading: string; instructions: string; objective_indexes: number[];
      questions: HomeworkQuestion[];
    }[];
  }>({
    tier: 'standard',
    workflow: 'homework_create',
    userId,
    system: SYSTEM,
    cached: [cachedLines.join('\n')],
    longCache: true,
    prompt: `Write one homework for week ${input.weekNumber}, in three or four sections, to be done in `
      + `about forty-five minutes. Use only the objective indexes listed.`,
    schema: HOMEWORK_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 5000,
  });

  const seenRefs = new Set<string>();
  const sections = (data.sections ?? []).map(sec => {
    const objectives = (sec.objective_indexes ?? []).map(i => flat[i]).filter(Boolean);
    for (const o of objectives) if (o.ref) seenRefs.add(o.ref);
    return {
      heading: String(sec.heading ?? '').trim(),
      instructions: String(sec.instructions ?? '').trim(),
      objectives,
      questions: (sec.questions ?? []).filter(q => q?.text?.trim()).map(q => ({
        text: unnumber(String(q.text)),
        marks: Number.isFinite(q.marks) ? Math.max(0, Number(q.marks)) : 1,
        answer_lines: Number.isFinite(q.answer_lines)
          ? Math.min(MAX_ANSWER_LINES, Math.max(1, Number(q.answer_lines))) : 2,
        answer: String(q.answer ?? '').trim(),
      })),
    };
  }).filter(sec => sec.questions.length);

  return {
    content: {
      title: data.title, intro: data.intro ?? '',
      duration_minutes: Number.isFinite(data.duration_minutes) && data.duration_minutes > 0
        ? Math.round(data.duration_minutes) : DEFAULT_DURATION,
      sections, teacher_note: data.teacher_note ?? '',
      objective_refs: [...seenRefs].sort(),
    },
    usage,
  };
}

/** The renderer numbers questions itself, so a model that also numbers its own text
 *  prints "1. 1. Write the factors of 24." The study pack does the same (see
 *  lib/studypack/generate.ts). */
function unnumber(text: string): string {
  return String(text ?? '').replace(/^\s*\d{1,2}\s*[.)]\s+/, '').trim();
}

/** The work key for homework: one week, its objective set. artefact_type is what keeps
 *  it apart from a worksheet built on the same references. */
export function homeworkWorkKey(p: {
  subjectId: string; yearGroup: string; academicYear: string; weekNumber: number; refs: string[];
}): string {
  return workKey({
    artefactType: 'homework', subjectId: p.subjectId, yearGroup: p.yearGroup,
    academicYear: p.academicYear, weekNumber: p.weekNumber, refs: p.refs,
  });
}

/**
 * Search before generate, for homework. No model call - the bank offers only work a
 * named human approved (Addendum B), exactly as the worksheet's search does.
 */
export async function findHomeworkMatches(
  subjectId: string, yearGroup: string, refs: string[], excludeId?: string,
) {
  if (!refs.length) return [];
  try {
    const { data } = await admin().from('homework')
      .select('id, title, work_key, objective_refs, week_number, reuse_count, author_id, app_user:author_id(full_name)')
      .eq('subject_id', subjectId).eq('year_group', yearGroup).eq('approved', true);
    const want = [...refs].sort().join(',');
    return (data ?? [])
      .filter(h => h.id !== excludeId)
      .map(h => {
        const theirs = [...(h.objective_refs ?? [])].sort().join(',');
        const exact = theirs === want;
        return { ...h, tier: exact ? 1 : 4, mode: (exact ? 'reuse' : 'adapt') as 'reuse' | 'adapt' };
      })
      .filter(h => h.tier === 1 || overlap(refs, h.objective_refs ?? []) >= 0.6)
      .sort((a, b) => a.tier - b.tier || b.reuse_count - a.reuse_count);
  } catch {
    return [];   // pre-0015
  }
}

/**
 * The homework gate - the Standard's non-negotiables as deterministic checks over the
 * stored homework. Structural, so free and instant. Most are met by construction; a
 * gate is what makes that a guarantee rather than a hope.
 */
export async function gateHomework(homeworkId: string) {
  const db = admin();
  const { data: hw } = await db.from('homework').select('content').eq('id', homeworkId).single();
  const content = (hw?.content ?? {}) as HomeworkContent;
  const sections = content.sections ?? [];
  const questions = sections.flatMap(s => s.questions ?? []);
  const checks: { id: string; status: 'pass' | 'warn' | 'block'; title: string; detail: string }[] = [];

  checks.push(questions.length
    ? { id: 'questions', status: 'pass', title: 'The homework has questions',
        detail: `${questions.length} questions across ${sections.length} sections.` }
    : { id: 'questions', status: 'block', title: 'The homework has no questions',
        detail: 'Nothing was generated.' });

  const noAnswer = questions.filter(q => !q.answer?.trim()).length;
  checks.push(noAnswer
    ? { id: 'answers', status: 'warn', title: 'A question has no answer',
        detail: `${noAnswer} question(s) missing from the answer key.` }
    : { id: 'answers', status: 'pass', title: 'Every question has an answer',
        detail: 'The answer key is complete.' });

  const noMarks = questions.filter(q => !(q.marks > 0)).length;
  const total = questions.reduce((n, q) => n + (q.marks || 0), 0);
  checks.push(noMarks
    ? { id: 'marks', status: 'warn', title: 'A question carries no marks',
        detail: `${noMarks} question(s) with no mark allocation.` }
    : { id: 'marks', status: 'pass', title: 'Every question carries marks',
        detail: `${total} marks in total.` });

  const noSpace = questions.filter(q => !(q.answer_lines > 0)).length;
  checks.push(noSpace
    ? { id: 'space', status: 'warn', title: 'A question has no room to answer',
        detail: `${noSpace} question(s) with no ruled space.` }
    : { id: 'space', status: 'pass', title: 'Every question has room to answer',
        detail: 'Homework is written on, so it has to have space.' });

  const untagged = sections.filter(s => !(s.objectives?.length)).length;
  checks.push(untagged
    ? { id: 'objectives', status: 'warn', title: 'A section names no objective',
        detail: `${untagged} section(s) not tagged to the registry.` }
    : { id: 'objectives', status: 'pass', title: 'Every section addresses a registry objective',
        detail: `${content.objective_refs?.length ?? 0} references.` });

  checks.push(content.duration_minutes > 0
    ? { id: 'duration', status: 'pass', title: 'The homework states how long it should take',
        detail: `${content.duration_minutes} minutes.` }
    : { id: 'duration', status: 'warn', title: 'No time is stated',
        detail: 'A learner at home needs to know when they are finished.' });

  return {
    checks,
    blocking: checks.filter(c => c.status === 'block').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    passed: checks.filter(c => c.status === 'pass').length,
  };
}
