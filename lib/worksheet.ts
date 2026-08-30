import { call } from './claude';
import { admin } from './supabase';
import type { Objective } from './planner';
import { workKey, overlap } from './workkey';

/**
 * The Worksheet Standard (Addendum C §C2, five parts; the Study Pack Build Kit is
 * the working model). A worksheet is a printable set of tasks for one class in one
 * week, differentiated into the planner's three named tiers — support / core /
 * extension (§C4 non-negotiable 5).
 *
 * The division of labour is the planner's and the study pack's: the model writes
 * the tasks, the questions and the answers, but it never writes an objective. It
 * chooses which of the supplied registry objectives each task addresses, by index,
 * so a worksheet cannot aim at a code the school's curriculum does not hold.
 *
 * Five parts, met here:
 *   1. Schema        — WORKSHEET_SCHEMA below (title, tasks × three tiers, answers).
 *   2. Render        — lib/pdf/renderers/worksheet.ts (a printable A4 PDF + key).
 *   3. Non-negotiables — objectives retrieved verbatim; three tiers on every task;
 *                        an answer per task; no learner names.
 *   4. Quality gate  — gateWorksheet() below: deterministic, structural, free.
 *   5. Exemplars     — the shipped renderer output is the style ground truth, as the
 *                      Study Pack Kit's own template is (§C2).
 */

export interface RegistryWeekLite {
  week_number: number; topic_label: string; objectives: Objective[];
}

const WORKSHEET_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'intro', 'tasks'],
  properties: {
    title: { type: 'string' },
    intro: { type: 'string' },                         // one or two lines to the learner
    tasks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['objective_indexes', 'core', 'support', 'extension', 'answer'],
        properties: {
          // Indexes into the supplied objective list — the model selects, never
          // writes an objective. Same guard as the planner and the study pack.
          objective_indexes: { type: 'array', items: { type: 'integer' } },
          core: { type: 'string' },                    // the core task
          support: { type: 'string' },                 // scaffolded, for learners who need it
          extension: { type: 'string' },               // stretch, for those ready
          answer: { type: 'string' },                  // the expected answer, for the key
        },
      },
    },
  },
} as const;

const SYSTEM = `You write differentiated worksheets for Lusaka Oaktree School, a Cambridge primary/lower-secondary
school in Zambia.

You are given the curriculum objectives for one week. You never write, reword, renumber or invent an
objective - you only choose which of the supplied objectives each task addresses, by index.

For each task produce three tiers of the same task, aimed at the same objective(s):
- core: the task most of the class does.
- support: the same task made accessible - smaller numbers, a worked start, a sentence stem, or a
  scaffold - for a learner who needs a way in. Never a different, easier objective.
- extension: the same task pushed further - justify, generalise, apply to a new case - for a learner
  who is ready. Never a new objective.
Also give the expected answer, for the teacher's answer key.

Write clear instructions a learner of this age can follow alone. Plain British English. Never use a
learner's name. Do not include external links. Do not write anything a teacher would sign.

Never use an em dash or an en dash. Use a plain hyphen.`;

export interface GenerateWorksheetInput {
  week: RegistryWeekLite;
  yearGroup: string; subjectId: string; weekNumber: number;
}

export interface TaskOut {
  objectives: Objective[];
  core: string; support: string; extension: string; answer: string;
}
export interface WorksheetContent {
  title: string; intro: string;
  tasks: TaskOut[];
  objective_refs: string[];
}

export async function generateWorksheet(input: GenerateWorksheetInput, userId: string): Promise<{ content: WorksheetContent; usage: unknown }> {
  // One flat, indexed objective list — the model tags into it, so an index always
  // resolves to a real registry objective.
  const flat: Objective[] = [];
  const cachedLines: string[] = [`CURRICULUM - ${input.yearGroup} ${input.subjectId}, week ${input.weekNumber}: ${input.week.topic_label}`];
  for (const o of input.week.objectives) {
    cachedLines.push(`  [${flat.length}] ${o.ref ? o.ref + ' - ' : ''}${o.text}`);
    flat.push(o);
  }

  const { data, usage } = await call<{
    title: string; intro: string;
    tasks: { objective_indexes: number[]; core: string; support: string; extension: string; answer: string }[];
  }>({
    tier: 'standard',
    workflow: 'worksheet_create',
    userId,
    system: SYSTEM,
    cached: [cachedLines.join('\n')],
    longCache: true,
    prompt: `Write a worksheet of 4 to 6 tasks for week ${input.weekNumber}. Use only the objective indexes `
      + `listed. Every task must have all three tiers and an answer.`,
    schema: WORKSHEET_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 5000,
  });

  const seenRefs = new Set<string>();
  const tasks = (data.tasks ?? []).map(t => {
    const objectives = (t.objective_indexes ?? []).map(i => flat[i]).filter(Boolean);
    for (const o of objectives) if (o.ref) seenRefs.add(o.ref);
    return {
      objectives,
      core: t.core ?? '', support: t.support ?? '', extension: t.extension ?? '', answer: t.answer ?? '',
    };
  }).filter(t => t.core.trim());

  return {
    content: { title: data.title, intro: data.intro ?? '', tasks, objective_refs: [...seenRefs].sort() },
    usage,
  };
}

