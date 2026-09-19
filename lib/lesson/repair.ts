/**
 * Everything done to a generated deck without asking a model.
 *
 * Structured output gets the shape right and the quantities wrong. It writes
 * seven bullets where four fit, numbers its own questions when the renderer
 * already numbers them, leaves the `[3]` objective tag it was told to select by
 * inside the prose a child is going to read, and produces slide timings that
 * sum to seventy-one minutes for an eighty minute lesson. None of that needs a
 * second model call to fix, and a second model call would be a worse fix:
 * slower, priced, and not guaranteed to land inside the caps either.
 *
 * So this file is the whole quantitative half of the pipeline. Everything in it
 * is a pure function of data, which is also what makes it the part of the
 * feature that can be checked without a network or a database.
 *
 * The caps come from the age band (lib/lesson/ages.ts) - the same numbers the
 * model was given in its prompt and the same numbers the gate measures against,
 * so a slide is never cut for breaking a rule it was not told.
 */
import type { AgeBand } from './ages';
import {
  ACCENTS, ANSWER_BLOCKS, STUDENT_BLOCKS, VISUAL_BLOCKS,
  type Accent, type AssessmentItem, type LessonDeck, type LessonPhase,
  type Slide, type SlideBlock, type SlideLayout, type TeacherNote,
} from './schema';

/** Words per slide are counted against this, so the title has to be honest. */
const MAX_TITLE_CHARS = 90;
/** A statement is the slide; past this it is a paragraph wearing a large font. */
const MAX_STATEMENT_WORDS = 30;
const MAX_TABLE_COLS = 5;
const MAX_CODE_LINES = 14;
const MAX_MCQ_OPTIONS = 5;
const MAX_STEPS = 7;

// ------------------------------------------------------------------ cleaning

/**
 * House style, enforced rather than requested.
 *
 * Every prompt in this codebase ends "Never use an em dash or an en dash. Use a
 * plain hyphen." Most of the time the model complies. Doing it here means it
 * always holds, including in a slide a teacher typed into and in text that came
 * out of an uploaded PDF.
 */
export function clean(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // NUL and friends: Postgres rejects them inside jsonb, and they arrive from
    // extracted PDF text often enough to matter.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Take the model's own objective tags back out.
 *
 * The objectives are handed over indexed - `[0] 4Np.03 - Add two two-digit
 * numbers` - so the model can select them without writing them. It then
 * sometimes writes "[0]" into the slide text as a citation, which is exactly
 * right for us and meaningless to a class.
 */
export function deIndex(s: unknown): string {
  return clean(String(s ?? '').replace(/\[\s*\d{1,2}\s*\]/g, ' '));
}

/** The renderer numbers questions and steps itself; a model that also numbers
 *  its own text prints "1. 1. Expand the brackets." */
export function unnumber(s: unknown): string {
  return clean(String(s ?? '').replace(/^\s*(?:\d{1,2}|[a-z])\s*[.)]\s+/i, ''));
}

function words(s: unknown): number {
  return String(s ?? '').split(/\s+/).filter(Boolean).length;
}

function cap<T>(list: T[] | null | undefined, n: number): T[] {
  return (list ?? []).slice(0, Math.max(0, n));
}

function trimWords(s: string, max: number): string {
  const w = s.split(/\s+/).filter(Boolean);
  if (w.length <= max) return s;
  return `${w.slice(0, max).join(' ')}...`;
}

// ------------------------------------------------------------ learner-facing

/**
 * Only what the class can see.
 *
 * Answers, explanations, misconceptions and the teacher note are on the object
 * but not on the screen - they are revealed, or they are for the teacher alone.
 * Counting them towards cognitive load would penalise exactly the slides that
 * do the most teaching, which is the wrong incentive to build into the gate.
 */
