/**
 * A v2 study pack drawn with pdf-lib - the plain fallback for when no headless browser
 * can be started (lib/pdf/renderers/studypack_print.ts falls back through
 * ./studypack.ts to here).
 *
 * The designed pack is the browser print of the pack's own HTML. This is not that, and
 * must not try to be: a page-designed document reproduced in a second layout engine is
 * two designs that drift apart. Its one duty is to be COMPLETE - the v1-only loop it
 * replaces drew a header, an info strip and nothing else on every v2 pack, which is
 * what "Download printable PDF" returned to a teacher every time the browser failed.
 *
 * No database import, on purpose: the drawing can then be exercised on its own from
 * scripts/render_check.ts, without Supabase or a model.
 */
import { rgb, RGB, PDFFont } from 'pdf-lib';
import {
  A4, Margins, Fonts, Cursor, DocCtx, newDoc, newPage, wrapText, drawText, truncateToWidth,
} from '@/lib/pdf/layout';
import { FOREST, GOLD, drawHeader, drawInfoStrip, drawFooterOnAllPages } from '@/lib/pdf/branding';
import type { Block, PackV2 } from '@/lib/studypack/schema';

const INK = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.47);
const HAIRLINE = rgb(0.85, 0.85, 0.86);
const CARD_BG = rgb(0.961, 0.969, 0.941);
const RULE = rgb(0.725, 0.761, 0.698);
const TONE_BG: Record<string, RGB> = {
  note: rgb(0.945, 0.961, 1), tip: rgb(0.941, 0.992, 0.957), warning: rgb(0.996, 0.949, 0.949),
};
const CONTENT_W = A4.width - Margins.left - Margins.right;
const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** A question is worked on paper, so it needs paper to be worked on. */
const DEFAULT_ANSWER_LINES = 3;

/** A wrapped paragraph that advances the cursor and breaks pages as needed. */
function para(ctx: DocCtx, cur: Cursor, text: string, font: PDFFont,
             size: number, color: RGB, indent = 0, gapAfter = 3): void {
  const maxW = CONTENT_W - indent;
  const lh = size * Fonts.lineHeight;
  for (const line of wrapText(font, text, size, maxW)) {
    cur.ensure(lh);
    drawText(cur.page, line, Margins.left + indent, cur.y - size, { font, size, color });
    cur.advance(lh);
  }
  cur.advance(gapAfter);
}

/** A forest section heading with a hairline under it. */
function heading(ctx: DocCtx, cur: Cursor, text: string): void {
  cur.ensure(Fonts.subheadSize * Fonts.lineHeight + 14);
  cur.advance(8);
  for (const line of wrapText(ctx.bold, text, Fonts.subheadSize, CONTENT_W)) {
    drawText(cur.page, line, Margins.left, cur.y - Fonts.subheadSize,
      { font: ctx.bold, size: Fonts.subheadSize, color: FOREST });
    cur.advance(Fonts.subheadSize * Fonts.lineHeight);
  }
  cur.advance(2);
  cur.page.drawLine({
    start: { x: Margins.left, y: cur.y }, end: { x: A4.width - Margins.right, y: cur.y },
    thickness: 0.5, color: HAIRLINE,
  });
  cur.advance(8);
}

/** A small gold eyebrow label (Key ideas / Practice questions). */
function label(ctx: DocCtx, cur: Cursor, text: string): void {
  cur.ensure(Fonts.smallSize * Fonts.lineHeight + 2);
  drawText(cur.page, text.toUpperCase(), Margins.left, cur.y - Fonts.smallSize,
    { font: ctx.bold, size: Fonts.smallSize - 1, color: GOLD });
  cur.advance(Fonts.smallSize * Fonts.lineHeight);
}

/**
 * A v2 pack: pages of blocks, flowed onto A4 portrait.
 *
 * The pack's own HTML is page-designed and this is not - a designed page cannot be
 * reproduced faithfully in a second layout engine, and pretending otherwise is how two
 * designs drift apart. So the sheets become sections of one continuous document, in
 * order, and every block draws whatever it holds. What matters is that nothing is
 * silently dropped: an unknown block type is the only thing that draws nothing, and
 * that is because stored content outlives this file.
 */
