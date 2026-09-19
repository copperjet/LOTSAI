/**
 * The shape of the lesson, decided before a word of it is written.
 *
 * WHY THIS IS CODE AND NOT A PROMPT. "Allocate time to the introduction, the
 * explanation, the activities, the practice, the assessment and the reflection"
 * is arithmetic. A model asked to do it produces a plausible list that does not
 * add up to the lesson, and then writes twelve slides for a forty minute period.
 * Doing it here means the phase plan is exact, free, identical every time, and
 * available to the prompt, the renderer, the editor's running total and the gate
 * as the same set of numbers.
 *
 * WHAT VARIES THE SHAPE, in order of how much it matters:
 *   - the duration. Forty minutes is not half of eighty; the fixed costs of
 *     starting and ending a lesson do not halve with it.
 *   - the age of the class (lib/lesson/ages.ts). Younger learners get more
 *     interaction and shorter explanations, and that is a multiplier here
 *     rather than an instruction in a prompt.
 *   - the teacher's stated approach. A practice lesson and a discussion lesson
 *     with the same objectives are not the same lesson.
 *   - the number of objectives, which is capped: a forty minute lesson cannot
 *     teach six objectives, and the honest thing is to say which ones it will
 *     leave for next time rather than to pretend.
 *
 * Nothing here is a rule about what a good lesson contains. It is a budget. The
 * model decides what goes in each phase; this decides how much room there is.
 */
import type { AgeBand } from './ages';
import { LESSON_PHASES, PHASE_LABEL, type LessonPhase, type PhaseAllocation } from './schema';

/**
 * The teaching approach, as the teacher names it in the picker.
 *
 * `balanced` is the default and is what an unrecognised free-text answer falls
 * back to - a teacher who typed something we do not have a weighting for gets a
 * sensible lesson, not an error.
 */
export const APPROACHES = [
  'balanced', 'explain', 'inquiry', 'practice', 'discussion', 'revision', 'practical',
] as const;
export type Approach = (typeof APPROACHES)[number];

export const APPROACH_LABEL: Record<Approach, string> = {
  balanced: 'A balance of teaching and practice',
  explain: 'Direct teaching of something new',
  inquiry: 'Discovery and enquiry',
  practice: 'Mostly practice of something taught',
  discussion: 'Discussion and talk',
  revision: 'Revision of work already covered',
  practical: 'A practical or an investigation',
};

/** What a teacher might type, mapped to an approach we weight. */
export function approachFrom(text: string | null | undefined): Approach {
  const t = String(text ?? '').toLowerCase().trim();
  if (!t) return 'balanced';
  if (APPROACHES.includes(t as Approach)) return t as Approach;
  if (/\b(revis|recap|revision|exam\s*prep|consolidat)/.test(t)) return 'revision';
  if (/\b(practic(al)?|experiment|investigat|lab|workshop|hands)/.test(t)) return 'practical';
  if (/\b(discuss|debate|talk|socratic|seminar)/.test(t)) return 'discussion';
  if (/\b(enquir|inquir|discover|explor|problem[-\s]*solv)/.test(t)) return 'inquiry';
  if (/\b(drill|exercis|practice|fluenc|consolidate)/.test(t)) return 'practice';
  if (/\b(explain|teach|introduc|direct|lecture|new\s*topic|instruct)/.test(t)) return 'explain';
  return 'balanced';
}

/**
 * The body phases and their share of the teaching time, per approach.
 *
 * These are weights, not minutes - they are normalised against whatever time is
 * left after the fixed costs. The numbers are a judgement, and they are written
 * here in one table so that judgement can be argued with and changed in one
 * place rather than found in a prompt.
 */
const BODY_PHASES: LessonPhase[] = [
  'retrieval', 'hook', 'concept', 'explanation', 'visual',
  'guided', 'interaction', 'independent', 'assessment',
];

type Weights = Record<LessonPhase, number>;

function weights(o: Partial<Weights>): Weights {
  const base = Object.fromEntries(LESSON_PHASES.map(p => [p, 0])) as Weights;
  return { ...base, ...o };
}

