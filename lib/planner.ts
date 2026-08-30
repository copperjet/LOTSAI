import { call } from './claude';
import { admin } from './supabase';
import { workKey, overlap, MatchTier, TIER_MEANING } from './workkey';

/**
 * The Weekly Planner workflow (main spec section 6.1, standard in Addendum C section C4).
 *
 * The model is asked to do the narrow part only: split the week across periods,
 * propose methodology and resources from what the school actually has, and add
 * differentiation. Objective text is copied from the registry and passed through
 * untouched — it is never in the model's output schema, so it cannot be altered.
 */

export interface Objective { ref: string | null; text: string }

export interface RegistryWeek {
  id: string; topic_label: string; objectives: Objective[];
  activities: string[]; resources: string[];
  week_number: number; year_group: string; subject_id: string; academic_year: string;
  signed_off_at: string | null;
}

export interface Match {
  tier: MatchTier; mode: 'reuse' | 'adapt'; why: string;
  artefact: {
    id: string; planner_id: string | null; author_name: string;
    landed_rate: number | null; reuse_count: number; week_number: number;
    objective_refs: string[]; approved: boolean; created_at: string;
  };
}

/** Search before generate (Addendum B section B2). Tiers relax in a fixed order. */
export async function findMatches(reg: RegistryWeek, excludePlannerId?: string): Promise<Match[]> {
  const db = admin();
  const refs = reg.objectives.map(o => o.ref).filter((r): r is string => !!r).sort();

  // An uncoded week cannot be matched exactly. That is the honest answer, and
  // it is why registry sign-off comes before generation (Addendum C section C7).
  if (!refs.length) return [];

  const { data } = await db.from('shared_artifact_ranked')
    .select('*')
    .eq('subject_id', reg.subject_id)
    .eq('year_group', reg.year_group)
    .eq('approved', true)
    .neq('visibility', 'private');

  const rows = (data ?? []).filter(r => r.planner_id !== excludePlannerId);
  const key = workKey({ artefactType: 'planner', subjectId: reg.subject_id, yearGroup: reg.year_group,
                        academicYear: reg.academic_year, weekNumber: reg.week_number, refs });

  const matches: Match[] = [];
  for (const r of rows) {
    const theirs: string[] = r.objective_refs ?? [];
    const same = theirs.length === refs.length && theirs.every((x, i) => x === refs[i]);
    let tier: MatchTier | null = null;

    if (r.work_key === key)                                    tier = 1;
    else if (same && r.week_number !== reg.week_number)        tier = 2;
    else if (same && r.academic_year !== reg.academic_year)    tier = 3;
    else if (overlap(refs, theirs) >= 0.6)                     tier = 4;

    if (tier) matches.push({ tier, ...TIER_MEANING[tier], artefact: r });
  }

  // Ranked by what happened in the classroom, not by how good it looked
  // (Addendum B section B6): approved, then landed rate, then reuse, then recency.
  return matches.sort((a, b) =>
    a.tier - b.tier ||
    (b.artefact.landed_rate ?? -1) - (a.artefact.landed_rate ?? -1) ||
    b.artefact.reuse_count - a.artefact.reuse_count ||
    +new Date(b.artefact.created_at) - +new Date(a.artefact.created_at));
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lessons'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['day_of_week', 'objective_indexes', 'methodology', 'resources', 'differentiation', 'is_recap'],
        properties: {
          // minimum/maximum are not accepted under strict structured output;
          // the range is enforced after parsing instead.
          day_of_week: { type: 'integer' },
          // Indexes into the objective list we supplied. The model selects,
          // it never writes objective text.
          objective_indexes: { type: 'array', items: { type: 'integer' } },
          methodology: { type: 'string' },
          resources: { type: 'string' },
          differentiation: { type: 'string' },
          is_recap: { type: 'boolean' },
        },
      },
    },
  },
} as const;

