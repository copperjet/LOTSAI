/**
 * Render a stored study pack to a printable A4 PDF — the paper companion to the
 * interactive HTML. Same content, laid out for a desk and a pen: key ideas as
 * bullets, quizzes as numbered questions with lettered options (no answers shown),
 * a think question per topic, a glossary, and a separate ANSWER KEY at the end so
 * the questions can be worked before the answers are seen.
 *
 * Built on the shared pdf-lib layer (lib/pdf/layout + branding) so it carries the
 * school's identity and the WinAnsi sanitiser every model-written artefact needs.
 * Registered as renderer id 'studypack-pdf' (lib/workflows/registry.ts); its output
 * format is set in lib/pdf/store.ts.
 */
import { admin } from '@/lib/supabase';
import { rgb, RGB, PDFFont } from 'pdf-lib';
import {
  A4, Margins, Fonts, Cursor, DocCtx, newDoc, newPage, wrapText, drawText,
} from '@/lib/pdf/layout';
import { FOREST, GOLD, drawHeader, drawInfoStrip, drawFooterOnAllPages } from '@/lib/pdf/branding';
import type { PackContent } from '@/lib/studypack';

const INK = rgb(0.12, 0.12, 0.15);
const MUTED = rgb(0.42, 0.42, 0.47);
const HAIRLINE = rgb(0.85, 0.85, 0.86);
const CONTENT_W = A4.width - Margins.left - Margins.right;
const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export async function renderStudyPackPdf(studyPackId: string): Promise<Uint8Array> {
  const db = admin();
  const { data: pack } = await db.from('study_pack')
    .select('content, subject_id, year_group, week_from, week_to').eq('id', studyPackId).single();
  if (!pack) throw new Error(`No study pack ${studyPackId}`);

  const content = pack.content as PackContent;
  const title = `Study Pack - ${content.title ?? 'Revision'}`;

  const ctx = await newDoc();
  const cur = new Cursor(ctx);
  await drawHeader(ctx, cur, title);
  drawInfoStrip(ctx, cur, [
    ['Subject', pack.subject_id ?? '-'],
    ['Year', pack.year_group ?? '-'],
    ['Weeks', `${pack.week_from}-${pack.week_to}`],
    ['Objectives', String(content.objective_refs?.length ?? 0)],
  ]);

  para(ctx, cur, content.title ?? 'Revision pack', ctx.bold, Fonts.subheadSize, FOREST, 0, 4);
  para(ctx, cur, 'A printable revision companion. Work through the questions; the answer key is at the end.',
    ctx.italic, Fonts.smallSize, MUTED, 0, 8);

  // Questions are numbered continuously across the whole pack; the key lists them
  // in the same order, so a number is all a marker needs.
  let qNum = 0;
  const key: { n: number; correct: string; explain: string }[] = [];

  for (const unit of content.units ?? []) {
    heading(ctx, cur, unit.unit_label);
    if (unit.summary?.trim()) para(ctx, cur, unit.summary, ctx.italic, Fonts.bodySize, MUTED, 0, 6);

    for (const topic of unit.topics ?? []) {
      para(ctx, cur, topic.topic_label, ctx.bold, Fonts.bodySize + 1, INK, 0, 3);

      const refs = (topic.objectives ?? []).map(o => o.ref).filter(Boolean);
      if (refs.length) para(ctx, cur, `Objectives: ${refs.join(', ')}`, ctx.regular, Fonts.smallSize, MUTED, 0, 4);

      if (topic.key_ideas?.length) {
        label(ctx, cur, 'Key ideas');
        for (const idea of topic.key_ideas) para(ctx, cur, `•  ${idea}`, ctx.regular, Fonts.bodySize, INK, 10, 2);
        cur.advance(3);
      }

      if (topic.quiz?.length) {
        label(ctx, cur, 'Questions');
        for (const q of topic.quiz) {
          qNum++;
          // Keep a question with at least its first option on the same page.
          cur.ensure(Fonts.bodySize * Fonts.lineHeight * 3);
          para(ctx, cur, `${qNum}.  ${q.q}`, ctx.bold, Fonts.bodySize, INK, 0, 2);
          q.options.forEach((opt, i) =>
            para(ctx, cur, `${OPTION_LETTERS[i] ?? '?'})  ${opt}`, ctx.regular, Fonts.bodySize, INK, 16, 1));
          cur.advance(3);
          key.push({ n: qNum, correct: OPTION_LETTERS[q.correct] ?? '?', explain: q.explain });
        }
      }

      if (topic.think_question?.trim()) {
        para(ctx, cur, `Think:  ${topic.think_question}`, ctx.italic, Fonts.bodySize, GOLD, 0, 8);
      }
    }
  }

  if (content.glossary?.length) {
    heading(ctx, cur, 'Glossary');
    for (const g of content.glossary) {
      para(ctx, cur, `${g.term} - ${g.definition}`, ctx.regular, Fonts.bodySize, INK, 0, 3);
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
    drawText(cur.page, line, Margins.left, cur.y - Fonts.subheadSize, { font: ctx.bold, size: Fonts.subheadSize, color: FOREST });
    cur.advance(Fonts.subheadSize * Fonts.lineHeight);
  }
  cur.advance(2);
  cur.page.drawLine({
    start: { x: Margins.left, y: cur.y }, end: { x: A4.width - Margins.right, y: cur.y },
    thickness: 0.5, color: HAIRLINE,
  });
  cur.advance(8);
}

/** A small gold eyebrow label (Key ideas / Questions). */
function label(ctx: DocCtx, cur: Cursor, text: string): void {
  cur.ensure(Fonts.smallSize * Fonts.lineHeight + 2);
  drawText(cur.page, text.toUpperCase(), Margins.left, cur.y - Fonts.smallSize,
    { font: ctx.bold, size: Fonts.smallSize - 1, color: GOLD });
  cur.advance(Fonts.smallSize * Fonts.lineHeight);
}