const APPROACH_WEIGHTS: Record<Approach, Weights> = {
  balanced: weights({
    retrieval: 8, hook: 6, concept: 12, explanation: 18, visual: 10,
    guided: 14, interaction: 10, independent: 14, assessment: 8,
  }),
  explain: weights({
    retrieval: 8, hook: 4, concept: 14, explanation: 24, visual: 12,
    guided: 16, interaction: 6, independent: 10, assessment: 6,
  }),
  inquiry: weights({
    retrieval: 6, hook: 14, concept: 10, explanation: 12, visual: 10,
    guided: 12, interaction: 18, independent: 12, assessment: 6,
  }),
  practice: weights({
    retrieval: 10, hook: 4, concept: 6, explanation: 10, visual: 6,
    guided: 18, interaction: 8, independent: 30, assessment: 8,
  }),
  discussion: weights({
    retrieval: 6, hook: 12, concept: 10, explanation: 12, visual: 8,
    guided: 8, interaction: 30, independent: 8, assessment: 6,
  }),
  revision: weights({
    retrieval: 20, hook: 4, concept: 6, explanation: 12, visual: 8,
    guided: 14, interaction: 10, independent: 16, assessment: 10,
  }),
  practical: weights({
    retrieval: 8, hook: 8, concept: 8, explanation: 12, visual: 10,
    guided: 20, interaction: 10, independent: 18, assessment: 6,
  }),
};

/**
 * How the age of the class bends the weighting.
 *
 * A ten year old cannot watch an explanation for a quarter of an hour, and an A
 * Level class does not need the idea broken into six interactions. This is the
 * age adaptation the brief asks for, expressed where it changes the lesson
 * rather than where it changes the wording.
 */
const AGE_TILT: Record<string, Partial<Weights>> = {
  early:     { explanation: 0.5, concept: 0.6, interaction: 2.0, independent: 0.5, visual: 1.5, assessment: 0.8 },
  primary:   { explanation: 0.7, concept: 0.8, interaction: 1.6, independent: 0.8, visual: 1.3 },
  lower_sec: {},
  upper_sec: { explanation: 1.1, independent: 1.1, interaction: 0.9, assessment: 1.2 },
  advanced:  { explanation: 1.2, independent: 1.2, interaction: 0.8, hook: 0.8, assessment: 1.2 },
};

/**
 * The fixed costs of a lesson, in minutes.
 *
 * A lesson always says what it is doing and what the class will be able to do;
 * it always finishes by saying what happened. Those do not scale with the
 * period, so they are minutes rather than weights - which is precisely why a
 * forty minute lesson is not half an eighty minute one.
 *
 * `exit` is dropped below EXIT_FLOOR: a twenty five minute lesson that spends
 * three of them on an exit ticket has bought the ticket with the teaching.
 */
const OVERHEAD: { phase: LessonPhase; minutes: number }[] = [
  { phase: 'title', minutes: 1 },
  { phase: 'objectives', minutes: 2 },
  { phase: 'summary', minutes: 2 },
  { phase: 'exit', minutes: 3 },
];
const EXIT_FLOOR = 40;
const SUMMARY_FLOOR = 20;

/** Below this, a phase is not worth a slide of its own and its time is folded away. */
const MIN_PHASE_MINUTES = 3;

/**
 * The slides the deck composes from what it already knows - the title, the
 * objectives and the summary. They carry no objective of their own and the class
 * does not work on them, so they are excluded from the interaction arithmetic.
 */
export const COMPOSED_PHASES: LessonPhase[] = ['title', 'objectives', 'summary'];

/**
 * How many slides must put the class to work.
 *
 * Defined once, here, because it is used twice: the blueprint puts it in the
 * prompt and the gate measures the finished deck against it. When those were two
 * expressions they disagreed - a forty minute primary lesson was told to write
 * two and then refused for not having five - and a gate that marks against a
 * rule the generator was never given is worse than no gate.
 *
 * `interactionEvery` is a run length: at most that many teacher-led slides may
 * pass before the class does something. So the minimum count is one student
 * slide per (run + 1) of the slides that could be either - not a ratio of the
 * whole deck, which would count the title and the objectives slide against a
 * lesson for being what they are.
 */
/**
 * How many slides must show rather than tell.
 *
 * Defined here for the same reason minStudentSlides is: the blueprint puts it in
 * the prompt and the gate measures against it. The first real run produced one
 * visual in every thirteen-slide lesson - the prompt had never said a number,
 * and the gate was asking for two.
 */
export function minVisualSlides(total: number, composed: number): number {
  const teachable = Math.max(0, total - composed);
  return Math.max(1, Math.floor(teachable / 4));
}

export function minStudentSlides(total: number, composed: number, band: AgeBand): number {
  const teachable = Math.max(0, total - composed);
  if (teachable <= 2) return teachable;
  return Math.min(teachable, Math.max(2, Math.ceil(teachable / (band.interactionEvery + 1))));
}

