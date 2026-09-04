/**
 * The study pack v2 content model.
 *
 * A v1 pack was one shape: units -> topics -> {key ideas, quiz, think question}.
 * The school's own packs are not that shape. "CP5 Mathematic StudyPack 1.pdf" is a
 * 16:9 deck of key-notes grids, worked examples and ten-question drills; "GP LS3
 * Study Pack Formative 4.pdf" is A4 landscape with source cards, a claim/reason/
 * evidence table, a bar chart and marked questions with answer space. One fixed
 * schema cannot be both, so v2 is a *vocabulary of blocks* and the model composes
 * the page sequence itself.
 *
 * What does not change is the founding rule: the model never writes an objective.
 * It picks `objective_indexes` into a list supplied to it (PackV2.objectives),
 * exactly as the planner and the v1 pack generator do, so a pack cannot cite a code
 * the school's curriculum does not hold.
 *
 * The JSON Schemas here are built by `obj()`, which lists every property in
 * `required` and sets additionalProperties:false - OpenAI's strict structured
 * output demands both. Optional fields are therefore nullable rather than absent.
 */

// ---------------------------------------------------------------- objectives

/**
 * Where an objective came from.
 *   registry - read straight out of curriculum_week (the normal path)
 *   matched  - a stated outcome in an uploaded file that matched a registry
 *              objective by text; the *registry's* wording is kept, not the file's
 *   file     - the file's own wording, with no registry match. Carried verbatim,
 *              flagged by the gate, and shown to the teacher to confirm.
 * There is deliberately no 'model'. Nothing in this system writes an objective.
 */
export type ObjectiveSource = 'registry' | 'matched' | 'file';

export interface PackObjective {
  ref: string | null;
  text: string;
  source: ObjectiveSource;
  score?: number;          // trigram confidence, only when source === 'matched'
}

// -------------------------------------------------------------------- blocks

