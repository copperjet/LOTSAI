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
 * The model tags objectives by INDEX into the list we supplied, exactly as the
 * planner selects them (lib/planner.ts). It never writes a reference.
 *
 * This started as an enum of the lesson's syllabus references, which is wrong
 * for a reason worth keeping written down. A lesson may legitimately carry an
 * objective with no reference — an uncoded overview row, or a strand the
 * ingest could not parse. Those objectives were absent from the enum, so a
 * model asked to flag one had no legal token for it and put the only value the
 * enum allowed. A live evaluation flagged one reference twelve times, in a
 * lesson where it had also just been marked landed.
 *
 * Every objective has an index, so there is always something true to say.
 */
function schemaFor() {
  // minimum/maximum are not accepted under strict structured output, so the
  // range is enforced after parsing instead — the same way the planner bounds
  // day_of_week.
  const index = { type: 'integer' };
  return {
    type: 'object', additionalProperties: false,
    // Strict structured output requires every property to be listed as required,
    // so an optional field is expressed as a nullable one instead.
    required: ['formatted_comment', 'landed', 'flagged', 'clarifying_question'],
    properties: {
      formatted_comment: { type: 'string' },
      landed:  { type: 'array', items: index },
      flagged: { type: 'array', items: index },
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

2. Tag each objective for the lesson as landed or flagged, by its index in the list supplied. An
   objective is landed if the note indicates most of the class got it. It is flagged if the note
   indicates confusion, partial understanding, or that it needs revisiting. If the note says nothing
   about an objective at all, leave it out of both lists rather than guessing.

   An index appears in at most one of the two lists, and at most once. An objective the class got
   is not also an objective needing revisiting.

Ask a clarifying question only if you genuinely cannot tag the objectives — never more than one, and
never about anything else. Most notes need no question.

Never write in the HOD's voice. Never write in the first person as the teacher.`;

/** What the model returns: indexes, never references. */
interface TaggedByIndex {
  formatted_comment: string;
  landed: number[];
  flagged: number[];
  clarifying_question: string | null;
}

/** What callers get: references, resolved from those indexes. */
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
  const objectives = lesson.objectives;

  const { data, usage } = await call<TaggedByIndex>({
    tier: 'small',
    workflow: 'lesson_evaluation',
    userId,
    system: SYSTEM,
    // Small and per-lesson, so there is nothing worth a cache breakpoint here.
    prompt: [
      `Lesson: ${lesson.className}, ${lesson.day}${lesson.period ? `, period ${lesson.period}` : ''}.`,
      `Objectives (tag these by index):`,
      ...objectives.map((o, i) => `  [${i}] ${o.ref ? o.ref + ' — ' : ''}${o.text}`),
      `Planned methodology: ${lesson.methodology}`,
      ``,
      `The teacher said: "${raw}"`,
    ].join('\n'),
    schema: schemaFor() as unknown as Record<string, unknown>,
    maxTokens: 700,
  });

  /**
   * Indexes to references. Three things are enforced here rather than trusted:
   *
   *  - an index must be in range;
   *  - flagged wins a conflict, because "needs revisiting" is the tag that
   *    changes next week's plan, and losing it is the more costly mistake;
   *  - each reference appears once.
   *
   * An objective with no reference is dropped from both lists: coverage is
   * counted in references, and there is nothing to count it under. It still
   * appears in the formatted comment, which is where the teacher will see it.
   */
  const resolve = (indexes: number[], exclude?: Set<string>) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const i of indexes) {
      const ref = objectives[i]?.ref;
      if (!ref || seen.has(ref) || exclude?.has(ref)) continue;
      seen.add(ref);
      out.push(ref);
    }
    return out;
  };

  const flagged = resolve(data.flagged ?? []);
  const landed = resolve(data.landed ?? [], new Set(flagged));

  return { ...data, landed, flagged, usage } as EvaluationResult & { usage: typeof usage };
}
