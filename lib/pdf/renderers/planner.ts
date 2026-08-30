/**
 * Render an approved weekly planner to a PDF, on the school's own template.
 *
 * Adopted from Weekly Planner Template.docx — the landscape five-column grid
 * teachers already use: Week/Day · Unit/Objectives · Methods/Resources ·
 * Teacher's Comments · HOD's Comments, under a LUSAKA OAKTREE SCHOOL /
 * SUBJECT / CLASS / TEACHER header. Column proportions and the Resources: /
 * Methodology: sub-labels are taken from the template so the rendered document is
 * the one the school recognises (Addendum C §C4; main spec §4 — the docx is a
 * rendering of the records, never the source of truth).
 *
 * Differentiation, which the template has no column of its own for, lives in the
 * Methods/Resources cell as its own labelled sub-field, because §C4 non-negotiable
 * 5 requires it present on every lesson.
 *
 * Registered as renderer id 'planner' (lib/workflows/registry.ts).
 */
import { admin } from '@/lib/supabase';
import { PDFFont, rgb } from 'pdf-lib';
import { newDoc, wrapText, sanitizeWinAnsi, embedDataUri, DocCtx } from '@/lib/pdf/layout';
import { FOREST, GOLD } from '@/lib/pdf/branding';
import { CREST } from '@/lib/crest';

interface Lesson {
  position: number; day_of_week: number; lesson_date: string;
  objectives: { ref: string | null; text: string }[];
  methodology: string; resources: string; differentiation: string;
  is_recap: boolean; teacher_comment: string | null;
}

// A4 landscape — the template is wider than portrait allows once the two comment
// columns (nearly half its width) are in.
const PAGE = { w: 841.89, h: 595.28 };
const M = { top: 40, right: 32, bottom: 34, left: 32 };
const CONTENT_W = PAGE.w - M.left - M.right;
const HAIRLINE = rgb(0.8, 0.82, 0.78);
const INK = rgb(0.12, 0.12, 0.15);
const WHITE = rgb(1, 1, 1);
const BODY = 9;
const LINE_H = BODY * 1.32;
const PAD = 4;

// The template's five columns, at its own proportions (from the .docx cell widths).
const COLS = [
  { key: 'day', header: 'Week/ Day', flex: 1434 },
  { key: 'obj', header: 'Unit/ Objectives', flex: 2812 },
  { key: 'methods', header: 'Methods / Resources', flex: 3260 },
  { key: 'teacher', header: "Teacher's Comments", flex: 3613 },
  { key: 'hod', header: "HOD's Comments", flex: 2996 },
] as const;
const FLEX_SUM = COLS.reduce((a, c) => a + c.flex, 0);
const WIDTHS = COLS.map(c => (c.flex / FLEX_SUM) * CONTENT_W);
const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

