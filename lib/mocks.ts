/**
 * Fixtures for MOCK_LLM=1 (see lib/llm.ts).
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
  // Indexes, matching the real schema: `  [0] 4Np.03 \u2014 ...`. The fixture used to
  // read references off the prompt, which meant MOCK_LLM never exercised the
  // index-to-reference resolution the live path depends on \u2014 so the tagging bug
  // it exists to catch could not have shown up here.
  const n = objectiveCount(prompt);
  const all = Array.from({ length: n }, (_, i) => i);
  return {
    formatted_comment:
      'Most of the class regrouped confidently by the end of the period. A small group still needed the '
      + 'blocks in front of them, and rounding upwards from a five was not secure.',
    landed: all.slice(0, Math.max(1, n - 1)),
    flagged: n > 1 ? all.slice(-1) : [],
    clarifying_question: null,
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

/**
 * A study pack, read off the same cached registry block the model sees:
 * `Week N: label` headers followed by `  [i] ref — text` objective lines. One
 * unit per week, one topic per unit tagging every objective index under it — so
 * the fixture exercises the same index-to-reference resolution the live path
 * does, and the pack it produces satisfies the real gate in lib/studypack.ts.
 */
export function mockPack(cached: string) {
  const units: {
    unit_label: string; summary: string;
    topics: { topic_label: string; objective_indexes: number[]; key_ideas: string[];
      quiz: { q: string; options: string[]; correct: number; explain: string }[]; think_question: string }[];
  }[] = [];
  let cur: (typeof units)[number] | null = null;

  for (const line of cached.split('\n')) {
    const week = line.match(/^Week (\d+):\s*(.*)$/);
    if (week) {
      cur = { unit_label: `Week ${week[1]}: ${week[2].trim()}`.slice(0, 80), summary: week[2].trim(),
              topics: [{ topic_label: week[2].trim().slice(0, 60) || `Week ${week[1]}`,
                         objective_indexes: [], key_ideas: [], quiz: [], think_question: '' }] };
      units.push(cur);
      continue;
    }
    const idx = line.match(/^\s*\[(\d+)\]/);
    if (idx && cur) cur.topics[0].objective_indexes.push(+idx[1]);
  }

  for (const u of units) {
    const t = u.topics[0];
    t.key_ideas = [
      'Recap the key vocabulary before reading the passage.',
      'Model the skill once, then let learners try it in pairs.',
      'Check understanding with a short question before moving on.',
    ];
    t.quiz = [
      { q: 'What should you do before reading a new passage?', options: ['Skip the title', 'Recap key vocabulary', 'Close the book'], correct: 1, explain: 'Recapping vocabulary makes the passage easier to follow.' },
      { q: 'How is a skill best practised?', options: ['Watching only', 'In pairs after a model', 'Never'], correct: 1, explain: 'Modelling then paired practice embeds the skill.' },
    ];
    t.think_question = 'How would you explain this topic to a classmate who missed the lesson?';
  }

  return {
    title: 'Revision pack',
    units: units.filter(u => u.topics[0].objective_indexes.length),
    glossary: [
      { term: 'Fiction', definition: 'A text that tells an imagined story.' },
      { term: 'Non-fiction', definition: 'A text about real facts and information.' },
    ],
  };
}

/**
 * A worksheet, read off the same cached registry block the model sees: one
 * `[i] ref — text` line per objective. Produces one differentiated task per
 * objective (up to six), each tagging that objective's index — so the fixture
 * exercises the same index-to-reference resolution the live path does, and the
 * three tiers and answer key the Standard's gate checks are all present.
 */
export function mockWorksheet(cached: string) {
  const idxs = [...cached.matchAll(/^\s*\[(\d+)\]/gm)].map(m => +m[1]).slice(0, 6);
  const tasks = (idxs.length ? idxs : [0]).map((i, n) => ({
    objective_indexes: [i],
    core: `Task ${n + 1}: complete the questions on the topic, showing your working.`,
    support: 'Use the worked example at the top of the sheet, and the sentence stem provided, to start.',
    extension: 'Explain, in a sentence, why your method works - and try it on a harder example of your own.',
    answer: 'Answers vary; accept correct working consistent with the objective.',
  }));
  return {
    title: 'Practice worksheet',
    intro: 'Work through the tasks in order. Ask for the Support box if you need a way in.',
    tasks,
  };
}

/**
 * A photographed worksheet, transcribed.
 *
 * The point of the fixture is the same as the others: exercise what the live path
 * exercises. So it carries objective codes in the shape lib/ingest/reconcile.ts
 * matches on - one that the seeded registry holds and one that it does not - and
 * the upload route then genuinely resolves the first and reports the second,
 * rather than the whole reconciliation being skipped under MOCK_LLM.
 */
export function mockOcr() {
  return [
    'CP4 English - Week 10 worksheet',
    '',
    'Objectives: 4Ri.04, 4Ri.02, 9Zz.99',
    '',
    'Task 1. Read the passage below and write down three facts you learned.',
    'Task 2. Underline the words that tell you this is a non-fiction text.',
    'Task 3. Explain, in one sentence, how the pictures help the reader.',
  ].join('\n');
}

/**
 * A question answered from the school's records.
 *
 * `kind: 'records'` on purpose: it is the branch that renders as a plain answer,
 * so the fixture exercises the path a teacher actually sees rather than the two
 * that decline. The other two kinds are one field apart and are covered by
 * asking for real.
 */
export function mockAsk(prompt: string) {
  const q = (prompt.split('THE QUESTION:')[1] ?? prompt).trim();
  return {
    kind: 'records',
    answer: `The school opens on Monday 24 August 2026, the first teaching week of Semester 1. `
      + `(Fixture answer, standing in for: ${q.slice(0, 80)})`,
  };
}

/** Routed on CallOpts.workflow. Anything unknown gets an empty object. */
export function mockFor(workflow: string, cached: string, prompt: string): unknown {
  if (workflow === 'planner_create' || workflow === 'planner_adapt') return mockPlan(cached, prompt);
  if (workflow === 'lesson_evaluation') return mockEvaluation(prompt);
  if (workflow === 'quality_gate') return mockGate();
  if (workflow === 'studypack_create') return mockPack(cached);
  if (workflow === 'worksheet_create') return mockWorksheet(cached);
  // Plain text, not JSON: the OCR call has no schema, so lib/llm.ts returns
  // whatever the fixture is verbatim.
  if (workflow === 'ocr_extract') return mockOcr();
  if (workflow === 'school_question') return mockAsk(prompt);
  return {};
}
