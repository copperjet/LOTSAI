/**
 * Render a stored homework, for the engine's renderer registry.
 *
 * Two renderers, the same pair the study pack has:
 *   'homework'      the working document - HTML, opened on screen and printed from there
 *   'homework-pdf'  the same document printed by a headless browser, for Drive
 *
 * And the same fallback discipline. Approval delivers homework to the subject's Drive
 * folder, and that must not fail because a browser could not be started in a
 * serverless container, so the PDF falls back to the plain pdf-lib drawing. That comes
 * free here: homework is composed as a PackV2 (./render_html.ts), and the pack already
 * has a pdf-lib renderer for exactly this case.
 */
import { admin } from '@/lib/supabase';
import { printHtmlToPdf } from '@/lib/pdf/browser';
import { renderPackPdfV2 } from '@/lib/pdf/renderers/studypack_v2';
import { renderPackHtml, footerTemplate } from '@/lib/studypack/render_html';
import { homeworkPack, type HomeworkMeta } from './render_html';
import type { HomeworkContent } from '@/lib/homework';

interface Row {
  content: HomeworkContent; subject_id: string; year_group: string; week_number: number;
  subject?: { name?: string | null } | null;
}

async function load(homeworkId: string): Promise<{ row: Row; meta: HomeworkMeta }> {
  const { data } = await admin().from('homework')
    .select('content, subject_id, year_group, week_number, subject:subject_id(name)')
    .eq('id', homeworkId).single();
  if (!data) throw new Error(`No homework ${homeworkId}`);
  const row = data as unknown as Row;
  return {
    row,
    meta: {
      // The subject's name for the page furniture ("Mathematics", not "MATH"), as the
      // study pack does; falls back to the id when it cannot be resolved.
      subject: row.subject?.name ?? row.subject_id,
      yearGroup: row.year_group,
      curriculum: null,
      weekNumber: row.week_number,
    },
  };
}

export async function renderHomework(homeworkId: string): Promise<Uint8Array> {
  const { row, meta } = await load(homeworkId);
  return new TextEncoder().encode(renderPackHtml(homeworkPack(row.content, meta)));
}

export async function renderHomeworkPdf(homeworkId: string): Promise<Uint8Array> {
  const { row, meta } = await load(homeworkId);
  const pack = homeworkPack(row.content, meta);
  try {
    return await printHtmlToPdf(renderPackHtml(pack, { paged: true }), footerTemplate(pack));
  } catch (e) {
    console.error('[homework-pdf] browser print failed, falling back to pdf-lib: '
      + (e instanceof Error ? e.message : String(e)));
    return renderPackPdfV2(pack, {
      subject: meta.subject, yearGroup: meta.yearGroup, weeks: `Week ${meta.weekNumber}`,
    });
  }
}
