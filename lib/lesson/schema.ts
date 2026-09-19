/**
 * The lesson deck content model.
 *
 * WHY NOT THE STUDY PACK'S BLOCKS. A study pack is a document a learner reads
 * alone, at a desk, at their own pace: a page can carry six note cards, a ten
 * question drill and a glossary, because the reader can stop. A slide is read by
 * a room, from four metres away, while somebody talks over it. The two have
 * different limits, different layouts and different reasons to exist, so the
 * lesson has its own vocabulary. What it borrows from the pack is the one thing
 * that must not fork: PackObjective and ObjectiveSource, the contract that says
 * where an objective came from. That is provenance, not layout.
 *
 * THE FOUNDING RULE, unchanged from every other artefact here: the model never
 * writes an objective. It selects `objective_indexes` into a list it was given,
 * so a deck cannot cite a code the school's curriculum does not hold.
 *
 * WHAT IS NEW, and is the whole point of the feature: every slide carries a
 * `purpose` - one sentence saying why this slide exists - and a `teacher` note
 * that never appears on the screen. A slide whose purpose cannot be stated is a
 * slide that should not have been generated, and the gate blocks on it.
 *
 * The JSON Schemas are built with the strict-mode primitives in
 * lib/jsonschema.ts: every property in `required`, no extras, optional fields
 * nullable. Counts and bounds are absent by necessity and enforced afterwards
 * in lib/lesson/repair.ts.
 */
import {
  obj, str, nstr, int, nint, num, nnum, bool, arr, lit, oneOf, type JSchema,
} from '@/lib/jsonschema';
import { ACCENTS, type Accent, type PackObjective } from '@/lib/studypack/schema';

export type { Accent, PackObjective };
export { ACCENTS };

// --------------------------------------------------------------------- phases

/**
 * What part of the lesson a slide belongs to.
 *
 * This is not a fixed running order. lib/lesson/architecture.ts decides which of
 * these phases a particular lesson needs and how long each gets, from the
 * duration, the age of the class and the number of objectives - a forty minute
 * lesson for eight year olds is not a shortened eighty minute A Level lesson.
 * The phase is on the slide so the timing, the teacher guide and the gate can
 * all reason about it.
 */
export const LESSON_PHASES = [
  'title',        // what we are doing today
  'objectives',   // what you will be able to do by the end
  'retrieval',    // what we already know, recalled before it is needed
  'hook',         // the question that makes the lesson worth sitting through
  'concept',      // the new idea, named
  'explanation',  // the idea, taught
  'visual',       // the idea, drawn
  'guided',       // we do one together
  'interaction',  // you think, talk or decide
  'independent',  // you do one alone
  'assessment',   // do you have it
  'summary',      // what we did
  'exit',         // the ticket out of the door
] as const;
export type LessonPhase = (typeof LESSON_PHASES)[number];

export const PHASE_LABEL: Record<LessonPhase, string> = {
  title: 'Introduction',
  objectives: 'Learning objectives',
  retrieval: 'Retrieval',
  hook: 'Hook',
  concept: 'New concept',
  explanation: 'Explanation',
  visual: 'Visual explanation',
  guided: 'Guided practice',
  interaction: 'Student interaction',
  independent: 'Independent practice',
  assessment: 'Check for understanding',
  summary: 'Summary',
  exit: 'Exit ticket',
};

/**
 * Who the slide is for.
 *
 * A teacher-led slide supports an explanation; a student-facing slide asks the
 * room to think, say, work out, sort, predict or decide. The distinction is not
 * decoration - the gate counts student-facing slides and blocks a deck that is
 * a lecture, and the renderer marks them so a teacher can see at a glance where
 * the class does something.
 */
export type Audience = 'teacher_led' | 'student_facing';

// --------------------------------------------------------------------- blocks

export const SLIDE_BLOCKS = [
  // explanation
  'statement', 'bullets', 'definition', 'steps', 'worked_example', 'compare',
  'table', 'code',
  // visual
  'diagram', 'chart', 'image',
  // student-facing
  'question', 'mcq', 'true_false', 'predict', 'sort', 'error_spot',
  'scenario', 'discuss', 'task', 'exit_ticket',
] as const;
export type SlideBlockType = (typeof SLIDE_BLOCKS)[number];

/** The blocks that put the class to work. The gate counts slides carrying one. */
export const STUDENT_BLOCKS: SlideBlockType[] = [
  'question', 'mcq', 'true_false', 'predict', 'sort', 'error_spot',
  'scenario', 'discuss', 'task', 'exit_ticket',
];