export async function renderPackPdfV2(
  pack: PackV2, meta: { subject: string; yearGroup: string; weeks: string },
): Promise<Uint8Array> {
  // Homework and worksheets are composed as packs too, so the document says what it
  // actually is rather than calling every one of them a study pack.
  const title = `${pack.kind ?? 'Study Pack'} - ${pack.title}`;
  const ctx = await newDoc();
  const cur = new Cursor(ctx);

  await drawHeader(ctx, cur, title);
  drawInfoStrip(ctx, cur, [
    ['Subject', meta.subject], ['Year', meta.yearGroup], ['Weeks', meta.weeks],
    ['Objectives', String(pack.objectives?.length ?? 0)],
  ]);

  para(ctx, cur, pack.title, ctx.bold, Fonts.subheadSize, FOREST, 0, 3);
  if (pack.subtitle) para(ctx, cur, pack.subtitle, ctx.italic, Fonts.bodySize, MUTED, 0, 4);
  para(ctx, cur, 'A printable revision companion. Work through the questions; the answer key is at the end.',
    ctx.italic, Fonts.smallSize, MUTED, 0, 8);

  // Every objective, in full, as the pack's own cover carries them.
  if (pack.objectives?.length) {
    heading(ctx, cur, 'Objectives');
    for (const o of pack.objectives) {
      para(ctx, cur, `${o.ref ? `${o.ref}  ` : ''}${o.text}`, ctx.regular, Fonts.smallSize, INK, 0, 2);
    }
  }

  // Questions are numbered continuously across the whole pack; the key lists them in
  // the same order, so a number is all a marker needs.
  const key: { n: number; correct: string; explain: string }[] = [];
  let qNum = 0;

  for (const page of pack.pages ?? []) {
    heading(ctx, cur, page.eyebrow ? `${page.eyebrow} - ${page.title}` : page.title);

    const objs = (page.objective_indexes ?? []).map(i => pack.objectives?.[i]).filter(Boolean);
    for (const o of objs) {
      para(ctx, cur, `${o.ref ? `${o.ref}  ` : ''}${o.text}`, ctx.regular, Fonts.smallSize, MUTED, 0, 2);
    }
    if (objs.length) cur.advance(3);

    for (const block of page.blocks ?? []) {
      qNum = drawBlock(ctx, cur, block, pack, qNum, key);
    }
  }

  // The answer key starts a fresh page, so it can be torn off or withheld.
  if (key.length) {
    cur.page = newPage(ctx);
    cur.y = A4.height - Margins.top;
    heading(ctx, cur, 'Answer key');
    para(ctx, cur, 'Questions are numbered in the order they appear above.', ctx.italic, Fonts.smallSize, MUTED, 0, 6);
    for (const a of key) {
      para(ctx, cur, `${a.n}.  ${a.correct}${a.explain ? ` - ${a.explain}` : ''}`, ctx.regular, Fonts.bodySize, INK, 0, 2);
    }
  }

  drawFooterOnAllPages(ctx, title);
  return ctx.doc.save();
}