export function learnerText(b: SlideBlock): string[] {
  switch (b.type) {
    case 'statement': return [b.text, b.attribution ?? ''];
    case 'bullets': return [b.heading ?? '', ...b.items];
    case 'definition': return [b.term, b.meaning, b.example ?? ''];
    case 'steps': return [b.heading ?? '', ...b.steps];
    case 'worked_example': return [b.prompt, ...b.steps, b.reveal ? '' : b.answer];
    case 'compare': return [b.heading ?? '', ...b.columns.flatMap(c => [c.heading, ...c.points])];
    case 'table': return [...b.headers, ...b.rows.flatMap(r => r.cells), b.note ?? ''];
    case 'code': return [...b.lines, b.caption ?? ''];
    case 'diagram': return [b.title ?? '', b.caption ?? '',
      ...b.nodes.flatMap(n => [n.label, n.note ?? '']),
      ...b.headers, ...b.marks.map(m => m.label), ...b.parts.map(x => x.label)];
    case 'chart': return [b.title, b.unit ?? '', b.note ?? '', ...b.series.map(s => s.label)];
    case 'image': return [b.caption ?? ''];
    case 'question': return [b.question, b.prompt ?? ''];
    case 'mcq': return [b.question, ...b.options];
    case 'true_false': return b.statements.map(s => s.text);
    case 'predict': return [b.setup, b.question];
    case 'sort': return [b.instruction, ...b.categories, ...b.items.map(i => i.text)];
    case 'error_spot': return [b.instruction, ...b.work];
    case 'scenario': return [b.context, b.task, ...b.prompts];
    case 'discuss': return [b.prompt];
    case 'task': return [b.instruction, ...b.questions.map(q => q.text),
      b.support ?? '', b.extension ?? ''];
    case 'exit_ticket': return [b.question, ...b.success_criteria];
    default: return [];
  }
}

/** Every word the class reads on this slide, the title included. */
export function slideWords(s: Slide): number {
  return words(s.title) + s.blocks.reduce((n, b) => n + learnerText(b).reduce((m, t) => m + words(t), 0), 0);
}

/** Mean sentence length across the learner-facing prose. */
export function meanSentenceWords(s: Slide): number {
  const prose = s.blocks.flatMap(learnerText).join(' ');
  const sentences = prose.split(/[.!?]+/).map(x => x.trim()).filter(x => words(x) > 1);
  if (!sentences.length) return 0;
  return sentences.reduce((n, x) => n + words(x), 0) / sentences.length;
}

export function hasStudentBlock(s: Slide): boolean {
  return s.blocks.some(b => STUDENT_BLOCKS.includes(b.type));
}

export function hasVisualBlock(s: Slide): boolean {
  return s.blocks.some(b => VISUAL_BLOCKS.includes(b.type));
}

export function hasAnswerBlock(s: Slide): boolean {
  return s.blocks.some(b => ANSWER_BLOCKS.includes(b.type));
}

// ------------------------------------------------------------- block repair

/**
 * One block, brought inside the caps.
 *
 * Returns null when there is nothing left worth drawing. A block that lost its
 * content is removed rather than rendered as an empty box with a heading, which
 * is what the study pack learned the hard way.
 */