/** The blocks that teach by showing rather than telling. */
export const VISUAL_BLOCKS: SlideBlockType[] = ['diagram', 'chart', 'image', 'table'];

/** The blocks that carry an answer the teacher reveals. */
export const ANSWER_BLOCKS: SlideBlockType[] = [
  'question', 'mcq', 'true_false', 'predict', 'error_spot', 'exit_ticket', 'worked_example',
];

/**
 * What the outline pass may choose from.
 *
 * `image` is absent for the same reason it is absent from the study pack's
 * outline: a picture belongs to a deck once a teacher has handed one over or
 * asked for one to be drawn, and a planning pass offered `image` would build a
 * slide around a file that does not exist.
 */
export const OUTLINE_BLOCKS = SLIDE_BLOCKS.filter(t => t !== 'image');

/**
 * The shapes a diagram can be.
 *
 * Structure, drawn from data, in SVG - which prints at any size, never gets a
 * label wrong, and costs nothing per slide. The subject profile decides which of
 * these a lesson may use, so a history deck is never offered a number line.
 * Fields a kind does not use are null or empty, because strict structured
 * output requires every property.
 *   flow        - nodes in order, joined left to right
 *   cycle       - nodes around a ring
 *   timeline    - nodes along a dated line, in order
 *   number_line - from/to/step, with marks called out on it
 *   bar_model   - parts drawn to width as a proportion of their total
 *   grid        - headers across the top, nodes filling the cells in order
 *   tree        - a root and its branches, for a hierarchy or a decision
 *   venn        - two overlapping sets: parts[0] and parts[1] label them,
 *                 nodes[0..] are placed left, overlap, right by their note
 *   labelled    - a central subject with callout labels around it
 */
export const DIAGRAM_KINDS = [
  'flow', 'cycle', 'timeline', 'number_line', 'bar_model', 'grid', 'tree', 'venn', 'labelled',
] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export interface StatementBlock {
  type: 'statement';
  /** The idea itself, in one sentence. Set large; it is the slide. */
  text: string;
  /** A source, a caveat, or the name of the rule. Null on most slides. */
  attribution: string | null;
}
export interface BulletsBlock {
  type: 'bullets'; heading: string | null; items: string[];
}
export interface DefinitionBlock {
  type: 'definition'; term: string; meaning: string; example: string | null;
}
export interface StepsBlock {
  type: 'steps'; heading: string | null; steps: string[];
}
export interface WorkedExampleBlock {
  type: 'worked_example';
  prompt: string; steps: string[]; answer: string;
  /** True when the answer is held back until the class has tried it. */
  reveal: boolean;
}
export interface CompareBlock {
  type: 'compare'; heading: string | null;
  columns: { heading: string; points: string[] }[];
}
export interface TableBlock {
  type: 'table'; headers: string[]; rows: { cells: string[] }[]; note: string | null;
}
export interface CodeBlock {
  type: 'code'; language: string; lines: string[]; caption: string | null;
}
export interface DiagramBlock {
  type: 'diagram'; kind: DiagramKind;
  title: string | null; caption: string | null;
  nodes: { label: string; note: string | null }[];
  headers: string[];
  from: number | null; to: number | null; step: number | null;
  marks: { at: number; label: string }[];
  parts: { label: string; value: number }[];
}
export interface ChartBlock {
  type: 'chart'; kind: 'bar' | 'line'; title: string; unit: string | null;
  series: { label: string; value: number }[];
  note: string | null;
}
/**
 * A picture the teacher put in the deck, or asked to have drawn.
 * `alt` is not optional: a slide is projected, printed and sometimes read aloud,
 * and a picture nobody can describe is a picture doing no teaching.
 */
