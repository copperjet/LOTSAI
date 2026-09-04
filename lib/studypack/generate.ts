/**
 * The study pack v2 generator.
 *
 * Two passes, because one will not fit. A pack the size of "CP5 Mathematic
 * StudyPack 1.pdf" is 28 pages of dense blocks; the v1 generator's single 6000-token
 * call truncates long before that. So:
 *
 *   1. outline - the model chooses the pack's shape: how many pages, what each is
 *      called, which objectives it covers, and which block types it will use. This
 *      is where "the model composes the document" actually happens, and it is cheap.
 *   2. fill    - one call per group of pages, each narrowed by fillSchema() to only
 *      the block types that page group's outline asked for. A smaller union is a
 *      more reliable one, and the shared prefix (block guide + objectives + outline)
 *      is cached, so the second and later groups pay a tenth on it.
 *
 * The founding rule is unchanged from v1: the model selects `objective_indexes` into
 * a list handed to it and never writes an objective. Extended here to the document
 * path, where the list itself was assembled by lib/studypack/objectives.ts.
 *
 * External URLs are never authored by the model (the Build Kit warns that it will
 * invent them). A `url` survives only if it already appears in the teacher's own
 * uploaded text; everything else is stripped here and checked again by the gate.
 */
import { call } from '@/lib/llm';
import type { Objective } from '@/lib/planner';
import {
  BLOCK_TYPES, OUTLINE_BLOCK_TYPES, OUTLINE_SCHEMA, fillSchema,
  type Accent, type Block, type BlockType, type PackLayout, type PackObjective,
  type PackOutline, type PackV2, type Page, type PageRole,
} from './schema';
import { ACCENTS } from './schema';
import { pickTheme } from './themes';

export interface RegistryWeekLite {
  week_number: number; topic_label: string; objectives: Objective[];
}

export type PackSource =
  | { kind: 'registry'; weeks: RegistryWeekLite[]; weekFrom: number; weekTo: number }
  | { kind: 'document'; text: string; filename: string; objectives: PackObjective[] };

export interface GeneratePackV2Input {
  source: PackSource;
  subjectId: string;
  yearGroup: string;
  /** The subject's name for the page furniture ("Mathematics", not "MATH"). The
   *  school's own packs read "Lusaka Oaktree School - Global Perspectives" in the
   *  footer, never a code. Falls back to the id when it cannot be resolved. */
  subjectName?: string | null;
  curriculum?: string | null;
}

/** Pages per fill call. Four pages of blocks sits well inside the token budget and
 *  keeps a single bad response from costing the whole pack. */
const GROUP = 4;
const MAX_PAGES = 40;

/**
 * Two content pages for each week the pack covers.
 *
 * The outline pass used to be told "between 6 and 40 pages" whatever the span was, so
 * a two week pack and an eight week pack came back the same length - and a week's
 * revision arrived as five sheets nobody would work through. A week is worth about two
 * pages: one to remind, one to practise. The front page carrying the resources and the
 * closing page sit outside the budget, because they belong to the pack rather than to
 * any week.
 *
 * The document path has no weeks to count, so it keeps MAX_PAGES as its only ceiling.
 */
const PAGES_PER_WEEK = 2;

function pageBudget(source: PackSource): number | null {
  if (source.kind !== 'registry') return null;
  const weeks = Math.max(1, source.weekTo - source.weekFrom + 1);
  return Math.min(MAX_PAGES - 2, weeks * PAGES_PER_WEEK);
}

// ------------------------------------------------------------------- prompts

const SYSTEM = `You build study packs for Lusaka Oaktree School, a Cambridge primary and lower-secondary
school in Zambia. A study pack is not a set of notes to read. It is a short, active revision
document: a student should be doing something on every page - answering, thinking, writing or
following a link - never just reading paragraphs.

You are given the objectives the pack must cover, already numbered. You never write, reword,
renumber or invent an objective. You only choose which of the supplied objectives each page
covers, by index.

Every pack must have, somewhere in it:
- helpful resources near the front, before the content
- each page's objectives stated, by index
- short key ideas, never paragraphs of notes
- practice questions with room to answer, mixing recall with at least one that needs working
  or explanation
- at least one prompt or resource per pack that goes beyond recall

Write in plain British English pitched at the year group. Never use an em dash or an en dash;
use a plain hyphen. Do not write anything a teacher or head of department would sign - no
comments, no marking, no grades.

Never write a web address. If the teacher's own document contains one you may repeat it
exactly; otherwise leave every url null and name the resource instead.`;