export interface BlueprintInput {
  durationMinutes: number;
  band: AgeBand;
  approach: Approach;
  objectiveCount: number;
}

export interface Blueprint {
  durationMinutes: number;
  approach: Approach;
  /** In running order, minutes summing exactly to the duration. */
  phases: PhaseAllocation[];
  /** The total slide budget the outline is given. */
  slideBudget: number;
  /** How many objectives this lesson can honestly carry. */
  objectiveBudget: number;
  /** Slides that must put the class to work, for the gate and the prompt. */
  minStudentSlides: number;
  /** Slides that must carry a diagram, chart, table or picture. */
  minVisualSlides: number;
  /** At most this many teacher-led slides in a row, from the age band. */
  maxTeacherRun: number;
}

/**
 * How many objectives fit in the time.
 *
 * Roughly one objective per twenty minutes of teaching time, floored at one and
 * capped by the age band - a primary class does not get four objectives in an
 * hour however the arithmetic falls. A teacher who selected six for a forty
 * minute lesson is told which ones the deck covers and which are left, because
 * a deck that silently addresses two of six and says nothing is the failure
 * mode that matters.
 */
export function objectiveBudget(durationMinutes: number, band: AgeBand): number {
  const byTime = Math.max(1, Math.floor(durationMinutes / 20));
  const byAge = band.id === 'early' ? 1 : band.id === 'primary' ? 2 : band.id === 'lower_sec' ? 3 : 4;
  return Math.min(byTime, byAge);
}

export function blueprint(input: BlueprintInput): Blueprint {
  const duration = Math.max(10, Math.round(input.durationMinutes || 60));
  const band = input.band;
  const approach = input.approach;

  // 1. Fixed costs first. What is left is the teaching time.
  const overhead = OVERHEAD.filter(o => {
    if (o.phase === 'exit') return duration >= EXIT_FLOOR;
    if (o.phase === 'summary') return duration >= SUMMARY_FLOOR;
    return true;
  });
  const overheadTotal = overhead.reduce((n, o) => n + o.minutes, 0);
  // Never let the overhead eat a short lesson: cap it at a fifth of the period.
  const scale = overheadTotal > duration * 0.2 ? (duration * 0.2) / overheadTotal : 1;
  const fixed = overhead.map(o => ({ ...o, minutes: Math.max(1, Math.round(o.minutes * scale)) }));
  const fixedTotal = fixed.reduce((n, o) => n + o.minutes, 0);
  const body = Math.max(MIN_PHASE_MINUTES, duration - fixedTotal);

  // 2. Weight the body phases by approach, then tilt for age.
  const tilt = AGE_TILT[band.id] ?? {};
  const raw = new Map<LessonPhase, number>();
  for (const p of BODY_PHASES) {
    const w = APPROACH_WEIGHTS[approach][p] * (tilt[p] ?? 1);
    if (w > 0) raw.set(p, w);
  }
  const totalWeight = [...raw.values()].reduce((n, w) => n + w, 0) || 1;

  // 3. Weights to minutes, dropping phases too small to be a slide. Their time
  //    goes back into the pool, so nothing is lost and the total still lands.
  let kept = new Map<LessonPhase, number>();
  for (const [p, w] of raw) {
    const mins = (w / totalWeight) * body;
    if (mins >= MIN_PHASE_MINUTES) kept.set(p, mins);
  }
  // A very short lesson can lose everything; keep the spine so it is still a lesson.
  if (!kept.size) {
    kept = new Map<LessonPhase, number>([
      ['explanation', body * 0.5], ['guided', body * 0.25], ['assessment', body * 0.25],
    ]);
  }
  const keptTotal = [...kept.values()].reduce((n, m) => n + m, 0) || 1;
  const bodyMinutes = largestRemainder([...kept.entries()].map(([p, m]) => ({
    key: p, share: m / keptTotal,
  })), body);

  // 4. Assemble in running order.
  const minutesOf = new Map<LessonPhase, number>();
  for (const f of fixed) minutesOf.set(f.phase, f.minutes);
  for (const [p, m] of bodyMinutes) minutesOf.set(p, m);

  const ordered = LESSON_PHASES.filter(p => (minutesOf.get(p) ?? 0) > 0);

  // 5. Slides. A slide is worth a certain number of minutes at this age, so the
  //    budget comes from the band rather than from a fixed deck length - which
  //    is how "do not force every lesson into the same number of slides" is
  //    actually enforced.
  const [lo, hi] = band.minutesPerSlide;
  const perSlide = (lo + hi) / 2;
  const slideBudget = Math.max(
    ordered.length,
    Math.min(28, Math.round(duration / perSlide)),
  );

  const phases: PhaseAllocation[] = ordered.map(phase => {
    const minutes = minutesOf.get(phase) ?? 0;
    // Overhead phases are one slide each; body phases get their share, minimum one.
    const isOverhead = phase === 'title' || phase === 'objectives'
      || phase === 'summary' || phase === 'exit';
    const slides = isOverhead ? 1 : Math.max(1, Math.round(minutes / perSlide));
    return { phase, minutes, label: PHASE_LABEL[phase], slides };
  });

  // Trim the slide counts back to the budget, taking from the largest first so
  // no phase is emptied.
  let planned = phases.reduce((n, p) => n + p.slides, 0);
  while (planned > slideBudget) {
    const biggest = phases
      .filter(p => p.slides > 1)
      .sort((a, b) => b.slides - a.slides)[0];
    if (!biggest) break;
    biggest.slides--;
    planned--;
  }

  const composed = phases
    .filter(p => COMPOSED_PHASES.includes(p.phase))
    .reduce((n, p) => n + p.slides, 0);

  return {
    durationMinutes: duration,
    approach,
    phases,
    slideBudget: planned,
    // Capped by what was actually asked for: a lesson with three objectives has
    // a budget of three however generous the arithmetic is, and reporting four
    // made /api/lesson/match say "4 of 3 objectives".
    minStudentSlides: minStudentSlides(planned, composed, band),
    minVisualSlides: minVisualSlides(planned, composed),
    maxTeacherRun: band.interactionEvery,
    objectiveBudget: Math.min(
      objectiveBudget(duration, band),
      Math.max(1, input.objectiveCount || 1),
    ),
  };
}

