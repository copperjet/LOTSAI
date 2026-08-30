import { call } from './claude';
import { admin } from './supabase';
import type { Objective } from './planner';
import { workKey } from './workkey';

/**
 * The Study Pack workflow (Addendum C §C3; the Study Pack Build Kit is its
 * Standard). A study pack is an interactive revision tool covering a span of
 * curriculum weeks.
 *
 * The division of labour is the planner's, applied to a different artefact: the
 * model generates the pedagogy — key ideas, a quiz per topic, a glossary — but it
 * never writes an objective. It selects which of the supplied registry objectives
 * a topic covers, by index, so a study pack cannot cite a code the school's
 * curriculum does not hold. The six non-negotiables of the Build Kit are met by
 * construction: every topic names its objectives and carries an interactive quiz;
 * the pack carries a glossary and a thinking prompt per unit.
 *
 * External resource links are deliberately not in the schema. The Build Kit warns
 * against fabricated URLs, and a model will invent them — so the pack asks a
 * thinking question instead, and links are left for a human to add.
 */

export interface RegistryWeekLite {
  week_number: number; topic_label: string; objectives: Objective[];
}

const PACK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'units', 'glossary'],
  properties: {
    title: { type: 'string' },
    units: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['unit_label', 'summary', 'topics'],
        properties: {
          unit_label: { type: 'string' },
          summary: { type: 'string' },
          topics: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['topic_label', 'objective_indexes', 'key_ideas', 'quiz', 'think_question'],
              properties: {
                topic_label: { type: 'string' },
                // Indexes into the objective list supplied — the model selects,
                // it never writes an objective. Same guard as the planner.
                objective_indexes: { type: 'array', items: { type: 'integer' } },
                key_ideas: { type: 'array', items: { type: 'string' } },       // 3–6, enforced after parse
                quiz: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['q', 'options', 'correct', 'explain'],
                    properties: {
                      q: { type: 'string' },
                      options: { type: 'array', items: { type: 'string' } },
                      correct: { type: 'integer' },
                      explain: { type: 'string' },
                    },
                  },
                },
                think_question: { type: 'string' },
              },
            },
          },
        },
      },
    },
    glossary: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['term', 'definition'],
        properties: { term: { type: 'string' }, definition: { type: 'string' } },
      },
    },
  },
} as const;

const SYSTEM = `You build interactive study packs for Lusaka Oaktree School, a Cambridge primary/lower-secondary
school in Zambia.

You are given the curriculum objectives for a span of weeks, already grouped by week. You never write,
reword, renumber or invent an objective - you only choose which of the supplied objectives each topic
covers, by index.

For each topic produce:
- 3 to 6 short key ideas, in your own words, each scannable in under a minute - never a paragraph.
- A short quiz of 2 to 4 multiple-choice questions with 3 or 4 options each, the index of the correct
  option, and a one-line explanation of why it is right. Questions test understanding, not trivia.
- One open-ended "think" question that goes beyond recall (why / what if / compare).

Also produce a glossary of the key terms across the whole pack, each with a one-line definition.

Write in plain British English for the age group. Do not include external links or URLs. Do not write
anything a teacher or HOD would sign - no comments, no marking.

Never use an em dash or an en dash. Use a plain hyphen.`;

export interface GeneratePackInput {
  weeks: RegistryWeekLite[];       // the signed-off weeks in the span, in order
  yearGroup: string; subjectId: string;
  weekFrom: number; weekTo: number;
}

export interface TopicOut {
  topic_label: string; objectives: Objective[];
  key_ideas: string[]; quiz: { q: string; options: string[]; correct: number; explain: string }[];
  think_question: string;
}
export interface PackContent {
  title: string;
  units: { unit_label: string; summary: string; topics: TopicOut[] }[];
  glossary: { term: string; definition: string }[];
  objective_refs: string[];
}

export async function generateStudyPack(input: GeneratePackInput, userId: string): Promise<{ content: PackContent; usage: unknown }> {
  // One flat, indexed objective list across the whole span — the model tags into
  // this, so an index always resolves to a real registry objective.
  const flat: Objective[] = [];
  const cachedLines: string[] = [`CURRICULUM - ${input.yearGroup} ${input.subjectId}, weeks ${input.weekFrom}-${input.weekTo}`];
  for (const w of input.weeks) {
    cachedLines.push(`\nWeek ${w.week_number}: ${w.topic_label}`);
    for (const o of w.objectives) {
      cachedLines.push(`  [${flat.length}] ${o.ref ? o.ref + ' - ' : ''}${o.text}`);
      flat.push(o);
    }
  }

  const { data, usage } = await call<{
    title: string;
    units: { unit_label: string; summary: string; topics: {
      topic_label: string; objective_indexes: number[];
      key_ideas: string[]; quiz: { q: string; options: string[]; correct: number; explain: string }[];
      think_question: string;
    }[] }[];
    glossary: { term: string; definition: string }[];
  }>({
    tier: 'standard',
    workflow: 'studypack_create',
    userId,
    system: SYSTEM,
    cached: [cachedLines.join('\n')],
    longCache: true,
    prompt: `Build a study pack covering weeks ${input.weekFrom} to ${input.weekTo}. Group the topics into `
      + `units that follow the weeks above. Use only the objective indexes listed.`,
    schema: PACK_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 6000,
  });

  const seenRefs = new Set<string>();
  const units = (data.units ?? []).map(u => ({
    unit_label: u.unit_label,
    summary: u.summary,
    topics: (u.topics ?? []).map(t => {
      const objectives = (t.objective_indexes ?? []).map(i => flat[i]).filter(Boolean);
      for (const o of objectives) if (o.ref) seenRefs.add(o.ref);
      return {
        topic_label: t.topic_label,
        objectives,
        key_ideas: (t.key_ideas ?? []).slice(0, 6),
        // Keep quiz options/answer coherent: drop any question whose correct
        // index is out of range rather than render a broken button set.
        quiz: (t.quiz ?? []).filter(q => q.options?.length >= 2 && q.correct >= 0 && q.correct < q.options.length).slice(0, 4),
        think_question: t.think_question,
      };
    }),
  }));

  return {
    content: {
      title: data.title, units,
      glossary: (data.glossary ?? []).slice(0, 12),
      objective_refs: [...seenRefs].sort(),
    },
    usage,
  };
}