/** Draw one block. Returns the running quiz number, which only a quiz advances. */
function drawBlock(
  ctx: DocCtx, cur: Cursor, b: Block, pack: PackV2,
  qNum: number, key: { n: number; correct: string; explain: string }[],
): number {
  switch (b.type) {
    case 'resources':
      label(ctx, cur, 'Helpful resources');
      if (b.intro) para(ctx, cur, b.intro, ctx.italic, Fonts.bodySize, MUTED, 0, 4);
      for (const g of b.groups ?? []) {
        para(ctx, cur, g.label, ctx.bold, Fonts.smallSize, FOREST, 0, 2);
        for (const i of g.items ?? []) {
          para(ctx, cur, `${i.name}${i.why ? ` - ${i.why}` : ''}${i.url ? ` (${i.url})` : ''}`,
            ctx.regular, Fonts.bodySize, INK, 10, 2);
        }
      }
      cur.advance(4);
      break;

    case 'key_notes':
      for (const c of b.cards ?? []) {
        para(ctx, cur, c.heading, ctx.bold, Fonts.bodySize, FOREST, 0, 1);
        para(ctx, cur, c.body, ctx.regular, Fonts.bodySize, INK, 10, 4);
      }
      break;

    case 'key_ideas':
      label(ctx, cur, 'Key ideas');
      for (const i of b.items ?? []) para(ctx, cur, `•  ${i}`, ctx.regular, Fonts.bodySize, INK, 10, 2);
      cur.advance(3);
      break;

    case 'worked_example':
      label(ctx, cur, 'Worked examples');
      for (const e of b.examples ?? []) {
        para(ctx, cur, `Q:  ${e.prompt}`, ctx.bold, Fonts.bodySize, INK, 0, 2);
        (e.steps ?? []).forEach((st, i) => para(ctx, cur, `${i + 1}.  ${st}`, ctx.regular, Fonts.bodySize, INK, 16, 1));
        para(ctx, cur, `Answer:  ${e.answer}`, ctx.bold, Fonts.bodySize, FOREST, 16, 6);
      }
      break;

    case 'practice': {
      label(ctx, cur, 'Practice questions');
      if (b.intro) para(ctx, cur, b.intro, ctx.italic, Fonts.bodySize, MUTED, 0, 4);
      (b.questions ?? []).forEach((q, i) => {
        const text = `${i + 1}.  ${q.text}${q.marks != null ? `  [${q.marks}]` : ''}`;
        const lines = q.answer_lines ?? (q.marks && q.marks > 4 ? 5 : DEFAULT_ANSWER_LINES);
        // A question and the space to answer it are one thing. Reserved together, or
        // the page breaks between them and the answer space arrives with no question.
        keepTogether(ctx, cur, text, lines);
        para(ctx, cur, text, ctx.regular, Fonts.bodySize, INK, 0, 2);
        ruled(cur, lines, 16);
      });
      break;
    }

    case 'quiz':
      label(ctx, cur, 'Quick quiz');
      for (const q of b.questions ?? []) {
        qNum++;
        const stem = `${qNum}.  ${q.q}`;
        keepTogether(ctx, cur, stem, 0, (q.options?.length ?? 0) * Fonts.bodySize * Fonts.lineHeight);
        para(ctx, cur, stem, ctx.bold, Fonts.bodySize, INK, 0, 2);
        (q.options ?? []).forEach((opt, i) =>
          para(ctx, cur, `${OPTION_LETTERS[i] ?? '?'})  ${opt}`, ctx.regular, Fonts.bodySize, INK, 16, 1));
        cur.advance(3);
        key.push({ n: qNum, correct: OPTION_LETTERS[q.correct] ?? '?', explain: q.explain });
      }
      break;

    case 'glossary':
      label(ctx, cur, 'Glossary');
      for (const t of b.terms ?? []) {
        para(ctx, cur, `${t.term} - ${t.definition}`, ctx.regular, Fonts.bodySize, INK, 0, 3);
      }
      cur.advance(3);
      break;

    case 'checklist':
      for (const c of b.columns ?? []) {
        para(ctx, cur, c.heading, ctx.bold, Fonts.bodySize, FOREST, 0, 1);
        if (c.blurb) para(ctx, cur, c.blurb, ctx.italic, Fonts.smallSize, MUTED, 10, 2);
        // An empty box to tick, drawn rather than typed: a "[ ]" in Helvetica is a
        // pair of brackets, and a printed checklist has to look tickable.
        for (const i of c.items ?? []) checkbox(ctx, cur, i);
        cur.advance(4);
      }
      break;

    case 'source_card':
      for (const src of b.sources ?? []) {
        para(ctx, cur, src.label, ctx.bold, Fonts.bodySize, FOREST, 0, 1);
        para(ctx, cur, src.text, ctx.regular, Fonts.bodySize, INK, 10, 2);
        if (src.quick_check) para(ctx, cur, `Quick check: ${src.quick_check}`, ctx.italic, Fonts.smallSize, MUTED, 10, 5);
      }
      break;

    case 'table':
      drawTable(ctx, cur, b.headers ?? [], (b.rows ?? []).map(r => r.cells ?? []));
      if (b.note) para(ctx, cur, b.note, ctx.italic, Fonts.smallSize, MUTED, 0, 5);
      break;

    case 'chart':
      drawChart(ctx, cur, b);
      if (b.aside_items?.length) {
        para(ctx, cur, b.aside_heading ?? 'Useful phrases', ctx.bold, Fonts.smallSize, FOREST, 0, 2);
        for (const i of b.aside_items) para(ctx, cur, `•  ${i}`, ctx.regular, Fonts.smallSize, INK, 10, 1);
        cur.advance(4);
      }
      break;

    case 'two_column':
      for (const side of [b.left, b.right]) {
        if (!side) continue;
        para(ctx, cur, side.heading, ctx.bold, Fonts.bodySize, FOREST, 0, 1);
        para(ctx, cur, side.body, ctx.regular, Fonts.bodySize, INK, 10, 5);
      }
      break;

    case 'callout':
      tinted(ctx, cur, TONE_BG[b.tone] ?? TONE_BG.note,
        `${b.heading ? `${b.heading}  ` : ''}${b.body}`);
      break;

    case 'think':
      tinted(ctx, cur, CARD_BG, `Think further: ${b.question}`
        + (b.resource_name ? `  (${b.resource_name}${b.resource_url ? ` - ${b.resource_url}` : ''})` : ''));
      break;

    case 'reflection':
      label(ctx, cur, 'Reflection task');
      {
        const text = `${b.prompt}${b.marks != null ? `  [${b.marks}]` : ''}`;
        keepTogether(ctx, cur, text, 6);
        para(ctx, cur, text, ctx.regular, Fonts.bodySize, INK, 0, 2);
        ruled(cur, 6, 0);
      }
      for (const c of b.self_check ?? []) checkbox(ctx, cur, c);
      cur.advance(4);
      break;

    case 'contents':
      label(ctx, cur, b.heading ?? 'Contents');
      (pack.pages ?? []).forEach((p, i) => {
        if (!(p.blocks ?? []).some(x => x.type !== 'contents')) return;
        para(ctx, cur, `${i + 1}.  ${p.title}${p.eyebrow ? `  (${p.eyebrow})` : ''}`,
          ctx.regular, Fonts.bodySize, INK, 0, 2);
      });
      cur.advance(3);
      break;

    case 'closing':
      label(ctx, cur, b.heading);
      for (const t of b.tips ?? []) para(ctx, cur, `•  ${t}`, ctx.regular, Fonts.bodySize, INK, 10, 2);
      cur.advance(3);
      break;

    // A block type this renderer does not know draws nothing rather than throwing:
    // stored content outlives this file.
    default:
      break;
  }
  return qNum;
}