export const BLOCK_TYPES = [
  'resources', 'key_notes', 'key_ideas', 'worked_example', 'practice', 'quiz',
  'glossary', 'checklist', 'source_card', 'table', 'chart', 'two_column',
  'callout', 'think', 'reflection', 'contents', 'closing', 'diagram', 'image',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * What the outline pass may choose from.
 *
 * `image` is missing on purpose. A picture belongs to a pack only once a teacher has
 * handed one over or asked for one to be drawn (app/api/studypack/revise), and a
 * generation pass offered `image` would plan a page around a file that does not
 * exist. Every other block type is composed from the objectives and the teacher's
 * own material, so the model may plan with all of them.
 */
export const OUTLINE_BLOCK_TYPES = BLOCK_TYPES.filter(t => t !== 'image');

export interface ResourcesBlock {
  type: 'resources'; intro: string | null;
  groups: { label: string; items: { name: string; why: string; url: string | null }[] }[];
}
export interface KeyNotesBlock {
  type: 'key_notes'; columns: number;
  /**
   * `tile` is a letter or a very short token drawn as a coloured square beside the
   * heading, as the BODMAS column of "CP5 Mathematic StudyPack 1.pdf" does. It is
   * what turns a list of six cards into something a learner can find their place in.
   * Null on a card that is only a heading and a note.
   */
  cards: { heading: string; body: string; tile?: string | null }[];
}
export interface KeyIdeasBlock { type: 'key_ideas'; items: string[] }
export interface WorkedExampleBlock {
  type: 'worked_example'; examples: { prompt: string; steps: string[]; answer: string }[];
}
export interface PracticeBlock {
  type: 'practice'; intro: string | null; columns: number;
  questions: { text: string; marks: number | null; answer_lines: number | null }[];
}
export interface QuizBlock {
  type: 'quiz'; questions: { q: string; options: string[]; correct: number; explain: string }[];
}
export interface GlossaryBlock { type: 'glossary'; terms: { term: string; definition: string }[] }
export interface ChecklistBlock {
  type: 'checklist'; columns: { heading: string; blurb: string | null; items: string[] }[];
}
export interface SourceCardBlock {
  type: 'source_card'; sources: { label: string; text: string; quick_check: string }[];
}
export interface TableBlock {
  type: 'table'; headers: string[]; rows: { cells: string[] }[]; note: string | null;
}
export interface ChartBlock {
  type: 'chart'; kind: 'bar' | 'line'; title: string; unit: string | null;
  series: { label: string; value: number }[];
  aside_heading: string | null; aside_items: string[];
}
export interface TwoColumnBlock {
  type: 'two_column';
  left: { heading: string; body: string }; right: { heading: string; body: string };
}
export interface CalloutBlock {
  type: 'callout'; tone: 'note' | 'tip' | 'warning'; heading: string | null; body: string;
}
export interface ThinkBlock {
  type: 'think'; question: string; resource_name: string | null; resource_url: string | null;
}
export interface ReflectionBlock {
  type: 'reflection'; prompt: string; marks: number | null; self_check: string[];
}
/** Rendered from the page list, not from generated content. */
export interface ContentsBlock { type: 'contents'; heading: string | null }
export interface ClosingBlock { type: 'closing'; heading: string; tips: string[] }

/**
 * A drawn explanation.
 *
 * Asked for an illustration, the honest answer for teaching material is usually a
 * diagram rather than a picture: a number line, a bar model, a place-value grid, the
 * steps of a process. Those are structure, and structure can be composed as data and
 * drawn as SVG - which prints at any size, never gets a label wrong, and costs
 * nothing. `chart` already works this way (renderChart); this is the same idea for
 * the shapes a chart cannot make.
 *
 * A picture that genuinely has to be a picture is an `image` block instead.
 *
 * Fields not used by a kind are null or empty: strict structured output requires
 * every property, so a shape is chosen by `kind` and the rest is left blank.
 *   flow        - `nodes` in order, joined left to right by arrows
 *   cycle       - `nodes` around a ring
 *   number_line - `from`/`to`/`step`, with `marks` called out on it
 *   bar_model   - `parts`, drawn to width as a proportion of their total
 *   grid        - `headers` across the top, `nodes` filling the cells in order
 */
export interface DiagramBlock {
  type: 'diagram';
  kind: 'flow' | 'cycle' | 'number_line' | 'bar_model' | 'grid';
  title: string | null;
  caption: string | null;
  nodes: { label: string; note: string | null }[];
  headers: string[];
  from: number | null; to: number | null; step: number | null;
  marks: { at: number; label: string }[];
  parts: { label: string; value: number }[];
}

/**
 * A picture the teacher put in the pack, or asked to have drawn.
 *
 * `asset_id` addresses a row in `study_pack_asset`; the renderer inlines its bytes as
 * a data URI, because the document has to stay self-contained for the headless print
 * and `/api/document/view` is behind sign-in. An id the store does not hold renders
 * as nothing rather than as a broken image.
 *
 * `alt` is not optional. A pack is read by children, printed, and sometimes read
 * aloud; a picture nobody can describe is a picture doing no teaching.
 */
export interface ImageBlock {
  type: 'image'; asset_id: string; alt: string; caption: string | null;
}

/**
 * How much of the page's width a block takes.
 *
 * Everything used to run the full width, so a two-line callout and a ten-question drill
 * were laid out identically and every page had the same shape. "half" puts a block
 * beside the next one, which is how the school's own packs sit a worked example next to
 * the notes it works from.
 */
export type BlockSpan = 'full' | 'half';

export type Block = (
  | ResourcesBlock | KeyNotesBlock | KeyIdeasBlock | WorkedExampleBlock | PracticeBlock
  | QuizBlock | GlossaryBlock | ChecklistBlock | SourceCardBlock | TableBlock | ChartBlock
  | TwoColumnBlock | CalloutBlock | ThinkBlock | ReflectionBlock | ContentsBlock | ClosingBlock
  | DiagramBlock | ImageBlock
) & { span?: BlockSpan };

// --------------------------------------------------------------------- pages

export type Accent = 'forest' | 'purple' | 'teal' | 'blue' | 'gold';
export const ACCENTS: Accent[] = ['forest', 'purple', 'teal', 'blue', 'gold'];

/**
 * What a page is for.
 *
 * A 'divider' carries a title and nothing else, printed full-bleed in its accent -
 * the "Section 1: Calculations" sheet both of the school's own packs open each topic
 * with. It is what makes a fifteen page document navigable at arm's length. Absent
 * means an ordinary content page, so every pack stored before this reads unchanged.
 */
export type PageRole = 'content' | 'divider';

export interface Page {
  id: string;
  eyebrow: string | null;          // "SECTION A - OBJECTIVE 9E.01" / "Topic 7 - Probability"
  title: string;
  objective_indexes: number[];
  accent: Accent;
  role?: PageRole;
  blocks: Block[];
}

export type PackLayout = 'a4-landscape' | 'slide-16x9';

export interface PackV2 {
  version: 2;
  layout: PackLayout;
  /**
   * What the document calls itself on its cover and in the browser tab. Study packs
   * are not the only thing rendered through this template any more - homework is
   * composed as a pack (lib/homework/render_html.ts) - and a homework whose cover read
   * "STUDY PACK" is telling a child the wrong thing about the paper in their hand.
   * Optional, and it defaults to Study Pack, so nothing stored before this changes.
   */
  kind?: string;
  /**
   * Which of `lib/studypack/themes.ts` this pack wears. Chosen once, at generation,
   * from the subject and the pack's own key, and stored - so a pack looks the same
   * every time it is opened, and the next pack for the same class does not look like
   * it. Absent means the original forest-and-gold design, which is what every pack
   * stored before themes existed still renders as.
   */
  theme?: string;
  title: string;
  subtitle: string | null;
  meta: { subject: string; yearGroup: string; curriculum: string | null; span: string | null };
  objectives: PackObjective[];
  pages: Page[];
  /** The union of resolved codes, for the bank's work key and search. */
  objective_refs: string[];
}

/** The outline pass: page skeletons plus the block types each page will carry. */
export interface OutlinePage {
  id: string; eyebrow: string | null; title: string;
  objective_indexes: number[]; accent: Accent; role: PageRole; block_types: BlockType[];
}
export interface PackOutline {
  title: string; subtitle: string | null; layout: PackLayout; pages: OutlinePage[];
}

// ------------------------------------------------------------- JSON Schemas

type JSchema = Record<string, unknown>;

/** Strict-mode object: every property required, no extras. */
function obj(properties: Record<string, JSchema>): JSchema {
  return {
    type: 'object', additionalProperties: false,
    required: Object.keys(properties), properties,
  };
}
const str: JSchema = { type: 'string' };
const nstr: JSchema = { type: ['string', 'null'] };
const int: JSchema = { type: 'integer' };
const nint: JSchema = { type: ['integer', 'null'] };
const num: JSchema = { type: 'number' };
const nnum: JSchema = { type: ['number', 'null'] };
const arr = (items: JSchema): JSchema => ({ type: 'array', items });
const lit = (v: string): JSchema => ({ type: 'string', enum: [v] });

/** One schema per block type, keyed so a fill call can be narrowed to the types
 *  the outline actually chose - a smaller union is a more reliable one. */
const BLOCK_SCHEMA: Record<BlockType, JSchema> = {
  resources: obj({
    type: lit('resources'), intro: nstr,
    groups: arr(obj({
      label: str,
      items: arr(obj({ name: str, why: str, url: nstr })),
    })),
  }),
  key_notes: obj({
    type: lit('key_notes'), columns: { type: 'integer', enum: [2, 3] },
    cards: arr(obj({ heading: str, body: str, tile: nstr })),
  }),
  key_ideas: obj({ type: lit('key_ideas'), items: arr(str) }),
  worked_example: obj({
    type: lit('worked_example'),
    examples: arr(obj({ prompt: str, steps: arr(str), answer: str })),
  }),
  practice: obj({
    type: lit('practice'), intro: nstr, columns: { type: 'integer', enum: [1, 2] },
    questions: arr(obj({ text: str, marks: nint, answer_lines: nint })),
  }),
  quiz: obj({
    type: lit('quiz'),
    questions: arr(obj({ q: str, options: arr(str), correct: int, explain: str })),
  }),
  glossary: obj({ type: lit('glossary'), terms: arr(obj({ term: str, definition: str })) }),
  checklist: obj({
    type: lit('checklist'),
    columns: arr(obj({ heading: str, blurb: nstr, items: arr(str) })),
  }),
  source_card: obj({
    type: lit('source_card'),
    sources: arr(obj({ label: str, text: str, quick_check: str })),
  }),
  table: obj({
    type: lit('table'), headers: arr(str), rows: arr(obj({ cells: arr(str) })), note: nstr,
  }),
  chart: obj({
    type: lit('chart'), kind: { type: 'string', enum: ['bar', 'line'] }, title: str, unit: nstr,
    series: arr(obj({ label: str, value: num })),
    aside_heading: nstr, aside_items: arr(str),
  }),
  two_column: obj({
    type: lit('two_column'),
    left: obj({ heading: str, body: str }), right: obj({ heading: str, body: str }),
  }),
  callout: obj({
    type: lit('callout'), tone: { type: 'string', enum: ['note', 'tip', 'warning'] },
    heading: nstr, body: str,
  }),
  think: obj({ type: lit('think'), question: str, resource_name: nstr, resource_url: nstr }),
  reflection: obj({ type: lit('reflection'), prompt: str, marks: nint, self_check: arr(str) }),
  contents: obj({ type: lit('contents'), heading: nstr }),
  closing: obj({ type: lit('closing'), heading: str, tips: arr(str) }),
  diagram: obj({
    type: lit('diagram'),
    kind: { type: 'string', enum: ['flow', 'cycle', 'number_line', 'bar_model', 'grid'] },
    title: nstr, caption: nstr,
    nodes: arr(obj({ label: str, note: nstr })),
    headers: arr(str),
    from: nnum, to: nnum, step: nnum,
    marks: arr(obj({ at: num, label: str })),
    parts: arr(obj({ label: str, value: num })),
  }),
  image: obj({ type: lit('image'), asset_id: str, alt: str, caption: nstr }),
};

/** Width is asked of every block type, so it is added to each schema rather than
 *  written out seventeen times. */
function withSpan(schema: JSchema): JSchema {
  const properties = { ...(schema.properties as Record<string, JSchema>), span: { type: 'string', enum: ['full', 'half'] } };
  return { ...schema, properties, required: Object.keys(properties) };
}

export function blockUnion(types?: BlockType[]): JSchema {
  const chosen = (types?.length ? [...new Set(types)] : [...BLOCK_TYPES])
    .filter((t): t is BlockType => t in BLOCK_SCHEMA);
  const use = chosen.length ? chosen : [...BLOCK_TYPES];
  return { anyOf: use.map(t => withSpan(BLOCK_SCHEMA[t])) };
}

export const OUTLINE_SCHEMA: JSchema = obj({
  title: str, subtitle: nstr,
  layout: { type: 'string', enum: ['a4-landscape', 'slide-16x9'] },
  pages: arr(obj({
    id: str, eyebrow: nstr, title: str,
    objective_indexes: arr(int),
    accent: { type: 'string', enum: ACCENTS },
    role: { type: 'string', enum: ['content', 'divider'] },
    block_types: arr({ type: 'string', enum: [...OUTLINE_BLOCK_TYPES] }),
  })),
});

/** The fill pass, narrowed to the block types this group of pages needs. */
export function fillSchema(types: BlockType[]): Record<string, unknown> {
  return obj({
    pages: arr(obj({ id: str, blocks: arr(blockUnion(types)) })),
  });
}