/** The work key for a study pack over a week span. artefact_type distinguishes it
 *  from a planner sharing the same refs. weekNumber carries the span's start. */
export function packWorkKey(p: { subjectId: string; yearGroup: string; academicYear: string; weekFrom: number; refs: string[] }): string {
  return workKey({
    artefactType: 'study_pack', subjectId: p.subjectId, yearGroup: p.yearGroup,
    academicYear: p.academicYear, weekNumber: p.weekFrom, refs: p.refs,
  });
}

/** Search before generate for study packs: an approved pack whose objective set
 *  matches, most-reused first. No model call. */
export async function findPackMatches(subjectId: string, yearGroup: string, refs: string[], excludeId?: string) {
  if (!refs.length) return [];
  const db = admin();
  const { data } = await db.from('study_pack')
    .select('id, title, work_key, objective_refs, week_from, week_to, reuse_count, author_id, app_user:author_id(full_name)')
    .eq('subject_id', subjectId).eq('year_group', yearGroup).eq('approved', true);
  const want = [...refs].sort().join(',');
  return (data ?? [])
    .filter(p => p.id !== excludeId)
    .map(p => {
      const theirs = [...(p.objective_refs ?? [])].sort().join(',');
      const exact = theirs === want;
      return { ...p, tier: exact ? 1 : 4, mode: exact ? 'reuse' : 'adapt' as 'reuse' | 'adapt' };
    })
    .filter(p => p.tier === 1 || overlapRefs(refs, p.objective_refs ?? []) >= 0.6)
    .sort((a, b) => a.tier - b.tier || b.reuse_count - a.reuse_count);
}

function overlapRefs(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let shared = 0; for (const r of A) if (B.has(r)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * The study pack gate — the Build Kit's six non-negotiables, as deterministic
 * checks over the stored pack. Structural, so free and instant. Most are met by
 * construction (the generator cannot omit them), but a gate is what makes that a
 * guarantee rather than a hope, and it is what the Standard's gate_id points at.
 */
export async function gateStudyPack(studyPackId: string) {
  const db = admin();
  const { data: pack } = await db.from('study_pack').select('content').eq('id', studyPackId).single();
  const content = (pack?.content ?? {}) as PackContent;
  const topics = (content.units ?? []).flatMap(u => u.topics ?? []);
  const checks: { id: string; status: 'pass' | 'warn' | 'block'; title: string; detail: string }[] = [];

  checks.push(topics.length
    ? { id: 'topics', status: 'pass', title: 'The pack has topics', detail: `${topics.length} topics across ${content.units?.length ?? 0} units.` }
    : { id: 'topics', status: 'block', title: 'The pack has no topics', detail: 'Nothing was generated.' });

  const noQuiz = topics.filter(t => !(t.quiz?.length)).length;
  checks.push(noQuiz
    ? { id: 'interactive', status: 'warn', title: 'A topic has no interactive activity', detail: `${noQuiz} topic(s) without a quiz.` }
    : { id: 'interactive', status: 'pass', title: 'Every topic has an interactive activity', detail: 'A quiz with feedback per topic.' });

  const thinKeys = topics.filter(t => (t.key_ideas?.length ?? 0) < 3 || (t.key_ideas?.length ?? 0) > 6).length;
  checks.push(thinKeys
    ? { id: 'key_ideas', status: 'warn', title: 'Key ideas outside 3-6 on some topics', detail: `${thinKeys} topic(s).` }
    : { id: 'key_ideas', status: 'pass', title: 'Key ideas are 3-6 per topic', detail: '' });

  checks.push(content.objective_refs?.length
    ? { id: 'objectives', status: 'pass', title: 'Objectives resolve to the registry', detail: `${content.objective_refs.length} references.` }
    : { id: 'objectives', status: 'warn', title: 'No syllabus references', detail: 'This span is stated in prose.' });

  return {
    checks,
    blocking: checks.filter(c => c.status === 'block').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    passed: checks.filter(c => c.status === 'pass').length,
  };
}
