import { call } from './claude';

/**
 * The quality gate (Addendum C section C5).
 *
 * Two passes, cheapest first. The deterministic pass is free and instant and
 * does all the compliance work; the model is asked only what a rule cannot
 * judge. The point is not to police teachers — it is to make sure the HOD's
 * two minutes go to judgement rather than to checking week numbers.
 */

export type Status = 'pass' | 'warn' | 'block';
export interface Check { id: string; status: Status; title: string; detail: string }

export interface GateInput {
  weekNumber: number;
  weekCommencing: string;          // ISO Monday from school_week
  periodsPerWeek: number;
  registryRefs: string[];          // refs the registry holds for this week
  inventory: string[];             // resource labels actually available
  flaggedLastWeeks: string[];      // objectives that did not land recently
  classRoll: string[];             // learner names, used only to assert absence
  lessons: {
    day_of_week: number; lesson_date: string;
    objectives: { ref: string | null; text: string }[];
    methodology: string; resources: string; differentiation: string; is_recap: boolean;
  }[];
}

const PLACEHOLDER = /\[[^\]]{3,40}\]|\bTBC\b|\blorem\b|\bXXX+\b/i;

/** Pass 1 — deterministic. No model, no cost, no latency. */
export function deterministic(i: GateInput): Check[] {
  const out: Check[] = [];
  const used = i.lessons.flatMap(l => l.objectives);
  const refs = used.map(o => o.ref).filter((r): r is string => !!r);

  const unknown = refs.filter(r => !i.registryRefs.includes(r));
  // Named by what they say, with the code after. A teacher reading a blocked check
  // was given "4Rg.04, 4Rs.01" and had to go and look up what the application was
  // objecting to; the objective is right here in the input.
  const nameOf = (ref: string) => {
    const text = used.find(o => o.ref === ref)?.text;
    return text ? `"${text}" (${ref})` : ref;
  };
  out.push(unknown.length
    ? { id: 'refs', status: 'block', title: 'An objective is not in the curriculum',
        detail: `${unknown.map(nameOf).join('; ')} - I only use objectives the school's curriculum holds, and these are not in it. Check the week.` }
    : { id: 'refs', status: 'pass', title: 'Every objective is in the curriculum',
        detail: refs.length ? `${new Set(refs).size} objective(s), all found in the registry.`
                            : 'This week is topic-only - the overview states objectives in prose, with no codes.' });

  const badDate = i.lessons.some(l => {
    const d = new Date(l.lesson_date), mon = new Date(i.weekCommencing);
    const diff = Math.round((d.getTime() - mon.getTime()) / 86400000);
    return diff < 0 || diff > 4;
  });
  out.push(badDate
    ? { id: 'dates', status: 'block', title: 'A lesson falls outside its school week',
        detail: `Week ${i.weekNumber} runs from ${i.weekCommencing}, Monday to Friday.` }
    : { id: 'dates', status: 'pass', title: 'Week number and dates match the school calendar',
        detail: `Week ${i.weekNumber}, w/c ${i.weekCommencing}.` });

  out.push(i.lessons.length === i.periodsPerWeek
    ? { id: 'periods', status: 'pass', title: 'Lesson count matches periods per week',
        detail: `${i.lessons.length} lessons, ${i.periodsPerWeek} periods.` }
    : { id: 'periods', status: 'block', title: 'Lesson count does not match the timetable',
        detail: `${i.lessons.length} lessons for ${i.periodsPerWeek} periods.` });

  const noDiff = i.lessons.filter(l => l.differentiation.trim().length < 20);
  out.push(noDiff.length
    ? { id: 'diff', status: 'warn', title: 'Differentiation is thin on some lessons',
        detail: `${noDiff.length} lesson(s) without support, core and extension named separately.` }
    : { id: 'diff', status: 'pass', title: 'Differentiation present on every lesson',
        detail: 'Support, core and extension named separately.' });

  // Resources are flagged, never invented and never silently removed.
  const missing = i.lessons.flatMap(l => l.resources.split(/[·,;]/).map(s => s.trim()))
    .filter(r => r.length > 3 && !i.inventory.some(inv => r.toLowerCase().includes(inv.toLowerCase())
                                                      || inv.toLowerCase().includes(r.toLowerCase())));
  out.push(missing.length
    ? { id: 'inventory', status: 'warn', title: 'A resource is not in the inventory',
        detail: `${[...new Set(missing)].slice(0, 3).join('; ')} - either the inventory is out of date or it is not available.` }
    : { id: 'inventory', status: 'pass', title: 'Every resource is in the inventory', detail: '' });

  const placeholders = i.lessons.some(l => PLACEHOLDER.test(l.methodology + l.resources + l.differentiation));
  if (placeholders) out.push({ id: 'placeholder', status: 'block',
    title: 'Unreplaced placeholder text', detail: 'A bracketed placeholder is still in the plan.' });

  // A data-protection control, not a style rule. v1 holds no learner data and
  // this is what keeps it that way (main spec section 8).
  const blob = i.lessons.map(l => `${l.methodology} ${l.resources} ${l.differentiation}`).join(' ').toLowerCase();
  const named = i.classRoll.filter(n => n.length > 3 && blob.includes(n.toLowerCase()));
  out.push(named.length
    ? { id: 'names', status: 'block', title: 'A learner name appears in the plan',
        detail: 'Please take the name out before you submit. Plans never hold a pupil’s name.' }
    : { id: 'names', status: 'pass', title: 'No learner names present',
        detail: 'Checked against the class list.' });

  const recapped = i.lessons.some(l => l.is_recap || l.objectives.some(o => o.ref && i.flaggedLastWeeks.includes(o.ref)));
  if (i.flaggedLastWeeks.length) out.push(recapped
    ? { id: 'recap', status: 'pass', title: 'Objectives flagged last week are recapped',
        detail: `${i.flaggedLastWeeks.join(', ')} did not land. Recap time is in the week.` }
    : { id: 'recap', status: 'warn', title: 'A flagged objective has no recap time',
        detail: `${i.flaggedLastWeeks.join(', ')} did not land for this class. Consider adding recap time.` });

  return out;
}