const SYSTEM = `You write weekly lesson plans for Lusaka Oaktree School, a Cambridge primary school in Zambia.

You are given the week's objectives from the school's own curriculum registry. You never write, reword,
renumber or invent an objective - you only choose which of the supplied objectives each lesson covers,
by index.

The LOTS Planning Standard, which you must meet:
- Methodology names a real learner action, not a category. "Learners regroup numbers using place value
  blocks, then explain each regrouping to a partner" is right. "Discussion" is not.
- Resources come only from the inventory you are given. If something useful is not in the inventory, use
  what is and say so plainly in the resources field - never invent a resource the school may not own.
- Differentiation is named in three tiers on every lesson: support, core, extension.
- Any objective flagged as not landed in recent weeks gets explicit recap time, marked is_recap.
- Write in plain British English, in the register a Zambian primary teacher would use with a colleague.
- Never write a teacher's comment or an HOD's comment. Those fields belong to people.

Classes are large and resources are limited. Prefer activities that work with one set of materials,
a chalkboard and a full classroom.

Never use an em dash or an en dash. Use a plain hyphen.`;

export interface GenerateInput {
  reg: RegistryWeek;
  periodsPerWeek: number;
  weekCommencing: string;
  inventory: string[];
  flagged: { ref: string; text: string; note: string }[];
  exemplar?: { methodology: string; differentiation: string }[];
  /** Adapt mode: the approved plan we are starting from. */
  basis?: { day_of_week: number; methodology: string; resources: string; differentiation: string }[];
}

export async function generatePlan(input: GenerateInput, userId: string) {
  const { reg, basis } = input;
  const adapting = !!basis;

  // Stable for everyone planning this subject and week -> cached at 1h TTL.
  // Volatile, class-specific context goes in the prompt, after the breakpoint.
  const cached = [
    `CURRICULUM REGISTRY - ${reg.year_group} ${reg.subject_id}, week ${reg.week_number}\n` +
    `Topic: ${reg.topic_label}\n` +
    `Objectives (use these indexes):\n` +
    reg.objectives.map((o, i) => `  [${i}] ${o.ref ? o.ref + ' - ' : ''}${o.text}`).join('\n') +
    (reg.activities.length ? `\nSuggested activities from the overview:\n` + reg.activities.map(a => `  - ${a}`).join('\n') : '') +
    (reg.resources.length ? `\nResources named in the overview:\n` + reg.resources.map(r => `  - ${r}`).join('\n') : ''),
    `RESOURCE INVENTORY - only these are available:\n` + input.inventory.map(r => `  - ${r}`).join('\n'),
  ];

  const prompt = [
    `This class has ${input.periodsPerWeek} periods this week, Monday to Friday, w/c ${input.weekCommencing}.`,
    input.flagged.length
      ? `Not landed in recent weeks for THIS class - give explicit recap time and mark it is_recap:\n` +
        input.flagged.map(f => `  - ${f.ref}: ${f.text}\n    Teacher said: ${f.note}`).join('\n')
      : `Nothing was flagged as not landed for this class recently.`,
    adapting
      ? `You are ADAPTING a plan already approved by the HOD for a parallel class. Keep it as it is\n` +
        `wherever it still fits. Change only what this class needs - the period count, and recap time\n` +
        `for anything flagged above. Do not rewrite lessons that work.\n\n` +
        `THE APPROVED PLAN:\n` + basis!.map(b =>
          `  Day ${b.day_of_week}: ${b.methodology}\n    Resources: ${b.resources}\n    Differentiation: ${b.differentiation}`).join('\n')
      : `Write ${input.periodsPerWeek} lessons for this week.`,
  ].join('\n\n');

  const { data, usage } = await call<{ lessons: {
    day_of_week: number; objective_indexes: number[]; methodology: string;
    resources: string; differentiation: string; is_recap: boolean;
  }[] }>({
    tier: 'standard',
    workflow: adapting ? 'planner_adapt' : 'planner_create',
    userId, cached, prompt,
    system: SYSTEM,
    longCache: true,
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4096,
  });

  const monday = new Date(input.weekCommencing);
  const lessons = data.lessons.map((l, position) => {
    // Monday to Friday, whatever the model said. The gate checks lesson dates
    // against the school week, and a day outside it would block the plan.
    const day = Math.min(5, Math.max(1, Math.round(l.day_of_week)));
    const d = new Date(monday); d.setDate(monday.getDate() + (day - 1));
    return {
      position,
      day_of_week: day,
      lesson_date: d.toISOString().slice(0, 10),
      // objective text comes from the registry, never from the model
      objectives: l.objective_indexes.map(i => reg.objectives[i]).filter(Boolean),
      methodology: l.methodology,
      resources: l.resources,
      differentiation: l.differentiation,
      is_recap: l.is_recap,
    };
  });

  return { lessons, usage };
}