/** The work key for a worksheet: one week, its objective set. artefact_type
 *  distinguishes it from a planner or study pack sharing the same refs. */
export function worksheetWorkKey(p: { subjectId: string; yearGroup: string; academicYear: string; weekNumber: number; refs: string[] }): string {
  return workKey({
    artefactType: 'worksheet', subjectId: p.subjectId, yearGroup: p.yearGroup,
    academicYear: p.academicYear, weekNumber: p.weekNumber, refs: p.refs,
  });
}

/**
 * Search before generate for worksheets: an approved worksheet whose objective set
 * matches, most-reused first. No model call — the same rule the study pack follows
 * (Addendum B): the bank offers only work a named human approved. Tier 1 is an
 * exact objective match (reuse unchanged); a strong overlap is offered too, ranked
 * below it.
 */
export async function findWorksheetMatches(subjectId: string, yearGroup: string, refs: string[], excludeId?: string) {
  if (!refs.length) return [];
  const db = admin();
  const { data } = await db.from('worksheet')
    .select('id, title, work_key, objective_refs, week_number, reuse_count, author_id, app_user:author_id(full_name)')
    .eq('subject_id', subjectId).eq('year_group', yearGroup).eq('approved', true);
  const want = [...refs].sort().join(',');
  return (data ?? [])
    .filter(w => w.id !== excludeId)
    .map(w => {
      const theirs = [...(w.objective_refs ?? [])].sort().join(',');
      const exact = theirs === want;
      return { ...w, tier: exact ? 1 : 4, mode: exact ? 'reuse' : 'adapt' as 'reuse' | 'adapt' };
    })
    .filter(w => w.tier === 1 || overlap(refs, w.objective_refs ?? []) >= 0.6)
    .sort((a, b) => a.tier - b.tier || b.reuse_count - a.reuse_count);
}

/**
 * The worksheet gate — the Standard's non-negotiables as deterministic checks over
 * the stored worksheet. Structural, so free and instant. Most are met by
 * construction (the generator cannot omit a tier), but a gate is what makes that a
 * guarantee rather than a hope, and it is what the Standard's gate_id points at.
 */
export async function gateWorksheet(worksheetId: string) {
  const db = admin();
  const { data: ws } = await db.from('worksheet').select('content').eq('id', worksheetId).single();
  const content = (ws?.content ?? {}) as WorksheetContent;
  const tasks = content.tasks ?? [];
  const checks: { id: string; status: 'pass' | 'warn' | 'block'; title: string; detail: string }[] = [];

  checks.push(tasks.length
    ? { id: 'tasks', status: 'pass', title: 'The worksheet has tasks', detail: `${tasks.length} tasks.` }
    : { id: 'tasks', status: 'block', title: 'The worksheet has no tasks', detail: 'Nothing was generated.' });

  const missingTiers = tasks.filter(t => !t.support?.trim() || !t.extension?.trim()).length;
  checks.push(missingTiers
    ? { id: 'tiers', status: 'warn', title: 'A task is missing a tier', detail: `${missingTiers} task(s) without support or extension.` }
    : { id: 'tiers', status: 'pass', title: 'Every task has support, core and extension', detail: 'Three named tiers on each task.' });

  const noAnswer = tasks.filter(t => !t.answer?.trim()).length;
  checks.push(noAnswer
    ? { id: 'answers', status: 'warn', title: 'A task has no answer', detail: `${noAnswer} task(s) without an answer for the key.` }
    : { id: 'answers', status: 'pass', title: 'Every task has an answer', detail: 'The answer key is complete.' });

  const untagged = tasks.filter(t => !(t.objectives?.length)).length;
  checks.push(untagged
    ? { id: 'objectives', status: 'warn', title: 'A task names no objective', detail: `${untagged} task(s) not tagged to the registry.` }
    : { id: 'objectives', status: 'pass', title: 'Every task addresses a registry objective', detail: `${content.objective_refs?.length ?? 0} references.` });

  return {
    checks,
    blocking: checks.filter(c => c.status === 'block').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    passed: checks.filter(c => c.status === 'pass').length,
  };
}