export interface ImageBlock {
  type: 'image'; asset_id: string; alt: string; caption: string | null;
}
export interface QuestionBlock {
  type: 'question'; question: string;
  /** How to answer it - "in your book", "hands down, think first". */
  prompt: string | null;
  answer: string; misconception: string | null;
}
export interface McqBlock {
  type: 'mcq'; question: string; options: string[];
  /** Index into `options`. */
  correct: number;
  /**
   * Why each wrong option is tempting, in the same order as `options`. This is
   * what makes a multiple-choice question diagnostic rather than a guess: a
   * hinge question is only useful if the teacher knows what choosing B means.
   */
  why_wrong: string[];
  explain: string;
}
export interface TrueFalseBlock {
  type: 'true_false';
  statements: { text: string; is_true: boolean; why: string }[];
}
export interface PredictBlock {
  type: 'predict'; setup: string; question: string;
  /** What actually happens, shown after they have committed. */
  answer: string;
  misconception: string | null;
}
export interface SortBlock {
  type: 'sort'; instruction: string; categories: string[];
  /** `category` is the index into `categories` this item belongs in. */
  items: { text: string; category: number }[];
}
export interface ErrorSpotBlock {
  type: 'error_spot'; instruction: string;
  /** The work as a learner would have written it, wrong. */
  work: string[];
  /** Which line is wrong, zero-based; -1 when the error spans the whole. */
  wrong_line: number;
  error: string; correction: string;
}
export interface ScenarioBlock {
  type: 'scenario'; context: string; task: string; prompts: string[];
}
export interface DiscussBlock {
  type: 'discuss'; prompt: string;
  structure: 'think_pair_share' | 'pairs' | 'groups' | 'whole_class';
  minutes: number;
  /** What the teacher asks for when the room comes back together. */
  share_back: string | null;
}
export interface TaskBlock {
  type: 'task'; instruction: string;
  questions: { text: string; marks: number | null }[];
  /** For a learner who cannot get started, and for one who finishes early. */
  support: string | null; extension: string | null;
}
export interface ExitTicketBlock {
  type: 'exit_ticket'; question: string; answer: string; success_criteria: string[];
}

export type SlideBlock =
  | StatementBlock | BulletsBlock | DefinitionBlock | StepsBlock | WorkedExampleBlock
  | CompareBlock | TableBlock | CodeBlock | DiagramBlock | ChartBlock | ImageBlock
  | QuestionBlock | McqBlock | TrueFalseBlock | PredictBlock | SortBlock
  | ErrorSpotBlock | ScenarioBlock | DiscussBlock | TaskBlock | ExitTicketBlock;

// ---------------------------------------------------------------- the slide

/**
 * What the teacher sees and the class does not.
 *
 * This is the half of the feature that makes a deck a lesson. The same
 * generated object is a student presentation and a teaching guide, and these
 * fields are the guide: they go in the inspector in the editor, in the notes
 * pane of the exported PowerPoint, and nowhere on the projected slide.
 */
export interface TeacherNote {
  /** What this slide is doing, in teaching terms. */
  intention: string;
  /** A suggested explanation, in the register a teacher would actually use. */
  say: string;
  /** What a learner who has understood will answer. Null on a slide with no question. */
  expect: string | null;
  /** What to watch for. The most useful field on the slide. */
  misconceptions: string[];
  /** Where to go next if they have it. */
  follow_up: string | null;
  /** What to cut if the lesson is running late. */
  timing_note: string | null;
}

/**
 * How the slide is composed.
 *
 * Chosen by code (lib/lesson/repair.ts, settleLayout) from the blocks and the
 * phase, never by the model. Layout is a deterministic consequence of content,
 * and asking a language model to pick one only introduces a way for it to be
 * wrong.
 */
