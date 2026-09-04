/**
 * Changing a pack that has already been built.
 *
 * Until now a study pack was a one-shot. It was generated, gated and approved, and a
 * teacher looking at page 4 and saying "the glossary is too long" or "put this
 * photograph on page 8" had nowhere to say it - the only remedy was to build the
 * whole pack again and lose everything that was right about it.
 *
 * What a revision may do: rewrite, reorder, add and remove the BLOCKS on a page.
 * What it may never do: touch `pack.objectives`. That list came from the curriculum
 * registry (or from a teacher's own file, matched against it) and the founding rule
 * has not moved - nothing in this system writes an objective. The model here is given
 * the objectives as read-only context so it can write to them, and the objective list
 * and every page's `objective_indexes` are carried over from the stored pack rather
 * than taken from the response. The gate then checks the result exactly as it checks
 * a generated one.
 *
 * Pages are addressed the way a teacher reads them: "page 4" is the fourth sheet of
 * the document, cover included. The grounding numbers them that way so the model and
 * the teacher are looking at the same page.
 */
import { call } from '@/lib/llm';
import { repairBlocks } from './generate';
import { BLOCK_TYPES, blockUnion, type Block, type PackV2 } from './schema';
import type { PackAsset } from './assets';

/** Longest a teacher's instruction may be. Past this it is a brief, not a change. */
const MAX_INSTRUCTION = 2000;

/** How much of a teacher's pasted material to carry. The same order as the fill
 *  pass's own budget for an uploaded document. */
const MAX_MATERIAL = 40_000;

const SYSTEM = `You revise study packs for Lusaka Oaktree School, a Cambridge primary and
lower-secondary school in Zambia. A pack has already been built and a teacher has asked for a
change to it. You make that change and nothing else.

WHAT YOU MAY CHANGE

The blocks on a page: rewrite them, reword them, reorder them, add one, remove one. That is
the whole of your remit.

WHAT YOU MAY NEVER CHANGE

The objectives. They come from the school's curriculum registry and nothing in this system
writes one. They are given to you so that what you write teaches them; they are not yours to
edit, and which objectives a page covers is not yours to decide either.

The pages themselves. You do not add pages, remove pages, retitle pages or move content
between pages unless the teacher asked for exactly that, in which case do it within the pages
that exist.

HOW TO ANSWER

Return only the pages you actually changed, each with its COMPLETE new list of blocks - not a
patch, not only the block that moved. A page you do not return is left exactly as it is, which
is what you want for every page the teacher did not mention.

If the teacher named a page, change that page. If they described something without naming a
page, find it and change it where it is. If what they asked for cannot be done, return no
pages and say so plainly in "note", in one sentence, in the register a colleague would use.

"note" is what the teacher is told you did. One sentence, plain British English, past tense.
Never an em dash or an en dash; use a plain hyphen.

Keep the pack's own voice and reading age. A page is printed at a fixed size and holds about
450 words of pupil-facing text; a page you make longer is a page that runs onto a second sheet
with no heading on it, so if you add something, take something out.`;

export interface ReviseInput {
  pack: PackV2;
  instruction: string;
  /** Text the teacher supplied for this change - a passage, a set of questions, the
   *  extracted text of a file they attached. */
  material?: string | null;
  /** Pictures this pack holds. The model may place one by id and no other. */
  assets?: PackAsset[];
}

export interface ReviseResult {
  content: PackV2;
  /** What changed, for the teacher and for the revision row. */
  note: string;
  changedPageIds: string[];
  usage: unknown;
}

/**
 * The pack as the model reads it: every page, numbered as a sheet, with its blocks.
 *
 * Whole rather than a window around a named page. A pack is tens of kilobytes, the
 * whole of it is cached, and a teacher's instruction is very often not about the page
 * they think it is - "the glossary is too long" names no page at all. Guessing the
 * scope in advance and being wrong costs a revision that changed the wrong thing.
 */
