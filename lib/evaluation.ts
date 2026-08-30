import { call } from './claude';
import type { Objective } from './planner';

/**
 * Lesson Evaluation (main spec section 6.2) — the adoption engine.
 *
 * The teacher says one sentence. The model does two narrow jobs: put it into the
 * register the planner expects, and tag each objective as landed or flagged.
 * It does not judge the teacher, does not add advice, and does not ask a second
 * question. The tags are what feed next week's plan and what lets the shared
 * bank rank by what actually worked.
 */

/**
 * Built per lesson, because the tags are only meaningful as the references this
 * lesson actually carries. A small model asked for "the references supplied" in
 * prose will happily answer with objective text instead; an enum makes that
 * impossible rather than merely discouraged.
 *
 * An uncoded week has no references at all — an empty enum is not valid schema,
 * so those fall back to plain strings and the filter below empties them.
 */
function schemaFor(refs: string[]) {
  const ref = refs.length ? { type: 'string', enum: refs } : { type: 'string' };
  return {
    type: 'object', additionalProperties: false,
    // Strict structured output requires every property to be listed as required,
    // so an optional field is expressed as a nullable one instead.
    required: ['formatted_comment', 'landed', 'flagged', 'clarifying_question'],
    properties: {
      formatted_comment: { type: 'string' },
      landed:  { type: 'array', items: ref },
      flagged: { type: 'array', items: ref },
      // At most one, and only when the tags genuinely cannot be decided.
      clarifying_question: { type: ['string', 'null'] },
    },
  };
}

const SYSTEM = `You turn a Zambian primary teacher's quick spoken note about a lesson into the
Teacher's Comments box of a Lusaka Oaktree School weekly planner.

Two jobs, and nothing else:

1. Rewrite what they said in the register a teacher uses in a planner a head of department reads —
   plain, factual, British English, past tense, two or three sentences at most. Keep every fact and
   every reservation. Do not add praise, advice, targets or next steps. Do not invent detail the
   teacher did not give you. If they were brief, your comment is brief.

2. Tag each objective for the lesson as landed or flagged, using only the references supplied. An
   objective is landed if the note indicates most of the class got it. It is flagged if the note
   indicates confusion, partial understanding, or that it needs revisiting. If the note says nothing
   about an objective at all, leave it out of both lists rather than guessing.

Ask a clarifying question only if you genuinely cannot tag the objectives — never more than one, and
never about anything else. Most notes need no question.

Never write in the HOD's voice. Never write in the first person as the teacher.`;

export interface EvaluationResult {
  formatted_comment: string;
  landed: string[];
  flagged: string[];
  clarifying_question: string | null;
}

export async function formatEvaluation(
  raw: string,
  lesson: { objectives: Objective[]; methodology: string; className: string; day: string; period?: number },
  userId: string,
) {
  const refs = lesson.objectives.map(o => o.ref).filter((r): r is string => !!r);

  const { data, usage } = await call<EvaluationResult>({
    tier: 'small',
    workflow: 'lesson_evaluation',
    userId,
    system: SYSTEM,
    // Small and per-lesson, so there is nothing worth a cache breakpoint here.
    prompt: [
      `Lesson: ${lesson.className}, ${lesson.day}${lesson.period ? `, period ${lesson.period}` : ''}.`,
      `Objectives${refs.length ? '' : ' (this overview has no syllabus codes — leave both lists empty)'}:`,
      ...lesson.objectives.map(o => `  ${o.ref ? o.ref + ' — ' : ''}${o.text}`),
      `Planned methodology: ${lesson.methodology}`,
      ``,
      `The teacher said: "${raw}"`,
    ].join('\n'),
    schema: schemaFor(refs) as unknown as Record<string, unknown>,
    maxTokens: 700,
  });

  // The model may only tag references that exist on this lesson.
  const allowed = new Set(refs);
  return {
    ...data,
    landed:  data.landed.filter(r => allowed.has(r)),
    flagged: data.flagged.filter(r => allowed.has(r)),
    usage,
  };
}