export function repairBlock(raw: SlideBlock, band: AgeBand): SlideBlock | null {
  const items = band.maxItemsPerBlock;
  const b = raw as SlideBlock & Record<string, unknown>;

  switch (b.type) {
    case 'statement': {
      const text = trimWords(deIndex(b.text), MAX_STATEMENT_WORDS);
      if (!text) return null;
      return { type: 'statement', text, attribution: nullable(b.attribution) };
    }
    case 'bullets': {
      const list = cap(b.items, items).map(deIndex).filter(Boolean);
      if (!list.length) return null;
      return { type: 'bullets', heading: nullable(b.heading), items: list };
    }
    case 'definition': {
      const term = deIndex(b.term), meaning = deIndex(b.meaning);
      if (!term || !meaning) return null;
      return { type: 'definition', term, meaning, example: nullable(b.example) };
    }
    case 'steps': {
      const steps = cap(b.steps, Math.min(MAX_STEPS, items + 2)).map(unnumber).filter(Boolean);
      if (!steps.length) return null;
      return { type: 'steps', heading: nullable(b.heading), steps };
    }
    case 'worked_example': {
      const prompt = deIndex(b.prompt);
      const steps = cap(b.steps, MAX_STEPS).map(unnumber).filter(Boolean);
      if (!prompt || !steps.length) return null;
      return {
        type: 'worked_example', prompt, steps,
        answer: deIndex(b.answer), reveal: b.reveal !== false,
      };
    }
    case 'compare': {
      const columns = cap(b.columns, 3)
        .map(c => ({
          heading: deIndex(c?.heading),
          points: cap(c?.points, items).map(deIndex).filter(Boolean),
        }))
        .filter(c => c.heading || c.points.length);
      if (columns.length < 2) return null;
      return { type: 'compare', heading: nullable(b.heading), columns };
    }
    case 'table': {
      const headers = cap(b.headers, MAX_TABLE_COLS).map(deIndex);
      const width = headers.length || MAX_TABLE_COLS;
      const rows = cap(b.rows, items)
        .map(r => ({ cells: cap(r?.cells, width).map(deIndex) }))
        .filter(r => r.cells.some(Boolean));
      if (!rows.length) return null;
      return { type: 'table', headers, rows, note: nullable(b.note) };
    }
    case 'code': {
      const lines = cap(b.lines, MAX_CODE_LINES).map(l => clean(l));
      if (!lines.some(Boolean)) return null;
      return {
        type: 'code', language: clean(b.language) || 'text', lines,
        caption: nullable(b.caption),
      };
    }
    case 'diagram': {
      const nodes = cap(b.nodes, 8)
        .map(n => ({ label: deIndex(n?.label), note: nullable(n?.note) }))
        .filter(n => n.label);
      const parts = cap(b.parts, 8)
        .map(x => ({ label: deIndex(x?.label), value: finite(x?.value, 0) }))
        .filter(x => x.label);
      const marks = cap(b.marks, 8)
        .map(m => ({ at: finite(m?.at, 0), label: deIndex(m?.label) }))
        .filter(m => m.label);
      // A diagram with nothing in it has nothing to draw. number_line is the one
      // kind that lives on its bounds rather than its nodes.
      const drawable = nodes.length || parts.length
        || (b.kind === 'number_line' && Number.isFinite(b.from) && Number.isFinite(b.to));
      if (!drawable) return null;
      return {
        type: 'diagram', kind: b.kind, title: nullable(b.title), caption: nullable(b.caption),
        nodes, headers: cap(b.headers, MAX_TABLE_COLS).map(deIndex),
        from: nnum(b.from), to: nnum(b.to), step: nnum(b.step),
        marks, parts,
      };
    }
    case 'chart': {
      const series = cap(b.series, 12)
        .map(s => ({ label: deIndex(s?.label), value: finite(s?.value, 0) }))
        .filter(s => s.label);
      if (!series.length) return null;
      return {
        type: 'chart', kind: b.kind === 'line' ? 'line' : 'bar',
        title: deIndex(b.title) || 'Data', unit: nullable(b.unit), series,
        note: nullable(b.note),
      };
    }
    case 'image': {
      const asset_id = clean(b.asset_id);
      if (!asset_id) return null;
      return { type: 'image', asset_id, alt: deIndex(b.alt) || 'Picture', caption: nullable(b.caption) };
    }
    case 'question': {
      const question = deIndex(b.question);
      if (!question) return null;
      return {
        type: 'question', question, prompt: nullable(b.prompt),
        answer: deIndex(b.answer), misconception: nullable(b.misconception),
      };
    }
    case 'mcq': {
      const question = deIndex(b.question);
      const options = cap(b.options, MAX_MCQ_OPTIONS).map(deIndex).filter(Boolean);
      if (!question || options.length < 2) return null;
      const correct = Math.min(Math.max(0, finite(b.correct, 0)), options.length - 1);
      // why_wrong is parallel to options; pad or trim so index i always resolves.
      const why = options.map((_, i) => {
        if (i === correct) return '';
        return deIndex((b.why_wrong as string[] | undefined)?.[i]);
      });
      return {
        type: 'mcq', question, options, correct: Math.round(correct),
        why_wrong: why, explain: deIndex(b.explain),
      };
    }
    case 'true_false': {
      const statements = cap(b.statements, items)
        .map(s => ({ text: deIndex(s?.text), is_true: !!s?.is_true, why: deIndex(s?.why) }))
        .filter(s => s.text);
      if (!statements.length) return null;
      return { type: 'true_false', statements };
    }
    case 'predict': {
      const question = deIndex(b.question);
      if (!question) return null;
      return {
        type: 'predict', setup: deIndex(b.setup), question,
        answer: deIndex(b.answer), misconception: nullable(b.misconception),
      };
    }
    case 'sort': {
      const categories = cap(b.categories, 4).map(deIndex).filter(Boolean);
      const list = cap(b.items, items + 3)
        .map(i => ({ text: deIndex(i?.text), category: Math.round(finite(i?.category, 0)) }))
        .filter(i => i.text && i.category >= 0 && i.category < Math.max(1, categories.length));
      if (categories.length < 2 || !list.length) return null;
      return { type: 'sort', instruction: deIndex(b.instruction) || 'Sort these.', categories, items: list };
    }
    case 'error_spot': {
      const work = cap(b.work, MAX_STEPS).map(unnumber).filter(Boolean);
      const error = deIndex(b.error);
      if (!work.length || !error) return null;
      const line = Math.round(finite(b.wrong_line, -1));
      return {
        type: 'error_spot', instruction: deIndex(b.instruction) || 'Find the mistake.',
        work, wrong_line: line >= 0 && line < work.length ? line : -1,
        error, correction: deIndex(b.correction),
      };
    }
    case 'scenario': {
      const task = deIndex(b.task);
      if (!task) return null;
      return {
        type: 'scenario', context: deIndex(b.context), task,
        prompts: cap(b.prompts, items).map(deIndex).filter(Boolean),
      };
    }
    case 'discuss': {
      const prompt = deIndex(b.prompt);
      if (!prompt) return null;
      const structures = ['think_pair_share', 'pairs', 'groups', 'whole_class'] as const;
      const structure = structures.includes(b.structure as never)
        ? (b.structure as DiscussStructure) : 'think_pair_share';
      return {
        type: 'discuss', prompt, structure,
        minutes: Math.min(10, Math.max(1, Math.round(finite(b.minutes, 2)))),
        share_back: nullable(b.share_back),
      };
    }
    case 'task': {
      const questions = cap(b.questions, items + 2)
        .map(q => ({ text: unnumber(q?.text), marks: nint(q?.marks) }))
        .filter(q => q.text);
      const instruction = deIndex(b.instruction);
      if (!instruction && !questions.length) return null;
      return {
        type: 'task', instruction: instruction || 'Work through these.',
        questions, support: nullable(b.support), extension: nullable(b.extension),
      };
    }
    case 'exit_ticket': {
      const question = deIndex(b.question);
      if (!question) return null;
      return {
        type: 'exit_ticket', question, answer: deIndex(b.answer),
        success_criteria: cap(b.success_criteria, 3).map(deIndex).filter(Boolean),
      };
    }
    default:
      return null;
  }
}