/**
 * Break the page before a question rather than inside it.
 *
 * Reserves the question's own lines plus whatever follows it - its answer space, or its
 * lettered options - so the two never end up on different sheets. Capped at one page:
 * something taller than the paper has to break somewhere.
 */
function keepTogether(ctx: DocCtx, cur: Cursor, text: string, answerLines: number, extra = 0): void {
  const wrapped = wrapText(ctx.regular, text, Fonts.bodySize, CONTENT_W).length;
  const need = wrapped * Fonts.bodySize * Fonts.lineHeight
    + Math.min(12, Math.max(0, answerLines)) * 13 + extra + 9;
  cur.ensure(Math.min(need, A4.height - Margins.top - Margins.bottom));
}

/**
 * Ruled lines to answer on.
 *
 * Reserved whole. Breaking per line put a question at the foot of one page and three
 * of its five lines at the head of the next, which reads as a printing fault - and left
 * a sheet carrying nothing but the tail of an answer space.
 */
function ruled(cur: Cursor, lines: number, indent: number): void {
  const n = Math.min(12, Math.max(0, lines));
  cur.ensure(n * 13 + 7);
  for (let i = 0; i < n; i++) {
    cur.advance(13);
    cur.page.drawLine({
      start: { x: Margins.left + indent, y: cur.y }, end: { x: A4.width - Margins.right, y: cur.y },
      thickness: 0.5, color: RULE, dashArray: [1, 2],
    });
  }
  cur.advance(7);
}

/** A tickable box and its statement. */
function checkbox(ctx: DocCtx, cur: Cursor, text: string): void {
  const size = Fonts.bodySize;
  const lines = wrapText(ctx.regular, text, size, CONTENT_W - 26);
  cur.ensure(size * Fonts.lineHeight * lines.length);
  cur.page.drawRectangle({
    x: Margins.left + 10, y: cur.y - size - 1, width: 9, height: 9,
    borderColor: rgb(0.45, 0.48, 0.44), borderWidth: 0.8,
  });
  lines.forEach((line, i) => {
    if (i) cur.ensure(size * Fonts.lineHeight);
    drawText(cur.page, line, Margins.left + 26, cur.y - size, { font: ctx.regular, size, color: INK });
    cur.advance(size * Fonts.lineHeight);
  });
  cur.advance(2);
}

