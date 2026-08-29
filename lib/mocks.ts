/**
 * Fixtures for MOCK_CLAUDE=1 (see lib/claude.ts).
 *
 * The point is not to fake a plausible-looking demo. It is to exercise every
 * path that a real call exercises — the gate, the metering, the objective
 * indexes — without an API key. So the fixtures are read off the same prompt the
 * model would have received: the periods count, the objective indexes and the
 * resource inventory all come out of the prompt text, which means mock output
 * satisfies the real gate in lib/gate.ts instead of tripping it.
 */

const HOW = [
  'Learners regroup three-digit numbers with place value blocks, then explain each regrouping to a partner',
  'Learners round numbers on a marked number line and say aloud which ten they landed nearer to',
  'In pairs, learners build a number, break it into hundreds, tens and ones, and rebuild it a second way',
  'Learners sort number cards into rounded families on the chalkboard and justify each placement',
  'Learners write three numbers of their own, regroup each one, and check a partner\u2019s working',
];

const DIFF = [
  'Support: work to 100 with blocks on the desk. Core: to 1000 without blocks. Extension: explain a regrouping in writing.',
  'Support: round to the nearest 10 using a number line. Core: to 100 and 1000. Extension: find numbers that round to the same answer.',
  'Support: one representation, guided. Core: two representations independently. Extension: prove two of them are the same number.',
];

/** Objective indexes offered in the cached registry block, as `  [0] 4Np.03 — ...`. */
function objectiveCount(text: string) {
  return Math.max(1, (text.match(/^\s*\[\d+\]/gm) ?? []).length);
}

/** Inventory labels, so mock resources are always resources the school owns. */
function inventory(text: string) {
  const after = text.split('RESOURCE INVENTORY')[1] ?? '';
  const labels = (after.match(/^\s*-\s+(.+)$/gm) ?? []).map(l => l.replace(/^\s*-\s+/, '').trim());
  return labels.length ? labels : ['Chalkboard'];
}

function periods(prompt: string) {
  const m = prompt.match(/has (\d+) periods/);
  return m ? Math.min(5, Math.max(1, +m[1])) : 5;
}

export function mockPlan(cached: string, prompt: string) {
  const n = periods(prompt);
  const objectives = objectiveCount(cached);
  const inv = inventory(cached);
  const recapping = /Not landed in recent weeks/.test(prompt);

  return {
    lessons: Array.from({ length: n }, (_, i) => ({
      day_of_week: i + 1,
      // Indexes into the supplied list — never objective text, exactly as PLAN_SCHEMA requires.
      objective_indexes: [i % objectives],
      methodology: HOW[i % HOW.length],
      resources: inv.slice(0, 2).join('; '),
      differentiation: DIFF[i % DIFF.length],
      is_recap: recapping && i === 0,
    })),
  };
}

export function mockEvaluation(prompt: string) {
  const refs = [...prompt.matchAll(/^\s{2}([A-Za-z0-9][A-Za-z0-9._]*) \u2014 /gm)].map(m => m[1]);
  return {
    formatted_comment:
      'Most of the class regrouped confidently by the end of the period. A small group still needed the '
      + 'blocks in front of them, and rounding upwards from a five was not secure.',
    landed: refs.slice(0, Math.max(1, refs.length - 1)),
    flagged: refs.length > 1 ? refs.slice(-1) : [],
  };
}

export function mockGate() {
  return {
    checks: [
      { id: 'tone', status: 'pass',
        title: 'Register suits a planner a head of department reads',
        detail: 'Plain British English throughout.' },
      { id: 'specificity', status: 'pass',
        title: 'Methodology names a learner action',
        detail: 'Every lesson says what the learners do, not what category the activity belongs to.' },
    ],
  };
}

/** Routed on CallOpts.workflow. Anything unknown gets an empty object. */
export function mockFor(workflow: string, cached: string, prompt: string): unknown {
  if (workflow === 'planner_create' || workflow === 'planner_adapt') return mockPlan(cached, prompt);
  if (workflow === 'lesson_evaluation') return mockEvaluation(prompt);
  if (workflow === 'quality_gate') return mockGate();
  return {};
}