type DiscussStructure = 'think_pair_share' | 'pairs' | 'groups' | 'whole_class';

function nullable(v: unknown): string | null {
  const s = deIndex(v);
  return s ? s : null;
}
function finite(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function nnum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function nint(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ------------------------------------------------------------ slide repair

/**
 * The layout, as a consequence of the content.
 *
 * Deterministic on purpose. Layout is a function of what is on the slide and
 * which part of the lesson it belongs to, and letting the model choose one only
 * adds a field it can get wrong - a `visual_full` layout on a slide with no
 * picture is a blank slide with a heading.
 */
export function settleLayout(s: Slide): SlideLayout {
  if (s.phase === 'title') return 'title';
  if (s.phase === 'objectives') return 'objectives';
  if (s.phase === 'summary') return 'summary';

  const types = s.blocks.map(b => b.type);
  if (!types.length) return 'divider';

  const visual = types.filter(t => VISUAL_BLOCKS.includes(t));
  if (types.length === 1) {
    const only = types[0];
    if (visual.length === 1) {
      const b = s.blocks[0];
      const captioned = (b.type === 'diagram' || b.type === 'chart' || b.type === 'image')
        && !!(b as { caption?: string | null }).caption;
      return captioned ? 'visual_caption' : 'visual_full';
    }
    if (only === 'statement' || only === 'definition') return 'statement';
    if (only === 'worked_example' || only === 'steps' || only === 'error_spot') return 'worked';
    if (only === 'mcq' || only === 'true_false') return 'quiz';
    if (only === 'task') return 'task';
    if (STUDENT_BLOCKS.includes(only)) return 'question';
    if (only === 'compare' || only === 'table') return 'split';
    return 'bullets';
  }
  // Two blocks: a picture beside its explanation, or two things side by side.
  return 'split';
}

/** "RETRIEVAL - 5 MIN". Composed here so it can never disagree with the timing. */
export function settleEyebrow(s: Slide, label: string): string {
  const mins = s.minutes > 0 ? ` - ${s.minutes} MIN` : '';
  return `${label.toUpperCase()}${mins}`;
}

/**
 * The accent, by phase.
 *
 * The same phase wears the same colour throughout the deck, so a teacher
 * flicking through the rail can see the shape of the lesson without reading it -
 * the explanation slides are one colour, the slides where the class works are
 * another. A random accent per slide would look busier and say nothing.
 */
const PHASE_ACCENT: Record<LessonPhase, Accent> = {
  title: 'forest', objectives: 'forest',
  retrieval: 'gold', hook: 'purple',
  concept: 'blue', explanation: 'blue', visual: 'teal',
  guided: 'teal', interaction: 'purple', independent: 'purple',
  assessment: 'gold', summary: 'forest', exit: 'gold',
};

export function accentFor(phase: LessonPhase): Accent {
  return PHASE_ACCENT[phase] ?? ACCENTS[0];
}

/** A teacher note with every field present, so the editor never renders undefined. */
export function settleTeacher(raw: Partial<TeacherNote> | null | undefined): TeacherNote {
  return {
    intention: deIndex(raw?.intention),
    say: deIndex(raw?.say),
    expect: nullable(raw?.expect),
    misconceptions: cap(raw?.misconceptions, 3).map(deIndex).filter(Boolean),
    follow_up: nullable(raw?.follow_up),
    timing_note: nullable(raw?.timing_note),
  };
}

// -------------------------------------------------------------- deck repair

export interface RepairReport {
  /** Slides dropped because nothing survived the caps. */
  droppedSlides: number;
  /** Blocks dropped, either empty or over the per-slide limit. */
  droppedBlocks: number;
  /** Slides whose learner-facing text was over the age cap and was cut. */
  trimmedSlides: number;
  /** Minutes moved to make the plan sum to the stated duration. */
  minutesAdjusted: number;
}

/**
 * Bring the whole deck inside its own rules.
 *
 * Order matters. Blocks are repaired before they are counted, counted before
 * they are cut, and cut before the layout is chosen - a layout picked from
 * blocks that are about to be removed is the wrong layout.
 */
export function repairDeck(deck: LessonDeck, band: AgeBand): RepairReport {
  const report: RepairReport = {
    droppedSlides: 0, droppedBlocks: 0, trimmedSlides: 0, minutesAdjusted: 0,
  };
  const objectiveCount = deck.objectives.length;
  const kept: Slide[] = [];

  for (const slide of deck.slides) {
    const before = slide.blocks.length;

    let blocks = slide.blocks
      .map(b => repairBlock(b, band))
      .filter((b): b is SlideBlock => !!b);

    // The title and objectives slides are drawn from the deck. Anything a model
    // put on them - a paraphrase of the objectives, most often - is dropped, so
    // the objectives slide always shows the registry's own words.
    if (slide.phase === 'title' || slide.phase === 'objectives') blocks = [];

    // One idea per slide. Past the age band's limit, the extra blocks go rather
    // than shrink everything on the slide to fit.
    if (blocks.length > band.maxBlocksPerSlide) {
      blocks = blocks.slice(0, band.maxBlocksPerSlide);
    }
    report.droppedBlocks += Math.max(0, before - blocks.length);

    slide.blocks = blocks;
    slide.title = trimChars(deIndex(slide.title), MAX_TITLE_CHARS);
    slide.purpose = deIndex(slide.purpose);
    slide.teacher = settleTeacher(slide.teacher);
    slide.objective_indexes = [...new Set(
      (slide.objective_indexes ?? [])
        .map(i => Math.round(Number(i)))
        .filter(i => Number.isInteger(i) && i >= 0 && i < objectiveCount),
    )];
    slide.minutes = Math.max(0, Math.round(Number(slide.minutes) || 0));
    // Derived, never asserted.
    //
    // The model plans an audience for each slide and then writes the blocks, and
    // the two do not always agree - it marks a slide student_facing and puts a
    // diagram on it. Trusting the flag would make the whole engagement measure
    // gameable by a field, and would put "Your turn" on the screen above a slide
    // with nothing to do. A slide is the class's turn when it has something on it
    // for them to do, and not otherwise.
    slide.audience = hasStudentBlock(slide) ? 'student_facing' : 'teacher_led';

    // A slide with no blocks is only allowed to exist where it carries its own
    // content: the title, the objectives list and the summary are drawn from the
    // deck rather than from blocks.
    const selfContained = slide.phase === 'title' || slide.phase === 'objectives'
      || slide.phase === 'summary';
    if (!blocks.length && !selfContained) {
      report.droppedSlides++;
      continue;
    }

    if (trimToWordCap(slide, band)) report.trimmedSlides++;

    slide.accent = accentFor(slide.phase);
    slide.layout = settleLayout(slide);
    kept.push(slide);
  }

  deck.slides = kept;
  report.minutesAdjusted = rebalanceMinutes(deck);
  deck.slides.forEach(s => {
    const label = deck.timing.find(t => t.phase === s.phase)?.label ?? s.phase;
    s.eyebrow = settleEyebrow(s, label);
  });
  deck.assessment = collectAssessment(deck);
  deck.objective_refs = objectiveRefs(deck);
  return report;
}

/**
 * Cut a slide down to the words its age band allows.
 *
 * Trimming lists first is deliberate: dropping the sixth bullet costs less
 * teaching than shortening the sentence that explains the idea. If a slide is
 * still over after its lists are at two items, the prose is shortened, and that
 * is the point where the gate will also be complaining - so the teacher hears
 * about it rather than just quietly receiving a thinner slide.
 */
function trimToWordCap(slide: Slide, band: AgeBand): boolean {
  if (slideWords(slide) <= band.maxWordsPerSlide) return false;

  for (let pass = 0; pass < 4 && slideWords(slide) > band.maxWordsPerSlide; pass++) {
    let cutSomething = false;
    for (const b of slide.blocks) {
      switch (b.type) {
        case 'bullets': if (b.items.length > 2) { b.items.pop(); cutSomething = true; } break;
        case 'steps': if (b.steps.length > 2) { b.steps.pop(); cutSomething = true; } break;
        case 'task': if (b.questions.length > 2) { b.questions.pop(); cutSomething = true; } break;
        case 'true_false': if (b.statements.length > 2) { b.statements.pop(); cutSomething = true; } break;
        case 'scenario': if (b.prompts.length > 1) { b.prompts.pop(); cutSomething = true; } break;
        case 'table': if (b.rows.length > 2) { b.rows.pop(); cutSomething = true; } break;
        case 'sort': if (b.items.length > 3) { b.items.pop(); cutSomething = true; } break;
        case 'worked_example': if (b.steps.length > 2) { b.steps.pop(); cutSomething = true; } break;
        case 'error_spot':
          // Never the wrong line itself: it is the whole point of the slide.
          if (b.work.length > 2 && b.wrong_line !== b.work.length - 1) {
            b.work.pop(); cutSomething = true;
          }
          break;
        case 'compare':
          for (const col of b.columns) {
            if (col.points.length > 2) { col.points.pop(); cutSomething = true; }
          }
          break;
        default: break;
      }
    }
    if (!cutSomething) break;
  }

  // Still over: shorten the prose. Last resort, and visible in the gate.
  if (slideWords(slide) > band.maxWordsPerSlide) {
    for (const b of slide.blocks) {
      if (b.type === 'statement') b.text = trimWords(b.text, Math.min(MAX_STATEMENT_WORDS, band.maxWordsPerSlide - 6));
      if (b.type === 'definition') b.meaning = trimWords(b.meaning, band.maxSentenceWords + 4);
      if (b.type === 'scenario') b.context = trimWords(b.context, band.maxSentenceWords + 8);
      if (b.type === 'predict') b.setup = trimWords(b.setup, band.maxSentenceWords + 4);
    }
  }
  return true;
}

function trimChars(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}...`;
}

/**
 * Make the slide timings sum to the lesson.
 *
 * A teacher reads the running total in the editor and plans against it, so a
 * deck whose slides add up to seventy-one minutes of an eighty minute period is
 * wrong in a way that matters. Scale everything proportionally, then push the
 * rounding remainder onto the longest slides - which is where a minute either
 * way is least noticeable.
 *
 * Returns the absolute number of minutes moved, for the report.
 */
export function rebalanceMinutes(deck: LessonDeck): number {
  const target = Math.max(1, Math.round(deck.meta.duration_minutes || 0));
  const slides = deck.slides;
  if (!slides.length) return 0;

  const before = slides.map(s => s.minutes);
  const total = before.reduce((n, m) => n + m, 0);

  if (!total) {
    // Nothing usable came back: spread the lesson evenly rather than leave zeros.
    const each = Math.floor(target / slides.length);
    let left = target - each * slides.length;
    slides.forEach(s => { s.minutes = each + (left-- > 0 ? 1 : 0); });
    return target;
  }

  if (total === target) return 0;

  const scaled = slides.map(s => (s.minutes / total) * target);
  const floors = scaled.map(v => Math.max(1, Math.floor(v)));
  let left = target - floors.reduce((n, v) => n + v, 0);
  // Hand the remainder to the slides with the largest fractional part first.
  const order = scaled
    .map((v, i) => ({ i, rest: v - Math.floor(v) }))
    .sort((a, b) => b.rest - a.rest);
  const out = [...floors];
  let k = 0;
  while (left > 0 && order.length) { out[order[k % order.length].i]++; left--; k++; }
  // Overshoot (every slide floored to 1 in a very short lesson) comes back off
  // the longest slides, never below one minute.
  while (left < 0) {
    const biggest = out
      .map((m, i) => ({ m, i }))
      .filter(x => x.m > 1)
      .sort((a, b) => b.m - a.m)[0];
    if (!biggest) break;
    out[biggest.i]--; left++;
  }

  slides.forEach((s, i) => { s.minutes = out[i]; });
  return before.reduce((n, m, i) => n + Math.abs(m - out[i]), 0);
}

/**
 * Every assessment question in the deck, flattened and tied to an objective.
 *
 * Built here rather than asked for, because the model has already said which
 * objectives a slide addresses and which of its blocks carry an answer - asking
 * it to also restate that as a list is a chance for the two to disagree.
 *
 * A question on a slide tagged to no objective is still collected, with
 * objective_index -1, so the gate can see it and say so. Dropping it would hide
 * the problem.
 */
export function collectAssessment(deck: LessonDeck): AssessmentItem[] {
  const out: AssessmentItem[] = [];
  for (const s of deck.slides) {
    const idx = s.objective_indexes[0] ?? -1;
    for (const b of s.blocks) {
      if (b.type === 'question') {
        out.push({ slide_id: s.id, objective_index: idx, question: b.question, answer: b.answer, misconception: b.misconception });
      } else if (b.type === 'mcq') {
        const wrong = b.why_wrong.filter(Boolean).join(' ') || null;
        out.push({ slide_id: s.id, objective_index: idx, question: b.question, answer: b.options[b.correct] ?? '', misconception: wrong });
      } else if (b.type === 'true_false') {
        for (const st of b.statements) {
          out.push({ slide_id: s.id, objective_index: idx, question: st.text, answer: st.is_true ? 'True' : 'False', misconception: st.why || null });
        }
      } else if (b.type === 'predict') {
        out.push({ slide_id: s.id, objective_index: idx, question: b.question, answer: b.answer, misconception: b.misconception });
      } else if (b.type === 'error_spot') {
        out.push({ slide_id: s.id, objective_index: idx, question: b.instruction, answer: b.correction || b.error, misconception: b.error });
      } else if (b.type === 'exit_ticket') {
        out.push({ slide_id: s.id, objective_index: idx, question: b.question, answer: b.answer, misconception: null });
      }
    }
  }
  return out;
}

/** The union of resolved objective codes, for the work key and the bank. */
export function objectiveRefs(deck: LessonDeck): string[] {
  const refs = new Set<string>();
  const used = new Set<number>();
  for (const s of deck.slides) for (const i of s.objective_indexes) used.add(i);
  for (const i of used) {
    const ref = deck.objectives[i]?.ref;
    if (ref) refs.add(ref);
  }
  return [...refs].sort();
}

/** Which objectives no slide claims to address. Indexes, for the gate. */
export function uncoveredObjectives(deck: LessonDeck): number[] {
  const covered = new Set<number>();
  for (const s of deck.slides) for (const i of s.objective_indexes) covered.add(i);
  return deck.objectives.map((_, i) => i).filter(i => !covered.has(i));
}

/** A slide id. Short, readable in a URL, and unique within a deck. */
export function slideId(n: number): string {
  return `s${String(n + 1).padStart(2, '0')}`;
}

/**
 * The next free id for a slide being added.
 *
 * Ids are never renumbered on a reorder, however tempting it looks to keep them
 * in running order. `assessment[].slide_id` points at them, the editor holds the
 * selected one, and `edit_event` records them - renumbering would silently
 * repoint every one of those at a different slide.
 */
export function nextSlideId(slides: Slide[]): string {
  let n = slides.length;
  const taken = new Set(slides.map(s => s.id));
  while (taken.has(slideId(n))) n++;
  return slideId(n);
}