/** A tinted full-width note. */
function tinted(ctx: DocCtx, cur: Cursor, bg: RGB, text: string): void {
  const size = Fonts.bodySize, pad = 8;
  const lines = wrapText(ctx.regular, text, size, CONTENT_W - pad * 2);
  const h = lines.length * size * Fonts.lineHeight + pad * 2;
  cur.ensure(h + 6);
  cur.page.drawRectangle({ x: Margins.left, y: cur.y - h, width: CONTENT_W, height: h, color: bg });
  let y = cur.y - pad;
  for (const line of lines) {
    drawText(cur.page, line, Margins.left + pad, y - size, { font: ctx.regular, size, color: INK });
    y -= size * Fonts.lineHeight;
  }
  cur.advance(h + 6);
}

/**
 * A headed grid with wrapped cells.
 *
 * Columns share the width equally. Guessing at content widths would be a layout engine,
 * and this renderer is explicitly not one.
 */
function drawTable(ctx: DocCtx, cur: Cursor, headers: string[], rows: string[][]): void {
  if (!headers.length) return;
  const size = Fonts.smallSize, pad = 5;
  const colW = CONTENT_W / headers.length;
  const cellW = colW - pad * 2;

  const drawRow = (cells: string[], font: PDFFont, bg: RGB | null, color: RGB): void => {
    const wrapped = cells.map(c => wrapText(font, c ?? '', size, cellW));
    const h = Math.max(...wrapped.map(w => w.length), 1) * size * Fonts.lineHeight + pad * 2;
    // A grid whose head is on the previous page is unreadable, so it is redrawn.
    if (cur.ensure(h) && font !== ctx.bold) drawRow(headers, ctx.bold, FOREST, rgb(1, 1, 1));
    if (bg) cur.page.drawRectangle({ x: Margins.left, y: cur.y - h, width: CONTENT_W, height: h, color: bg });
    wrapped.forEach((linesOfCell, i) => {
      let y = cur.y - pad;
      for (const line of linesOfCell) {
        drawText(cur.page, line, Margins.left + i * colW + pad, y - size, { font, size, color });
        y -= size * Fonts.lineHeight;
      }
    });
    cur.page.drawLine({
      start: { x: Margins.left, y: cur.y - h }, end: { x: A4.width - Margins.right, y: cur.y - h },
      thickness: 0.5, color: HAIRLINE,
    });
    cur.advance(h);
  };

  drawRow(headers, ctx.bold, FOREST, rgb(1, 1, 1));
  rows.forEach((r, i) => drawRow(r, ctx.regular, i % 2 ? CARD_BG : null, INK));
  cur.advance(6);
}

/** A bar chart. A line chart is drawn as bars too - the figures are the point, and a
 *  polyline in a fallback PDF is not worth a second code path. */
function drawChart(ctx: DocCtx, cur: Cursor, b: Extract<Block, { type: 'chart' }>): void {
  const series = b.series ?? [];
  if (!series.length) return;
  const H = 130, pad = 18;
  cur.ensure(H + 34);
  para(ctx, cur, `${b.title}${b.unit ? ` (${b.unit})` : ''}`, ctx.bold, Fonts.bodySize, INK, 0, 3);

  const max = Math.max(...series.map(s => s.value), 1);
  const base = cur.y - H;
  const step = CONTENT_W / series.length;
  const barW = Math.min(46, step * 0.55);

  cur.page.drawLine({
    start: { x: Margins.left, y: base }, end: { x: A4.width - Margins.right, y: base },
    thickness: 0.5, color: rgb(0.6, 0.65, 0.58),
  });
  series.forEach((sr, i) => {
    const h = Math.max(1, (sr.value / max) * (H - pad));
    const x = Margins.left + step * (i + 0.5) - barW / 2;
    cur.page.drawRectangle({ x, y: base, width: barW, height: h, color: FOREST });
    const v = String(sr.value), vw = ctx.bold.widthOfTextAtSize(v, Fonts.smallSize);
    drawText(cur.page, v, x + barW / 2 - vw / 2, base + h + 3, { font: ctx.bold, size: Fonts.smallSize, color: FOREST });
    const lab = truncateToWidth(ctx.regular, String(sr.label), Fonts.smallSize, step - 4);
    const lw = ctx.regular.widthOfTextAtSize(lab, Fonts.smallSize);
    drawText(cur.page, lab, Margins.left + step * (i + 0.5) - lw / 2, base - 11,
      { font: ctx.regular, size: Fonts.smallSize, color: MUTED });
  });
  cur.advance(H + 18);
}