function packBlock(pack: PackV2, assets: PackAsset[]): string {
  const lines: string[] = [];

  lines.push(`PACK: ${pack.title}${pack.subtitle ? ` - ${pack.subtitle}` : ''}`);
  lines.push(`${pack.meta.yearGroup} ${pack.meta.subject}`
    + `${pack.meta.span ? `, ${pack.meta.span}` : ''}, laid out as ${pack.layout}.`);

  lines.push('', 'OBJECTIVES (read-only, and not yours to edit):');
  pack.objectives.forEach((o, i) => {
    lines.push(`  [${i}] ${o.text}${o.ref ? ` (${o.ref})` : ''}`);
  });

  if (assets.length) {
    lines.push('', 'PICTURES THIS PACK HOLDS. Place one with an "image" block, using its id exactly',
      'as written. Never invent an id: an id that is not in this list is dropped, and the page',
      'is then missing the picture the teacher asked for.');
    for (const a of assets) {
      lines.push(`  ${a.id} - ${a.alt}${a.kind === 'generated' ? ' (drawn on request)' : ' (supplied by the teacher)'}`);
    }
  }

  lines.push('', 'PAGES. The number is the sheet the teacher sees, cover included, so "page 4"',
    'below is "page 4" to them.');
  // Sheet 1 is the cover, which is drawn from the pack's own meta and is not a page.
  pack.pages.forEach((p, i) => {
    lines.push('', `--- page ${i + 2} | id: ${p.id} | ${p.title}${p.eyebrow ? ` (${p.eyebrow})` : ''}`
      + `${p.role === 'divider' ? ' | a topic divider: title only, no blocks' : ''}`);
    lines.push(`objectives: ${p.objective_indexes.map(n => `[${n}]`).join(' ') || 'none'}`);
    lines.push(JSON.stringify(p.blocks ?? []));
  });

  return lines.join('\n');
}

export async function reviseStudyPack(
  input: ReviseInput, userId: string,
): Promise<ReviseResult> {
  const { pack } = input;
  const instruction = input.instruction.trim().slice(0, MAX_INSTRUCTION);
  const assets = input.assets ?? [];
  const assetIds = new Set(assets.map(a => a.id));

  const material = (input.material ?? '').trim().slice(0, MAX_MATERIAL);

  const { data, usage } = await call<{
    pages: { id: string; blocks: Block[] }[]; note: string;
  }>({
    tier: 'standard',
    workflow: 'studypack_revise',
    userId,
    system: SYSTEM,
    // The pack is the same for every change a teacher makes to it in a sitting, so it
    // is the cached prefix and the second revision pays a tenth for it.
    cached: [packBlock(pack, assets)],
    prompt: `THE TEACHER ASKS: ${instruction}`
      + (material ? `\n\nMATERIAL THEY SUPPLIED. Use their facts, examples and wording.\n\n${material}` : ''),
    schema: {
      type: 'object', additionalProperties: false,
      required: ['pages', 'note'],
      properties: {
        pages: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'blocks'],
            properties: { id: { type: 'string' }, blocks: { type: 'array', items: blockUnion([...BLOCK_TYPES]) } },
          },
        },
        note: { type: 'string' },
      },
    },
    maxTokens: 12_000,
  });

  // A URL the teacher's own material does not carry is stripped, as it is at
  // generation: a model invents them, and a revision is no less prone to it.
  const allowedUrls = urlsIn(material);

  const byId = new Map((data?.pages ?? []).filter(p => p?.id).map(p => [p.id, p.blocks ?? []]));
  const changedPageIds: string[] = [];

  const pages = pack.pages.map(page => {
    if (!byId.has(page.id)) return page;
    // A divider is a title on a full-bleed field and carries nothing. A revision that
    // put blocks on one would print a page nobody designed.
    if (page.role === 'divider') return page;

    const blocks = repairBlocks(byId.get(page.id) ?? [], allowedUrls, assetIds);
    // A page the model emptied is a page it misread: the teacher asked for a change,
    // not for a blank sheet with a heading on it.
    if (!blocks.length) return page;

    changedPageIds.push(page.id);
    // objective_indexes, accent, role, title and eyebrow all come from the stored
    // page. Only its blocks are the model's to write.
    return { ...page, blocks };
  });

  const note = String(data?.note ?? '').trim()
    || (changedPageIds.length ? 'Done.' : 'I could not make that change.');

  return {
    content: { ...pack, pages },
    note,
    changedPageIds,
    usage,
  };
}

/** Web addresses already present in the teacher's material, normalised for
 *  comparison. The same rule and the same shape as the generator's. */
function urlsIn(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,;)\]]*)?)/gi;
  for (const m of text.matchAll(re)) out.add(m[1].toLowerCase().replace(/[.,)\]]+$/, ''));
  return out;
}