const TONE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'status', 'title', 'detail'],
        properties: {
          id: { type: 'string', enum: ['tone', 'specificity', 'alignment'] },
          status: { type: 'string', enum: ['pass', 'warn'] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Pass 2 — one small-tier call, only on what a rule cannot judge. */
export async function modelPass(i: GateInput, userId: string): Promise<Check[]> {
  const { data } = await call<{ checks: Check[] }>({
    tier: 'small',
    workflow: 'quality_gate',
    userId,
    system:
      'You check a Zambian primary school lesson plan against the LOTS Planning Standard. ' +
      'Judge only three things: register and tone; whether methodology names a real learner action ' +
      'rather than a category like "discussion"; and whether each activity actually serves its stated ' +
      'objective. Never rewrite the plan. Never comment on anything else. Warn sparingly - a warning ' +
      'costs a teacher attention, so raise one only where a colleague would.',
    prompt: JSON.stringify(i.lessons.map(l => ({
      objectives: l.objectives.map(o => o.text),
      methodology: l.methodology, differentiation: l.differentiation,
    }))),
    schema: TONE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1024,
  });
  // maxItems is not an accepted keyword under strict structured output, so the
  // cap that used to be in the schema is enforced here: three warnings is the
  // most an HOD's two minutes can absorb.
  return (data.checks ?? []).slice(0, 3);
}

export async function runGate(i: GateInput, userId: string) {
  const checks = deterministic(i);
  // A blocked plan is not worth a model call: it cannot be submitted either way.
  const blocked = checks.some(c => c.status === 'block');
  const all = blocked ? checks : [...checks, ...await modelPass(i, userId)];
  return {
    checks: all,
    blocking: all.filter(c => c.status === 'block').length,
    warnings: all.filter(c => c.status === 'warn').length,
    passed:   all.filter(c => c.status === 'pass').length,
  };
}