/** The block vocabulary, given to both passes. Cached, so it is paid for once. */
const BLOCK_GUIDE = `BLOCK VOCABULARY

Compose each page from these blocks. Choose freely: use what the subject and the page
actually need, in any order, and do not force a block that does not fit.

resources       A short list of checked, trustworthy resources, grouped by what they help
                with. Put this near the front of the pack, not at the end. name + why it
                helps; url only if it appeared in the teacher's own document.
key_notes       A grid of 2 or 3 columns of short cards, each a heading and a sentence or
                two. The workhorse for rules, definitions and method summaries.
key_ideas       Three to six one-line bullets. Never a paragraph.
worked_example  A question, numbered steps, and the answer. Essential for maths and science.
practice        Numbered questions with room to answer. marks in [n] where the subject uses
                them; answer_lines is how many ruled lines to leave (2 for recall, 5 or more
                for explanation). Ten questions in two columns is the house style for a drill.
quiz            Multiple choice with the index of the correct option and a one-line reason.
                Interactive on screen, printed as a lettered question with an answer key.
glossary        Key terms and one-line definitions. Flashcards on screen.
checklist       Columns of "I can ..." statements for a student to tick.
source_card     A short source, with a quick check on how far it can be trusted. For source
                evaluation, comprehension and document study.
table           A headed grid. Use for comparisons, conversions, or claim / reason / evidence.
chart           A small bar or line chart of real figures for the student to read and
                describe, with an optional aside of useful phrases.
two_column      Two opposed positions side by side - a view and a counter-argument.
callout         A short note, tip or warning.
think           One open question that goes beyond recall, and optionally a named resource.
reflection      An extended written response, its marks, and self-check statements.
contents        A contents page. Emit it empty - it is built from the page list.
closing         A short closing page: a heading and a few study tips.
diagram         A drawn explanation, composed as data: "flow" for steps joined by arrows,
                "cycle" for a repeating process, "number_line" for from/to/step with marks
                called out, "bar_model" for parts of a whole, "grid" for headers with cells
                filled in order. Fill only the fields the kind uses and leave the rest null
                or empty. Reach for it where a sentence is doing a picture's work.

A key_notes card may carry "tile": one letter or a very short token, drawn as a coloured
square beside the heading. Use it where the cards are a named sequence a learner has to
hold in order - B O D M A S, the layers of something, steps 1 to 5 - and leave it null
everywhere else. A tile on every card is a tile on none.

WIDTH

Every block takes "span": "full" or "half". A half sits beside the block after it, so
halves are marked in pairs: whenever you write "half", the very next block on that page
is "half" too. One half on its own is drawn full width, so it changes nothing.

Pair on at least half of the pages that carry two short blocks. A page of nothing but
full-width blocks is right only when each of them needs the whole width - notes cards, a
worked example beside them, a callout beside a table are all pairs, and a pack that never
pairs prints as one column from cover to key.

Use half for two things that are read together: a worked example beside the notes it
works from, a table beside the callout that explains it, two short blocks that would
each waste a page's width alone. Use full for anything a pupil writes into or reads
across - practice questions, a source to study, a chart, a long table. A page of all
full blocks is fine; a page where nothing is ever paired is a page that looks like
every other one.

HOW MUCH FITS ON A PAGE

Every page is printed at a fixed size, and a page that holds more than fits runs on to a
second sheet without its heading. So budget the page:

- Two to four blocks on an A4 landscape page. One to three on a 16:9 slide.
- A page holds about 450 words of pupil-facing text in total, questions included. Past
  that it runs on to a second sheet, and a topic split across two sheets is worse than a
  topic given two pages on purpose.
- A block worth a whole page on its own - ten practice questions, six key notes cards -
  takes one, with at most one small block beside it.
- A pair of halves counts as one block's height, not two, so a page can carry more when
  it pairs - but the words still have to fit the budget above.
- Split a topic across consecutive pages rather than stacking it. The school's own maths
  packs give a topic a key notes page, then a worked examples page, then a practice page.
- Keep blocks to: key_notes 4 to 6 cards; practice up to 10 questions (two columns) or 5
  with long answer space; worked_example 1 or 2; quiz up to 5; glossary up to 8 terms;
  table up to 6 rows; source_card 1 or 2.`;

// --------------------------------------------------------------------- entry