export async function renderPlanner(plannerId: string): Promise<Uint8Array> {
  const db = admin();

  const { data: planner } = await db.from('planner')
    .select('id, class_id, teacher_id, school_week').eq('id', plannerId).single();
  if (!planner) throw new Error(`No planner ${plannerId}`);

  const [{ data: klass }, { data: week }, { data: teacher }, { data: lessons }, { data: review }] =
    await Promise.all([
      db.from('klass').select('name, year_group, subject_id').eq('id', planner.class_id).single(),
      db.from('school_week').select('week_number, week_commencing, semester').eq('id', planner.school_week).single(),
      db.from('app_user').select('full_name').eq('id', planner.teacher_id).single(),
      db.from('lesson_entry').select('position, day_of_week, lesson_date, objectives, methodology, resources, differentiation, is_recap, teacher_comment')
        .eq('planner_id', plannerId).order('position'),
      db.from('hod_review').select('comment, reviewer_id').eq('planner_id', plannerId).order('reviewed_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
  const { data: subject } = klass
    ? await db.from('subject').select('name').eq('id', klass.subject_id).single()
    : { data: null };

  const ctx = await newDoc();
  const semester = week?.semester ?? 1;
  const title = `Weekly Planner — Semester ${semester} (2026/27)`;

  const st = new Sheet(ctx);
  await st.header(title, {
    subject: subject?.name ?? klass?.subject_id ?? '—',
    klass: klass?.name ?? '—',
    teacher: teacher?.full_name ?? '—',
    week: `${week?.week_number ?? '?'}  ·  w/c ${week?.week_commencing ?? ''}`,
  });
  st.tableHeader();

  const rows = (lessons ?? []) as Lesson[];
  rows.forEach((l, i) => {
    const hodComment = i === 0 && review?.comment ? review.comment : '';
    st.row({
      day: `${DAYS[l.day_of_week] ?? `Day ${l.day_of_week}`}${l.is_recap ? '\n(recap)' : ''}\n${l.lesson_date ?? ''}`,
      obj: (l.objectives ?? []).map(o => `${o.ref ? o.ref + ' — ' : ''}${o.text}`).join('\n\n'),
      methods: methodsCell(l),
      teacher: l.teacher_comment ?? '',
      hod: hodComment,
    }, l.is_recap);
  });

  st.finish(title);
  return ctx.doc.save();
}

/** Methods/Resources cell: the template's two sub-labels, plus Differentiation. */
function methodsCell(l: Lesson): string {
  return [
    `Resources: ${l.resources ?? ''}`.trim(),
    `Methodology: ${l.methodology ?? ''}`.trim(),
    l.differentiation?.trim() ? `Differentiation: ${l.differentiation}` : '',
  ].filter(Boolean).join('\n\n');
}

/** A landscape sheet that lays out the five-column grid with wrapping rows and
 *  page breaks that redraw the column header — the planner's own table drawer,
 *  kept local because it is landscape and prose where the shared table helpers are
 *  portrait and numeric. */
class Sheet {
  y: number;
  page;
  constructor(private ctx: DocCtx) {
    this.page = ctx.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - M.top;
  }

  private text(s: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
    this.page.drawText(sanitizeWinAnsi(s), { x, y, size, font, color });
  }

  async header(title: string, info: { subject: string; klass: string; teacher: string; week: string }) {
    // Top forest bar + crest + school identity.
    this.page.drawRectangle({ x: 0, y: PAGE.h - 7, width: PAGE.w, height: 7, color: FOREST });
    const crest = await embedDataUri(this.ctx, CREST);
    let x = M.left;
    if (crest) {
      const h = 38, w = crest.w * (h / crest.h);
      this.page.drawImage(crest.image, { x: M.left, y: this.y - h, width: w, height: h });
      x = M.left + w + 10;
    }
    this.text('LUSAKA OAKTREE SCHOOL', x, this.y - 13, this.ctx.bold, 14, FOREST);
    this.text(title, x, this.y - 29, this.ctx.bold, 10.5, GOLD);
    this.y -= 46;

    // Info line — SUBJECT / CLASS / TEACHER / WEEK, as the template's header block.
    const parts: [string, string][] = [
      ['SUBJECT', info.subject], ['CLASS', info.klass], ['TEACHER', info.teacher], ['WEEK', info.week],
    ];
    let ix = M.left;
    const gap = CONTENT_W / parts.length;
    for (const [label, value] of parts) {
      this.text(label + ':', ix, this.y, this.ctx.bold, 9, FOREST);
      const lw = this.ctx.bold.widthOfTextAtSize(label + ': ', 9);
      this.text(value, ix + lw, this.y, this.ctx.regular, 9);
      ix += gap;
    }
    this.y -= 14;
    this.page.drawLine({ start: { x: M.left, y: this.y }, end: { x: PAGE.w - M.right, y: this.y }, thickness: 0.6, color: HAIRLINE });
    this.y -= 8;
  }

  tableHeader() {
    const h = 20;
    this.page.drawRectangle({ x: M.left, y: this.y - h, width: CONTENT_W, height: h, color: FOREST });
    let x = M.left;
    COLS.forEach((c, i) => {
      this.text(c.header, x + PAD, this.y - 13, this.ctx.bold, 9, WHITE);
      x += WIDTHS[i];
    });
    this.y -= h;
  }

  row(cells: Record<string, string>, recap: boolean) {
    // Wrap each cell to its column, row height is the tallest.
    const wrapped = COLS.map((c, i) =>
      wrapText(this.ctx.regular, cells[c.key] ?? '', BODY, WIDTHS[i] - PAD * 2));
    const rowH = Math.max(28, ...wrapped.map(ls => ls.length * LINE_H + PAD * 2));

    if (this.y - rowH < M.bottom) {           // page break — redraw the column header
      this.page = this.ctx.doc.addPage([PAGE.w, PAGE.h]);
      this.y = PAGE.h - M.top;
      this.tableHeader();
    }

    const top = this.y;
    if (recap) this.page.drawRectangle({ x: M.left, y: top - rowH, width: CONTENT_W, height: rowH, color: rgb(0.98, 0.95, 0.86) });

    let x = M.left;
    wrapped.forEach((lines, i) => {
      // Vertical rule between columns.
      if (i > 0) this.page.drawLine({ start: { x, y: top }, end: { x, y: top - rowH }, thickness: 0.4, color: HAIRLINE });
      const first = COLS[i].key === 'day';
      let ly = top - PAD - BODY;
      for (const line of lines) {
        this.page.drawText(line, { x: x + PAD, y: ly, size: BODY, font: first ? this.ctx.bold : this.ctx.regular, color: first ? FOREST : INK });
        ly -= LINE_H;
      }
      x += WIDTHS[i];
    });
    // Bottom rule.
    this.page.drawLine({ start: { x: M.left, y: top - rowH }, end: { x: M.left + CONTENT_W, y: top - rowH }, thickness: 0.5, color: HAIRLINE });
    this.y -= rowH;
  }

  finish(title: string) {
    // Outer left/right borders on every page, and a footer with page numbers.
    const pages = this.ctx.doc.getPages();
    pages.forEach((p, i) => {
      if (i > 0) p.drawRectangle({ x: 0, y: PAGE.h - 7, width: PAGE.w, height: 7, color: FOREST });
      p.drawLine({ start: { x: M.left, y: M.bottom }, end: { x: PAGE.w - M.right, y: M.bottom }, thickness: 0.5, color: HAIRLINE });
      const label = `Page ${i + 1} of ${pages.length}`;
      const w = this.ctx.regular.widthOfTextAtSize(label, 8);
      p.drawText(label, { x: PAGE.w - M.right - w, y: M.bottom - 11, size: 8, font: this.ctx.regular, color: rgb(0.5, 0.5, 0.55) });
      p.drawText(sanitizeWinAnsi(`${title}  ·  Generated by LOTS AI`), { x: M.left, y: M.bottom - 11, size: 8, font: this.ctx.regular, color: rgb(0.5, 0.5, 0.55) });
    });
  }
}