export const SLIDE_LAYOUTS = [
  'title', 'objectives', 'statement', 'bullets', 'split', 'visual_full',
  'visual_caption', 'worked', 'question', 'quiz', 'task', 'summary', 'divider',
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export interface Slide {
  id: string;
  phase: LessonPhase;
  audience: Audience;
  /** "RETRIEVAL - 5 MIN". Composed by code from the phase and the minutes. */
  eyebrow: string | null;
  /** The one idea, as a heading. */
  title: string;
  /**
   * Why this slide exists. One sentence, in instructional terms.
   *
   * The gate blocks a deck whose slide cannot say this, which is the mechanism
   * behind the product rule: if a slide does not contribute to the objective, it
   * should not be in the lesson. It is shown to the teacher in the editor so
   * they can disagree with it.
   */
  purpose: string;
  minutes: number;
  objective_indexes: number[];
  blocks: SlideBlock[];
  teacher: TeacherNote;
  accent: Accent;
  layout: SlideLayout;
  /**
   * How the teacher wants the blocks arranged, when they have said.
   *
   * `layout` stays the code's reading of the content and is never set by hand -
   * it drives which composition a block gets. This is the one thing about the
   * arrangement a teacher legitimately knows better than a rule: whether the
   * diagram and its question sit side by side or one above the other, and
   * whether a single idea should fill the slide. Absent means `auto`.
   */
  arrange?: Arrangement;
}

export const ARRANGEMENTS = ['auto', 'side', 'stacked', 'focus'] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

export const ARRANGE_LABEL: Record<Arrangement, string> = {
  auto: 'Automatic',
  side: 'Side by side',
  stacked: 'One above the other',
  focus: 'Centred and large',
};

/**
 * One formative assessment question, tied to the objective it checks.
 *
 * Kept as a flat list on the deck as well as inside the slides, because the
 * question a teacher asks about assessment is "which objective is not checked
 * anywhere", and that is a query over this list rather than a walk of the
 * slides. The gate uses it for exactly that.
 */
export interface AssessmentItem {
  slide_id: string;
  objective_index: number;
  question: string;
  answer: string;
  misconception: string | null;
}

export interface LessonMeta {
  subject: string;
  subjectName: string;
  yearGroup: string;
  ageBand: string;
  subjectProfile: string;
  topic: string;
  subtopic: string | null;
  duration_minutes: number;
  key_question: string | null;
  prior_knowledge: string | null;
  context: string | null;
  approach: string | null;
  /** The framework the objectives came from, for the footer. */
  curriculum: string | null;
  className: string | null;
  weekNumber: number | null;
}

export interface PhaseAllocation {
  phase: LessonPhase;
  minutes: number;
  label: string;
  /** How many slides this phase was budgeted. */
  slides: number;
}

export interface LessonDeck {
  version: 1;
  /** Which of lib/studypack/themes.ts this deck wears. */
  theme: string;
  title: string;
  subtitle: string | null;
  meta: LessonMeta;
  objectives: PackObjective[];
  /** The timing plan, computed before any slide was written. */
  timing: PhaseAllocation[];
  slides: Slide[];
  /** The union of resolved codes, for the bank's work key and search. */
  objective_refs: string[];
  assessment: AssessmentItem[];
  /** Why a render degraded, when one did. Null when everything worked. */
  render_note?: string | null;
}

// ------------------------------------------------------------ improving

/**
 * The eight things a teacher actually wants changed about a slide.
 *
 * Here rather than in lib/lesson/improve.ts because the editor is a client
 * component and needs the labels to draw the menu. improve.ts imports the LLM
 * client, sharp and pptxgenjs; this module imports nothing that cannot run in a
 * browser, and that boundary is the whole reason the list lives here.
 *
 * A named action rather than a free-text box because these eight are knowable
 * and pressing one is faster than typing. Free text is accepted as well, and
 * goes in beside the action.
 */
export const IMPROVE_ACTIONS = [
  'simpler', 'shorter', 'visual', 'interactive', 'harder',
  'example', 'real_world', 'explain_differently',
] as const;
export type ImproveAction = (typeof IMPROVE_ACTIONS)[number];

export const IMPROVE_LABEL: Record<ImproveAction, string> = {
  simpler: 'Make it simpler',
  shorter: 'Reduce the text',
  visual: 'Make it more visual',
  interactive: 'Make it more interactive',
  harder: 'Increase the difficulty',
  example: 'Add an example',
  real_world: 'Add a real-world scenario',
  explain_differently: 'Explain it differently',
};

// -------------------------------------------------------------- outline pass

export interface OutlineSlide {
  id: string;
  phase: LessonPhase;
  audience: Audience;
  title: string;
  purpose: string;
  minutes: number;
  objective_indexes: number[];
  block_types: SlideBlockType[];
}

export interface LessonOutline {
  title: string;
  subtitle: string | null;
  slides: OutlineSlide[];
}

// -------------------------------------------------------------- JSON Schemas

/** One schema per block type, so a fill call can be narrowed to the types the
 *  outline actually chose - a smaller union is a more reliable one. */
const BLOCK_SCHEMA: Record<SlideBlockType, JSchema> = {
  statement: obj({ type: lit('statement'), text: str, attribution: nstr }),
  bullets: obj({ type: lit('bullets'), heading: nstr, items: arr(str) }),
  definition: obj({ type: lit('definition'), term: str, meaning: str, example: nstr }),
  steps: obj({ type: lit('steps'), heading: nstr, steps: arr(str) }),
  worked_example: obj({
    type: lit('worked_example'), prompt: str, steps: arr(str), answer: str, reveal: bool,
  }),
  compare: obj({
    type: lit('compare'), heading: nstr,
    columns: arr(obj({ heading: str, points: arr(str) })),
  }),
  table: obj({
    type: lit('table'), headers: arr(str), rows: arr(obj({ cells: arr(str) })), note: nstr,
  }),
  code: obj({ type: lit('code'), language: str, lines: arr(str), caption: nstr }),
  diagram: obj({
    type: lit('diagram'), kind: oneOf(DIAGRAM_KINDS), title: nstr, caption: nstr,
    nodes: arr(obj({ label: str, note: nstr })),
    headers: arr(str),
    from: nnum, to: nnum, step: nnum,
    marks: arr(obj({ at: num, label: str })),
    parts: arr(obj({ label: str, value: num })),
  }),
  chart: obj({
    type: lit('chart'), kind: oneOf(['bar', 'line']), title: str, unit: nstr,
    series: arr(obj({ label: str, value: num })), note: nstr,
  }),
  image: obj({ type: lit('image'), asset_id: str, alt: str, caption: nstr }),
  question: obj({
    type: lit('question'), question: str, prompt: nstr, answer: str, misconception: nstr,
  }),
  mcq: obj({
    type: lit('mcq'), question: str, options: arr(str), correct: int,
    why_wrong: arr(str), explain: str,
  }),
  true_false: obj({
    type: lit('true_false'),
    statements: arr(obj({ text: str, is_true: bool, why: str })),
  }),
  predict: obj({
    type: lit('predict'), setup: str, question: str, answer: str, misconception: nstr,
  }),
  sort: obj({
    type: lit('sort'), instruction: str, categories: arr(str),
    items: arr(obj({ text: str, category: int })),
  }),
  error_spot: obj({
    type: lit('error_spot'), instruction: str, work: arr(str), wrong_line: int,
    error: str, correction: str,
  }),
  scenario: obj({ type: lit('scenario'), context: str, task: str, prompts: arr(str) }),
  discuss: obj({
    type: lit('discuss'), prompt: str,
    structure: oneOf(['think_pair_share', 'pairs', 'groups', 'whole_class']),
    minutes: int, share_back: nstr,
  }),
  task: obj({
    type: lit('task'), instruction: str,
    questions: arr(obj({ text: str, marks: nint })),
    support: nstr, extension: nstr,
  }),
  exit_ticket: obj({
    type: lit('exit_ticket'), question: str, answer: str, success_criteria: arr(str),
  }),
};

const TEACHER_SCHEMA: JSchema = obj({
  intention: str, say: str, expect: nstr,
  misconceptions: arr(str), follow_up: nstr, timing_note: nstr,
});

export function blockUnion(types?: SlideBlockType[]): JSchema {
  const chosen = (types?.length ? [...new Set(types)] : [...SLIDE_BLOCKS])
    .filter((t): t is SlideBlockType => t in BLOCK_SCHEMA);
  const use = chosen.length ? chosen : [...SLIDE_BLOCKS];
  return { anyOf: use.map(t => BLOCK_SCHEMA[t]) };
}

/**
 * The outline pass.
 *
 * `phase` is the full enum rather than the blueprint's subset because strict
 * structured output cannot express "one of these five, which differ per
 * request" without rebuilding the schema per call - and a phase outside the
 * blueprint is repaired deterministically afterwards, which is cheaper than a
 * schema that changes shape and defeats the prompt cache.
 *
 * `block_types` is narrowed to the subject's allowed set, which is the point:
 * the subject profile is enforced by the schema, not asked for in prose.
 */
export function outlineSchema(allowed: SlideBlockType[]): Record<string, unknown> {
  const use = allowed.length ? [...new Set(allowed)] : [...OUTLINE_BLOCKS];
  return obj({
    title: str, subtitle: nstr,
    slides: arr(obj({
      id: str,
      phase: oneOf(LESSON_PHASES),
      audience: oneOf(['teacher_led', 'student_facing']),
      title: str,
      purpose: str,
      minutes: int,
      objective_indexes: arr(int),
      block_types: arr(oneOf(use)),
    })),
  });
}

/**
 * The fill pass, narrowed to the block types this group of slides needs.
 *
 * The teacher note is filled here, with the slide it belongs to, rather than in
 * a pass of its own. A separate pass would double the call count to produce
 * writing about content the same model has just written and would then have to
 * be shown again.
 */
export function fillSchema(types: SlideBlockType[]): Record<string, unknown> {
  return obj({
    slides: arr(obj({
      id: str,
      blocks: arr(blockUnion(types)),
      teacher: TEACHER_SCHEMA,
    })),
  });
}

/** The repair pass: whole replacement slides for the ones the gate refused. */
export function repairSchema(types: SlideBlockType[]): Record<string, unknown> {
  return obj({
    slides: arr(obj({
      id: str,
      title: str,
      purpose: str,
      audience: oneOf(['teacher_led', 'student_facing']),
      minutes: int,
      objective_indexes: arr(int),
      blocks: arr(blockUnion(types)),
      teacher: TEACHER_SCHEMA,
    })),
  });
}

/** One improved slide, in reply to one teacher instruction. */
export function improveSchema(types: SlideBlockType[]): Record<string, unknown> {
  return obj({
    title: str,
    purpose: str,
    audience: oneOf(['teacher_led', 'student_facing']),
    minutes: int,
    blocks: arr(blockUnion(types)),
    teacher: TEACHER_SCHEMA,
    /** One line for the teacher saying what changed and why. */
    note: str,
  });
}