export async function generateStudyPackV2(
  input: GeneratePackV2Input, userId: string,
): Promise<{ content: PackV2; usage: { input: number; cached: number; output: number; cost: number } }> {
  const objectives = objectivesFor(input.source);
  const budget = pageBudget(input.source);
  const grounding = groundingFor(input, objectives);
  const allowedUrls = input.source.kind === 'document' ? urlsIn(input.source.text) : new Set<string>();

  const usage = { input: 0, cached: 0, output: 0, cost: 0 };
  const add = (u: { input: number; cached: number; output: number; cost: number }) => {
    usage.input += u.input; usage.cached += u.cached; usage.output += u.output; usage.cost += u.cost;
  };

  // ---- pass 1: the shape of the document -----------------------------------
  const outlineCall = await call<PackOutline>({
    tier: 'standard',
    workflow: 'studypack_outline',
    userId,
    system: SYSTEM,
    cached: [BLOCK_GUIDE, grounding],
    longCache: true,
    prompt: outlinePrompt(input, budget),
    schema: OUTLINE_SCHEMA,
    maxTokens: 6000,
  });
  add(outlineCall.usage);

  const outline = normaliseOutline(outlineCall.data, objectives.length, input.subjectId, budget);
  if (!outline.pages.length) throw new Error('studypack: the outline pass produced no pages');

  const outlineBlock = `PACK OUTLINE\n\n${outline.pages.map(p =>
    `${p.id} | ${p.eyebrow ?? '-'} | ${p.title} | objectives ${p.objective_indexes.join(',') || '-'} `
    + `| blocks ${p.block_types.join(', ')}`).join('\n')}`;

  // ---- pass 2: the blocks, a few pages at a time ----------------------------
  const filled = new Map<string, Block[]>();
  // Dividers carry no blocks, so they are not sent to the fill pass at all - a page
  // asked for with an empty block list is a call that can only come back empty.
  const toFill = outline.pages.filter(p => p.role !== 'divider' && p.block_types.length);
  for (let i = 0; i < toFill.length; i += GROUP) {
    const group = toFill.slice(i, i + GROUP);
    const types = [...new Set(group.flatMap(p => p.block_types))];

    const want = group.map(p =>
      `${p.id}: "${p.title}"${p.eyebrow ? ` (${p.eyebrow})` : ''}\n`
      + `  objectives: ${p.objective_indexes.map(n => `[${n}]`).join(' ') || 'none - this is a front or closing page'}\n`
      + `  blocks, in this order: ${p.block_types.join(', ')}`).join('\n\n');

    let blocks: { pages: { id: string; blocks: Block[] }[] } | null = null;
    for (let attempt = 0; attempt < 2 && !blocks; attempt++) {
      try {
        const res = await call<{ pages: { id: string; blocks: Block[] }[] }>({
          tier: 'standard',
          workflow: 'studypack_fill',
          userId,
          system: SYSTEM,
          cached: [BLOCK_GUIDE, grounding, outlineBlock],
          longCache: true,
          prompt: `Write the blocks for these pages of the pack, and only these pages.\n\n${want}\n\n`
            + `Use exactly the block types listed for each page, in that order. Draw every fact from the `
            + `material above. Set each block's span, and where two short blocks on a page belong `
            + `side by side mark both of them "half" - see WIDTH. Return one entry per page, `
            + `keyed by the page id.`,
          schema: fillSchema(types.length ? types : [...BLOCK_TYPES]),
          maxTokens: 10_000,
        });
        add(res.usage);
        blocks = res.data;
      } catch (e) {
        // A group that will not parse costs its pages their blocks, not the pack.
        // The gate reports the thin page; the teacher can regenerate.
        if (attempt === 1) {
          console.error(`[studypack] fill failed for ${group.map(p => p.id).join(',')}: `
            + `${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    for (const page of blocks?.pages ?? []) {
      if (!page?.id) continue;
      filled.set(page.id, repairBlocks(page.blocks ?? [], allowedUrls));
    }
  }

  const pages: Page[] = outline.pages.map(p => ({
    id: p.id, eyebrow: p.eyebrow, title: p.title,
    objective_indexes: p.objective_indexes, accent: p.accent, role: p.role,
    blocks: filled.get(p.id) ?? [],
  }));

  const refs = [...new Set(
    pages.flatMap(p => p.objective_indexes)
      .map(i => objectives[i]?.ref).filter((r): r is string => !!r),
  )].sort();

  return {
    content: {
      version: 2,
      layout: outline.layout,
      theme: pickTheme(input.subjectId, themeSeed(input)).id,
      title: outline.title,
      subtitle: outline.subtitle,
      meta: {
        subject: input.subjectName || input.subjectId, yearGroup: input.yearGroup,
        curriculum: input.curriculum ?? null,
        // The footer credit reads better as the document's name than as its file
        // name: "ART LS1 STUDY PACK S1 2026-2027", not "... .pdf".
        span: input.source.kind === 'registry'
          ? `Weeks ${input.source.weekFrom}-${input.source.weekTo}`
          : input.source.filename.replace(/\.[a-z0-9]{1,5}$/i, ''),
      },
      objectives,
      pages,
      objective_refs: refs,
    },
    usage,
  };
}

// ------------------------------------------------------------------ grounding

function objectivesFor(source: PackSource): PackObjective[] {
  if (source.kind === 'document') return source.objectives;
  const out: PackObjective[] = [];
  for (const w of source.weeks) {
    for (const o of w.objectives ?? []) {
      out.push({ ref: o.ref ?? null, text: o.text, source: 'registry' });
    }
  }
  return out;
}

/** The cached block both passes read: the numbered objectives, and - on the document
 *  path - the teacher's own material, which is what the pack is actually built from. */
function groundingFor(input: GeneratePackV2Input, objectives: PackObjective[]): string {
  const lines: string[] = [];
  const src = input.source;

  if (src.kind === 'registry') {
    lines.push(`CURRICULUM - ${input.yearGroup} ${input.subjectId}, weeks ${src.weekFrom}-${src.weekTo}`);
    let i = 0;
    for (const w of src.weeks) {
      lines.push(`\nWeek ${w.week_number}: ${w.topic_label}`);
      for (const o of w.objectives ?? []) {
        lines.push(`  [${i}] ${o.ref ? `${o.ref} - ` : ''}${o.text}`);
        i++;
      }
    }
    return lines.join('\n');
  }

  lines.push(`OBJECTIVES - ${input.yearGroup} ${input.subjectId}, from ${src.filename}`);
  objectives.forEach((o, i) => {
    const tag = o.source === 'file' ? ' (stated in the file, no syllabus code)' : '';
    lines.push(`  [${i}] ${o.ref ? `${o.ref} - ` : ''}${o.text}${tag}`);
  });
  lines.push(`\nTEACHER'S MATERIAL - ${src.filename}`);
  lines.push('Build the pack from this content. Keep the teacher\'s facts, examples and terminology.');
  lines.push('');
  lines.push(src.text.slice(0, 120_000));
  return lines.join('\n');
}

function outlinePrompt(input: GeneratePackV2Input, budget: number | null): string {
  const src = input.source;
  const what = src.kind === 'registry'
    ? `the curriculum weeks above (weeks ${src.weekFrom} to ${src.weekTo})`
    : `the teacher's material above`;
  return `Plan the study pack for ${what}.

Decide its shape yourself: how many pages it needs, what each page is called, which objectives
each page covers, and which blocks each page will carry. Let the subject lead. A maths pack
wants key notes, worked examples and drill questions; a skills subject wants sources, tables,
data and extended questions; a practical subject wants short notes, callouts and questions to
attempt.

Choose the layout: "a4-landscape" for a document a student works through with a pen, or
"slide-16x9" for a topic-by-topic deck.

Give each page an accent from ${ACCENTS.join(', ')}. These are the five slots of the pack's
palette, not colours you are choosing - the pack's own theme decides what each one looks
like. What you are deciding is structure: a run of pages on one topic shares a slot and the
next topic takes a different one, and a page that does a different job from the pages around
it - a review, a source study, a reflection - is allowed to stand out. Never give two
touching pages the same slot by accident.

Give each page a "role". Almost every page is "content". A "divider" is a title page that
opens a topic: it carries its title and nothing else, printed full-bleed in its accent, and
its block_types must be empty. Use one before each major topic in a pack long enough to
need finding your way around - four or more topics - and none at all in a short pack. A
divider does not count against the page budget below.

Give the pack a front page carrying its resources, and a closing page. ${budget
  ? `Between them put exactly ${budget} content pages - ${PAGES_PER_WEEK} for each week of the span - `
    + `so ${budget + 2} pages in all. That is the length of the document; do not exceed it. `
    + `A week gets one page to remind and one to practise, and a topic that will not fit two `
    + `pages is a topic to cover more tightly, not one to give a third page to.`
  : `Keep it between 6 and ${MAX_PAGES} pages.`}
Respect the page budget above: two to four blocks on an A4 landscape page,
one to three on a slide, and another page rather than a crowded one. Return the outline only -
the blocks are written next.`;
}

// -------------------------------------------------------------------- repair

/**
 * The colour a subject's packs start from.
 *
 * Two packs for the same subject should feel like the same subject, and the model has
 * no memory of the last one it wrote. Deriving the starting accent from the subject id
 * gives maths its colour and Global Perspectives another, every time, without anyone
 * maintaining a table of them.
 */
/**
 * What decides which theme a pack wears.
 *
 * The subject fixes the family (lib/studypack/themes.ts); this moves within it, so
 * the next pack a teacher builds for the same class does not look like the last one.
 * It is the pack's identity rather than a random number, so a pack re-rendered next
 * term is the pack they remember: same span, same file, same look.
 */
function themeSeed(input: GeneratePackV2Input): string {
  const src = input.source;
  const span = src.kind === 'registry' ? `w${src.weekFrom}-${src.weekTo}` : src.filename;
  return `${input.subjectId}|${input.yearGroup}|${span}`;
}

function homeAccent(subjectId: string): Accent {
  let n = 0;
  for (const ch of subjectId.toUpperCase()) n = (n * 31 + ch.charCodeAt(0)) % 9973;
  return ACCENTS[n % ACCENTS.length];
}

function normaliseOutline(
  raw: PackOutline, objectiveCount: number, subjectId: string, budget: number | null = null,
): PackOutline {
  const layout: PackLayout = raw?.layout === 'slide-16x9' ? 'slide-16x9' : 'a4-landscape';
  const seen = new Set<string>();
  const home = homeAccent(subjectId);
  let previous: Accent | null = null;
  const pages = trimToBudget(raw?.pages ?? [], budget).slice(0, MAX_PAGES).map((p, i) => {
    // Ids address a page across two calls, so they must be unique and present.
    let id = String(p?.id ?? '').trim() || `p${i + 1}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    // The model's choice stands unless it repeats the page before it: two touching
    // pages in one colour read as one long page, which is the opposite of what the
    // accent is for. Where it chose nothing, the pack walks its subject's palette.
    let accent: Accent = ACCENTS.includes(p?.accent as Accent)
      ? (p.accent as Accent)
      : ACCENTS[(ACCENTS.indexOf(home) + i) % ACCENTS.length];
    if (accent === previous) accent = ACCENTS[(ACCENTS.indexOf(accent) + 1) % ACCENTS.length];
    previous = accent;
    // A divider is a title and nothing else. Anything the model put on one is
    // dropped rather than drawn small: a divider that carries blocks is just a
    // content page with a very short heading, which is not what it is for.
    const role: PageRole = p?.role === 'divider' ? 'divider' : 'content';
    return {
      id,
      eyebrow: p?.eyebrow ? String(p.eyebrow) : null,
      title: String(p?.title ?? `Page ${i + 1}`),
      role,
      // An index outside the supplied list is the one way a pack could cite an
      // objective that does not exist. Drop it rather than resolve it to undefined.
      objective_indexes: [...new Set((p?.objective_indexes ?? [])
        .filter(n => Number.isInteger(n) && n >= 0 && n < objectiveCount))],
      accent,
      // Hard ceiling on page density. A sheet is a fixed size, and a page asked to
      // hold six blocks runs on to a second sheet that carries no heading, no
      // objectives and no crest - which is exactly what the Reference Guide's
      // "branding on every page" rule forbids. The prompt asks for two to four; this
      // is what happens when it is not listened to.
      block_types: role === 'divider' ? [] : (p?.block_types ?? [])
        .filter((t): t is BlockType => (OUTLINE_BLOCK_TYPES as readonly string[]).includes(t))
        .slice(0, layout === 'slide-16x9' ? 3 : 4),
    };
  });
  return {
    title: String(raw?.title ?? 'Study Pack'),
    subtitle: raw?.subtitle ? String(raw.subtitle) : null,
    layout, pages,
  };
}

/**
 * Hold the outline to its page budget, structurally.
 *
 * The prompt asks for the right number of pages and mostly gets it; this is what
 * happens when it does not. A blind slice would cut the closing page and leave the
 * pack ending mid-topic, so the front page and the closing page are kept and the
 * surplus is taken from the content in the middle - the last content pages, which are
 * the ones the model added past what it was asked for.
 */
function trimToBudget(pages: PackOutline['pages'], budget: number | null): PackOutline['pages'] {
  // Dividers are furniture, not content: a pack that earned four of them would
  // otherwise lose four of the pages they were there to introduce.
  const content = pages.filter(p => p?.role !== 'divider').length;
  if (!budget || content <= budget + 2) return pages;

  const closing = pages[pages.length - 1]?.block_types?.includes('closing')
    ? pages[pages.length - 1] : null;
  const front = pages[0];
  const middle = pages.slice(1, closing ? pages.length - 1 : pages.length);
  // Count only content towards the budget, but carry the dividers that sit among the
  // pages that survive - a divider whose topic was dropped goes with it.
  const kept: PackOutline['pages'] = [];
  let n = 0;
  for (const p of middle) {
    if (p?.role === 'divider') { kept.push(p); continue; }
    if (n >= budget) continue;
    kept.push(p); n++;
  }
  while (kept.length && kept[kept.length - 1]?.role === 'divider') kept.pop();

  // Ids, not titles: a page title here is two objectives long, and twenty of them is
  // a screen of log for one line of fact.
  const dropped = middle.filter(p => !kept.includes(p));
  console.warn(`[studypack] outline came back ${content} content pages for a budget of ${budget + 2}; `
    + `dropping ${dropped.length}: ${dropped.map(p => p.id).join(', ')}`);

  return [front, ...kept, ...(closing ? [closing] : [])];
}

/** Web addresses already present in the teacher's document, normalised for comparison. */
function urlsIn(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,;)\]]*)?)/gi;
  for (const m of text.matchAll(re)) out.add(m[1].toLowerCase().replace(/[.,)\]]+$/, ''));
  return out;
}

/**
 * Drop a leading "1." or "2)" from generated text.
 *
 * The renderer numbers practice questions with a badge and worked-example steps with
 * an ordered list, so a model that also numbers its own text prints "1. 1. Write 3,482
 * in words." Asking it not to in the prompt half works; removing it here always does.
 */
/**
 * Also drops a leading "[0]" - the objective index the model is given to tag pages
 * with, which it wrote into the checklist items themselves: "[0] I can gather
 * information from a range of reliable sources." No pupil needs to read that.
 */
function unnumber(text: string): string {
  return String(text ?? '')
    .replace(/^\s*\[\d{1,2}(?:,\s*\d{1,2})*\]\s*/, '')
    // A bare list too. Card headings came back as "16. Non-fiction texts" and
    // "22, 23, 24, 25. Words and commas" - the objective numbers the model was given
    // to tag the page with, written into the title of the card instead. This form is
    // only stripped from labels (headings, column titles, source labels), never from
    // prose, where "2, 3, 5. These are the primes" is a sentence.
    .replace(/^\s*\d{1,2}(?:\s*,\s*\d{1,2})*\s*[.)]\s+/, '')
    .trim();
}

function keepUrl(url: string | null, allowed: Set<string>): string | null {
  if (!url) return null;
  const norm = url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  if (!norm) return null;
  for (const a of allowed) if (a === norm || a.startsWith(norm) || norm.startsWith(a)) return url.trim();
  return null;
}

/**
 * How much of each block fits on one printed sheet.
 *
 * The prompt asks for these; this is what enforces them. A page is a fixed size and
 * the print renderer never clips, so a block that runs long does not get cut off - it
 * pushes the rest of the section onto a continuation sheet with no heading, no
 * objectives and no crest. Dropping the eleventh question is the smaller loss.
 */
const CAP = {
  resourceGroups: 3, resourceItems: 3, notes: 6, workedExamples: 2, practice: 10,
  quiz: 5, glossary: 8, checklistColumns: 3, checklistItems: 6, sources: 2,
  tableRows: 8, chartSeries: 8, asideItems: 5, selfCheck: 4, closingTips: 4,
  diagramNodes: 8,
} as const;

/**
 * Make every block safe to render.
 *
 * The v1 generator dropped quiz questions whose correct index was out of range
 * rather than draw a broken button set (lib/studypack.ts). Same idea, one rule per
 * block type: a block that cannot be drawn coherently is dropped, not rendered
 * half-formed.
 */
export function repairBlocks(
  blocks: Block[], allowedUrls: Set<string>, allowedAssets?: Set<string>,
): Block[] {
  const out: Block[] = [];
  for (const b of blocks ?? []) {
    if (!b || typeof b !== 'object' || !(BLOCK_TYPES as readonly string[]).includes(b.type)) continue;
    switch (b.type) {
      case 'resources': {
        const groups = (b.groups ?? [])
          .map(g => ({
            label: String(g?.label ?? ''),
            items: (g?.items ?? []).filter(i => i?.name).slice(0, CAP.resourceItems).map(i => ({
              name: String(i.name), why: String(i.why ?? ''), url: keepUrl(i.url ?? null, allowedUrls),
            })),
          }))
          .filter(g => g.items.length).slice(0, CAP.resourceGroups);
        if (groups.length) out.push({ ...b, groups });
        break;
      }
      case 'key_notes': {
        const cards = (b.cards ?? []).filter(c => c?.heading || c?.body).slice(0, CAP.notes)
          .map(c => ({
            heading: String(c.heading ?? ''), body: String(c.body ?? ''),
            // One or two characters. A "tile" holding a whole word is a heading in a
            // 30px square, which draws as three letters and an overflow.
            tile: c.tile ? String(c.tile).trim().slice(0, 2) || null : null,
          }));
        if (cards.length) out.push({ ...b, columns: b.columns === 3 ? 3 : 2, cards });
        break;
      }
      case 'key_ideas': {
        const items = (b.items ?? []).map(String).filter(Boolean).slice(0, 6);
        if (items.length) out.push({ ...b, items });
        break;
      }
      case 'worked_example': {
        const examples = (b.examples ?? []).filter(e => e?.prompt).slice(0, CAP.workedExamples).map(e => ({
          prompt: unnumber(String(e.prompt)), steps: (e.steps ?? []).map(s => unnumber(String(s))).filter(Boolean),
          answer: String(e.answer ?? ''),
        }));
        if (examples.length) out.push({ ...b, examples });
        break;
      }
      case 'practice': {
        const questions = (b.questions ?? []).filter(q => q?.text).slice(0, CAP.practice).map(q => ({
          text: unnumber(String(q.text)),
          marks: Number.isFinite(q.marks as number) ? Number(q.marks) : null,
          answer_lines: Number.isFinite(q.answer_lines as number)
            ? Math.min(12, Math.max(0, Number(q.answer_lines))) : null,
        }));
        if (questions.length) out.push({ ...b, columns: b.columns === 2 ? 2 : 1, questions });
        break;
      }
      case 'quiz': {
        // Carried over from v1: a correct index outside the options is a broken
        // question, not a hard question.
        const questions = (b.questions ?? []).filter(q =>
          q?.q && (q.options?.length ?? 0) >= 2 && Number.isInteger(q.correct)
          && q.correct >= 0 && q.correct < q.options.length).slice(0, CAP.quiz)
          // The quiz numbers its own questions on the page and letters the options.
          .map(q => ({ ...q, q: unnumber(String(q.q)), options: q.options.map(o => unnumber(String(o))) }));
        if (questions.length) out.push({ ...b, questions });
        break;
      }
      case 'glossary': {
        const terms = (b.terms ?? []).filter(t => t?.term).slice(0, CAP.glossary).map(t => ({
          term: String(t.term), definition: String(t.definition ?? ''),
        }));
        if (terms.length) out.push({ ...b, terms });
        break;
      }
      case 'checklist': {
        const columns = (b.columns ?? []).map(c => ({
          heading: String(c?.heading ?? ''), blurb: c?.blurb ? String(c.blurb) : null,
          items: (c?.items ?? []).map(i => unnumber(String(i))).filter(Boolean).slice(0, CAP.checklistItems),
        })).filter(c => c.items.length).slice(0, CAP.checklistColumns);
        if (columns.length) out.push({ ...b, columns });
        break;
      }
      case 'source_card': {
        const sources = (b.sources ?? []).filter(s => s?.text).slice(0, CAP.sources).map(s => ({
          label: String(s.label ?? 'Source'), text: String(s.text), quick_check: String(s.quick_check ?? ''),
        }));
        if (sources.length) out.push({ ...b, sources });
        break;
      }
      case 'table': {
        const headers = (b.headers ?? []).map(String);
        // A row of the wrong width draws a ragged grid; drop it.
        const rows = (b.rows ?? [])
          .map(r => ({ cells: (r?.cells ?? []).map(String) }))
          .filter(r => r.cells.length === headers.length).slice(0, CAP.tableRows);
        if (headers.length && rows.length) out.push({ ...b, headers, rows });
        break;
      }
      case 'chart': {
        const series = (b.series ?? [])
          .filter(s => s?.label != null && Number.isFinite(Number(s.value)))
          .map(s => ({ label: String(s.label), value: Number(s.value) })).slice(0, CAP.chartSeries);
        if (series.length >= 2) {
          out.push({
            ...b, kind: b.kind === 'line' ? 'line' : 'bar', series,
            aside_items: (b.aside_items ?? []).map(String).filter(Boolean).slice(0, CAP.asideItems),
          });
        }
        break;
      }
      case 'two_column': {
        if (b.left?.body || b.right?.body) {
          out.push({
            ...b,
            left: { heading: String(b.left?.heading ?? ''), body: String(b.left?.body ?? '') },
            right: { heading: String(b.right?.heading ?? ''), body: String(b.right?.body ?? '') },
          });
        }
        break;
      }
      case 'callout':
        if (b.body) out.push({ ...b, tone: ['note', 'tip', 'warning'].includes(b.tone) ? b.tone : 'note' });
        break;
      case 'think':
        if (b.question) out.push({ ...b, resource_url: keepUrl(b.resource_url ?? null, allowedUrls) });
        break;
      case 'reflection':
        if (b.prompt) out.push({ ...b, self_check: (b.self_check ?? []).map(String).filter(Boolean).slice(0, CAP.selfCheck) });
        break;
      case 'closing':
        out.push({ ...b, tips: (b.tips ?? []).map(String).filter(Boolean).slice(0, CAP.closingTips) });
        break;
      case 'contents':
        out.push(b);
        break;
      case 'diagram': {
        const kinds = ['flow', 'cycle', 'number_line', 'bar_model', 'grid'];
        const kind = kinds.includes(b.kind) ? b.kind : 'flow';
        const nodes = (b.nodes ?? []).filter(n => n?.label)
          .map(n => ({ label: String(n.label), note: n.note ? String(n.note) : null }))
          .slice(0, CAP.diagramNodes);
        const parts = (b.parts ?? [])
          .filter(x => x?.label != null && Number.isFinite(Number(x.value)) && Number(x.value) > 0)
          .map(x => ({ label: String(x.label), value: Number(x.value) })).slice(0, CAP.diagramNodes);
        const marks = (b.marks ?? [])
          .filter(m => m?.label != null && Number.isFinite(Number(m.at)))
          .map(m => ({ at: Number(m.at), label: String(m.label) })).slice(0, CAP.diagramNodes);
        // A shape with nothing in it draws nothing, so it is dropped here rather
        // than leaving an empty figure and its caption on the page.
        const usable = kind === 'number_line'
          ? Number.isFinite(Number(b.from)) && Number.isFinite(Number(b.to)) && Number(b.to) > Number(b.from)
          : kind === 'bar_model' ? parts.length > 0 : nodes.length > 0;
        if (usable) {
          out.push({
            ...b, kind, nodes, parts, marks,
            headers: (b.headers ?? []).map(String).filter(Boolean).slice(0, 6),
            from: Number.isFinite(Number(b.from)) ? Number(b.from) : null,
            to: Number.isFinite(Number(b.to)) ? Number(b.to) : null,
            step: Number.isFinite(Number(b.step)) ? Number(b.step) : null,
          });
        }
        break;
      }
      case 'image': {
        // An id nothing holds is dropped here, not at render time. A model asked to
        // put a picture on a page will name one whether or not it was given an id,
        // and a stored block pointing at nothing is a promise the pack cannot keep.
        const id = String(b.asset_id ?? '');
        const alt = String(b.alt ?? '').trim();
        if (id && alt && (!allowedAssets || allowedAssets.has(id))) {
          out.push({ ...b, asset_id: id, alt, caption: b.caption ? String(b.caption) : null });
        }
        break;
      }
    }
  }
  return settleSpans(out.map(deIndex));
}

/**
 * Keep "half" only where half a page can hold it.
 *
 * A contents page or a ten-question drill given half the width prints a column of
 * two-word lines. Size decides it, not type alone: four questions beside the notes they
 * test is a good page, ten is not, and a chart or a live quiz needs the full width
 * whatever it holds.
 */
function fitsHalf(b: Block): boolean {
  switch (b.type) {
    case 'contents': case 'quiz': case 'chart': case 'reflection':
      return false;
    case 'practice':
      return b.questions.length <= 4;
    case 'table':
      return b.rows.length <= 4 && b.headers.length <= 3;
    case 'key_notes':
      return b.cards.length <= 3;
    case 'glossary':
      return b.terms.length <= 4;
    default:
      return true;
  }
}

/** Words in a block, counted over whatever strings it holds. */
function blockWords(b: Block): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') n += v.split(/\s+/).filter(Boolean).length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'type' && k !== 'span') walk(x); });
  };
  walk(b);
  return n;
}

/** Short enough that half a page is not a column of two-word lines. */
const HALF_WORDS = 55;

/**
 * Settle every block's width, reading the page a pair at a time.
 *
 * The model is asked to mark pairs and mostly will not - it answers "full" for
 * everything however the instruction is worded - so the marking is treated as a hint,
 * not the decision. Two neighbours that both fit half a page and are short enough to
 * read there are set side by side; a half the model marked alone still takes its
 * neighbour when that one fits, because a lone half is drawn full width and would have
 * meant nothing.
 *
 * Everything else is full width, which is the safe answer: a block that needed the page
 * and only got half of it is a worse mistake than a page that never pairs.
 */
function settleSpans(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const here = blocks[i], next = blocks[i + 1];
    const pairable = (b: Block | undefined, hinted: boolean): b is Block =>
      !!b && fitsHalf(b) && (blockWords(b) <= HALF_WORDS || hinted);
    if (pairable(here, here.span === 'half') && pairable(next, next?.span === 'half')) {
      out.push({ ...here, span: 'half' }, { ...next, span: 'half' });
      i++;
      continue;
    }
    out.push({ ...here, span: 'full' });
  }
  return out;
}


/**
 * Strip the model's own objective tagging out of a block, and drop what is left empty.
 *
 * Every text-bearing field is cleaned, nested ones included. Cleaning only the block's
 * own top-level strings left the tagging inside the arrays: a worked example asked
 * "Q: Objectives [1] [5] [6] [7] [8] [9] [10]. Plan a short talk for Year 4 about your
 * favourite playground game." - which is the question a nine year old was then set.
 *
 * The block is walked as a plain record rather than through the union: the fields are
 * named the same across block types, and seventeen narrowed branches would say the
 * same thing seventeen times.
 */
function deIndex<T extends Block>(b: T): T {
  const o = { ...(b as unknown as Record<string, unknown>) };
  const one = (v: unknown) => stripTags(String(v ?? ''));
  const label = (v: unknown) => unnumber(stripTags(String(v ?? '')));
  const many = (v: unknown) =>
    Array.isArray(v) ? v.map(one).filter(Boolean) : v;

  if (typeof o.intro === 'string') o.intro = one(o.intro) || null;
  if (typeof o.body === 'string') o.body = one(o.body);
  if (typeof o.heading === 'string') o.heading = one(o.heading);
  if (typeof o.question === 'string') o.question = one(o.question);
  if (typeof o.prompt === 'string') o.prompt = one(o.prompt);
  if (typeof o.note === 'string') o.note = one(o.note);

  // A key notes card headed "Objectives" whose body was nothing but tags -
  // "[10] Monochromatic painting [11] Colour theory" - is a tagging note to itself,
  // not a note to a pupil, so it goes rather than printing empty.
  if (Array.isArray(o.cards)) {
    o.cards = (o.cards as Record<string, unknown>[])
      .map(c => ({ ...c, heading: label(c?.heading), body: one(c?.body) }))
      .filter(c => String(c.body).length > 2);
  }
  if (Array.isArray(o.examples)) {
    o.examples = (o.examples as Record<string, unknown>[]).map(e => ({
      ...e, prompt: one(e?.prompt), steps: many(e?.steps), answer: one(e?.answer),
    }));
  }
  // practice questions carry `text`; quiz questions carry `q` and their options.
  if (Array.isArray(o.questions)) {
    o.questions = (o.questions as Record<string, unknown>[]).map(q => ({
      ...q,
      ...(typeof q?.text === 'string' ? { text: one(q.text) } : {}),
      ...(typeof q?.q === 'string' ? { q: one(q.q) } : {}),
      // Positional, not filtered: `correct` is an index into this array, and an
      // option dropped for coming back empty moves every option after it, so the
      // quiz then marks the wrong answer right.
      ...(Array.isArray(q?.options) ? { options: (q.options as unknown[]).map(one) } : {}),
      ...(typeof q?.explain === 'string' ? { explain: one(q.explain) } : {}),
    }));
  }
  if (Array.isArray(o.terms)) {
    o.terms = (o.terms as Record<string, unknown>[])
      .map(t => ({ ...t, term: label(t?.term), definition: one(t?.definition) }));
  }
  // `columns` is a count on key_notes and practice, and a list on checklist.
  if (Array.isArray(o.columns)) {
    o.columns = (o.columns as Record<string, unknown>[]).map(c => ({
      ...c, heading: label(c?.heading),
      ...(typeof c?.blurb === 'string' ? { blurb: one(c.blurb) } : {}),
      items: many(c?.items),
    }));
  }
  if (Array.isArray(o.sources)) {
    o.sources = (o.sources as Record<string, unknown>[]).map(s => ({
      ...s, label: label(s?.label), text: one(s?.text), quick_check: one(s?.quick_check),
    }));
  }
  if (Array.isArray(o.rows)) {
    o.rows = (o.rows as Record<string, unknown>[])
      .map(r => ({ ...r, cells: many(r?.cells) }));
  }
  if (Array.isArray(o.items)) o.items = many(o.items);
  if (Array.isArray(o.tips)) o.tips = many(o.tips);
  if (Array.isArray(o.self_check)) o.self_check = many(o.self_check);
  if (Array.isArray(o.aside_items)) o.aside_items = many(o.aside_items);
  if (Array.isArray(o.groups)) {
    o.groups = (o.groups as Record<string, unknown>[]).map(g => ({
      ...g, label: label(g?.label),
      ...(Array.isArray(g?.items) ? { items: (g.items as Record<string, unknown>[])
        .map(i => ({ ...i, name: label(i?.name), why: one(i?.why) })) } : {}),
    }));
  }
  if (o.left && typeof o.left === 'object') {
    const l = o.left as Record<string, unknown>;
    o.left = { ...l, heading: label(l.heading), body: one(l.body) };
  }
  if (o.right && typeof o.right === 'object') {
    const r = o.right as Record<string, unknown>;
    o.right = { ...r, heading: label(r.heading), body: one(r.body) };
  }

  return o as unknown as T;
}

/**
 * Take the objective indexes back out of a block's own words.
 *
 * The model is handed the objectives numbered so it can tag each page with the ones
 * it covers, and it wrote the tags into the pack as well: a practice block introduced
 * itself as "Objectives: [0] [2] [9] [10]". The tagging belongs in
 * `objective_indexes`, which the page header already prints in full.
 */
function stripTags(text: string): string {
  return String(text ?? "")
    .replace(/\[\d{1,2}\]/g, "")
    .replace(/\s{2,}/g, " ")
    // A tag taken out of the middle leaves its space behind: "Explain diffusion ."
    .replace(/\s+([.,;:?!])/g, "$1")
    // The word that introduced them goes with them - "Objectives [4] and [5]: Where
    // might you notice diffusion?" - but only when a colon, dash or full stop shows it
    // was a label. "Objectives are what a pack is for" is a sentence, and stays one.
    //
    // The label is not always bare, and the numbers are not always in brackets: packs
    // came back introducing a drill with "Page objectives: 16, 17, 18, 19, 21, 22, 23,
    // 24, 25. Answer in full sentences where you can." Everything up to and including
    // the list goes; the instruction after it is the teacher's and stays.
    .replace(
      /^\s*(?:page|this page(?:'s)?|the following)?\s*objectives?\b[\s,]*(?:and[\s,]*)*[:\-\u2013\u2014.]\s*(?:\d{1,2}(?:\s*,\s*\d{1,2})*\s*[.)]?\s*)?/i,
      "",
    )
    // Bracketless and label-less too: one pack introduced its practice questions with
    // the bare list "0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16".
    //
    // Three numbers at least. As /^[\d,\s]+$/ this erased every value in the pack that
    // was a number and nothing else: a worked example answering "1482", a quiz offering
    // "5", "6", "7", a table cell of figures. The maths packs printed ANSWER over an
    // empty bar and quizzes with options missing - and because the emptied options were
    // then filtered out, the index of the correct one moved. A list of objective
    // indices is never one or two numbers; an answer very often is.
    .replace(/^\s*\d{1,3}(?:\s*,\s*\d{1,3}){2,}\s*$/, "")
    .trim();
}