/**
 * Distribute a whole number of minutes by share without losing or inventing one.
 *
 * Rounding each share independently is what makes a timing plan that sums to
 * seventy nine minutes for an eighty minute lesson, and a teacher notices that
 * immediately.
 */
function largestRemainder<K>(
  parts: { key: K; share: number }[], total: number,
): Map<K, number> {
  const floors = parts.map(p => {
    const exact = p.share * total;
    const floor = Math.floor(exact);
    return { key: p.key, floor, rest: exact - floor };
  });
  let left = total - floors.reduce((n, f) => n + f.floor, 0);
  floors.sort((a, b) => b.rest - a.rest);
  const out = new Map<K, number>();
  for (const f of floors) {
    out.set(f.key, f.floor + (left > 0 ? 1 : 0));
    if (left > 0) left--;
  }
  return out;
}

/** The blueprint as the lines that go into the prompt. Volatile, so it goes
 *  after the cache breakpoint. */
export function blueprintBlock(b: Blueprint): string {
  const rows = b.phases.map(p =>
    `  ${p.label} - ${p.minutes} min, ${p.slides} slide${p.slides === 1 ? '' : 's'} (phase id: ${p.phase})`);
  return [
    `LESSON PLAN - ${b.durationMinutes} minutes, ${APPROACH_LABEL[b.approach].toLowerCase()}`,
    'Follow this plan. These phases, in this order, with these slide counts:',
    ...rows,
    `Total: ${b.slideBudget} slides. Do not write more or fewer.`,
    `Never more than ${b.maxTeacherRun} teacher_led slide(s) in a row: after that many, the next `
      + 'slide must give the class something to do.',
    `At least ${b.minVisualSlides} slide(s) must carry a diagram, chart or table - show the idea, `
      + 'do not only describe it.',
    'Guided practice is "we do": the class answers each step with you, so a guided slide is '
      + 'student_facing (a question or task with the worked steps in the teacher note), never '
      + 'a worked example they only watch.',
    'Every objective index must appear on at least one student_facing slide where the class '
      + 'practises it - naming an objective on a teacher slide is not teaching it.',
    'The title and learning-objectives slides are drawn from the lesson itself: give them no '
      + 'block types.',
    `At least ${b.minStudentSlides} of them must be student_facing - slides where the class `
      + 'thinks, answers, works out, sorts, predicts, discusses or decides.',
  ].join('\n');
}

/** The timing summary a teacher reads, one line. */
export function timingLine(phases: PhaseAllocation[]): string {
  return phases.map(p => `${p.minutes} min ${p.label.toLowerCase()}`).join(', ');
}
