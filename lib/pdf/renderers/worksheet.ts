/**
 * Render a stored worksheet to a printable A4 PDF — the school's differentiated
 * task sheet. Each task is shown at its core, with its Support and Extension tiers
 * boxed beneath it, and the answer key follows on its own page so the sheet can be
 * printed and handed out without the answers.
 *
 * Built on the shared pdf-lib layer (lib/pdf/layout + branding) so it carries the
 * school's identity and the WinAnsi sanitiser every model-written artefact needs.
 * Registered as renderer id 'worksheet' (lib/workflows/registry.ts); its output
 * format is set in lib/pdf/store.ts.
 */
import { admin } from '@/lib/supabase';
import { rgb, RGB, PDFFont } from 'pdf-lib';
import {
  A4, Margins, Fonts, Cursor, DocCtx, newDoc, newPage, wrapText, drawText,
} from '@/lib/pdf/layout';
import { FOREST, GOLD, drawHeader, drawInfoStrip, drawFooterOnAllPages } from '@/lib/pdf/branding';
import type { WorksheetContent } from '@/lib/worksheet';

const INK = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.47);
const HAIRLINE = rgb(0.85, 0.85, 0.86);
const TIER_BG = rgb(0.96, 0.97, 0.94);
const CONTENT_W = A4.width - Margins.left - Margins.right;

export async function renderWorksheet(worksheetId: string): Promise<Uint8Array> {
  const db = admin();
  const { data: ws } = await db.from('worksheet')
    .select('content, subject_id, year_group, week_number').eq('id', worksheetId).single();
  if (!ws) throw new Error(`No worksheet ${worksheetId}`);

  const content = ws.content as WorksheetContent;
  const title = `Worksheet — ${content.title ?? 'Tasks'}`;

  const ctx = await newDoc();
  const cur = new Cursor(ctx);
  await drawHeader(ctx, cur, title);
  drawInfoStrip(ctx, cur, [
    ['Subject', ws.subject_id ?? '—'],
    ['Year', ws.year_group ?? '—'],
    ['Week', String(ws.week_number ?? '—')],
    ['Objectives', String(content.objective_refs?.length ?? 0)],
  ]);

  para(cur, content.title ?? 'Worksheet', ctx.bold, Fonts.subheadSize, FOREST, 0, 3);
  if (content.intro?.trim()) para(cur, content.intro, ctx.italic, Fonts.bodySize, MUTED, 0, 6);
  para(cur, 'Name: ______________________________     Class: __________     Date: __________',
    ctx.regular, Fonts.smallSize, MUTED, 0, 10);

  const key: { n: number; answer: string }[] = [];

  (content.tasks ?? []).forEach((t, i) => {
    const n = i + 1;
    // Keep a task's heading with at least its first lines on one page.
    cur.ensure(Fonts.bodySize * Fonts.lineHeight * 4);
    heading(ctx, cur, `Task ${n}`);
    const refs = (t.objectives ?? []).map(o => o.ref).filter(Boolean);
    if (refs.length) para(cur, `Objectives: ${refs.join(', ')}`, ctx.regular, Fonts.smallSize, MUTED, 0, 4);

    para(cur, t.core, ctx.regular, Fonts.bodySize, INK, 0, 5);
    if (t.support?.trim()) tierBox(ctx, cur, 'Support', t.support);
    if (t.extension?.trim()) tierBox(ctx, cur, 'Extension', t.extension);
    cur.advance(4);

    key.push({ n, answer: t.answer ?? '' });
  });

  // The answer key starts a fresh page, so the sheet can be printed without it.
  if (key.length) {
    cur.page = newPage(ctx);
    cur.y = A4.height - Margins.top;
    heading(ctx, cur, 'Answer key');
    para(cur, 'For the teacher — not for the handout.', ctx.italic, Fonts.smallSize, MUTED, 0, 6);
    for (const a of key) {
      para(cur, `Task ${a.n}.  ${a.answer || '—'}`, ctx.regular, Fonts.bodySize, INK, 0, 3);
    }
  }

  drawFooterOnAllPages(ctx, title);
  return ctx.doc.save();
}

/** A wrapped paragraph that advances the cursor and breaks pages as needed. */
function para(cur: Cursor, text: string, font: PDFFont, size: number, color: RGB, indent = 0, gapAfter = 3): void {
  const maxW = CONTENT_W - indent;
  const lh = size * Fonts.lineHeight;
  for (const line of wrapText(font, text, size, maxW)) {
    cur.ensure(lh);
    drawText(cur.page, line, Margins.left + indent, cur.y - size, { font, size, color });
    cur.advance(lh);
  }
  cur.advance(gapAfter);
}

/** A labelled, tinted box for a differentiation tier (Support / Extension). */
function tierBox(ctx: DocCtx, cur: Cursor, label: string, text: string): void {
  const size = Fonts.bodySize;
  const lh = size * Fonts.lineHeight;
  const indent = 12;
  const lines = wrapText(ctx.regular, text, size, CONTENT_W - indent * 2 - 8);
  const boxH = lh + lines.length * lh + 10;
  cur.ensure(boxH + 4);
  const top = cur.y;
  cur.page.drawRectangle({ x: Margins.left + indent, y: top - boxH, width: CONTENT_W - indent, height: boxH, color: TIER_BG });
  drawText(cur.page, label.toUpperCase(), Margins.left + indent + 6, top - size - 2,
    { font: ctx.bold, size: Fonts.smallSize - 1, color: GOLD });
  let ly = top - lh - size - 2 + (lh - size);
  for (const line of lines) {
    drawText(cur.page, line, Margins.left + indent + 6, ly, { font: ctx.regular, size, color: INK });
    ly -= lh;
  }
  cur.y = top - boxH - 4;
}

/** A forest section heading with a hairline under it. */
function heading(ctx: DocCtx, cur: Cursor, text: string): void {
  cur.ensure(Fonts.subheadSize * Fonts.lineHeight + 14);
  cur.advance(8);
  drawText(cur.page, text, Margins.left, cur.y - Fonts.subheadSize, { font: ctx.bold, size: Fonts.subheadSize, color: FOREST });
  cur.advance(Fonts.subheadSize * Fonts.lineHeight + 2);
  cur.page.drawLine({
    start: { x: Margins.left, y: cur.y }, end: { x: A4.width - Margins.right, y: cur.y },
    thickness: 0.5, color: HAIRLINE,
  });
  cur.advance(8);
}
