/**
 * Print a study pack to PDF with a headless browser.
 *
 * The pack's HTML is the print master: it carries @page sizing, sheet breaks, ruled
 * answer space and an answer key, and "GP LS3 Study Pack Formative 4.pdf" was itself
 * made by printing a page like it from Chrome. Redrawing all of that a second time in
 * pdf-lib would be a second layout engine to keep in step with the first, so the
 * browser does it instead (lib/pdf/browser.ts) and there is exactly one design.
 *
 * The pdf-lib renderer (./studypack.ts, registered as 'studypack-pdf-basic') stays as
 * the fallback. Approval delivers a pack to Google Drive, and that must not fail
 * because a browser could not be started in a serverless container - a plainer PDF is
 * a far better outcome than none.
 */
import { admin } from '@/lib/supabase';
import { renderPackHtml, footerTemplate } from '@/lib/studypack/render_html';
import { renderStudyPackHtml } from '@/lib/studypack_html';
import { printHtmlToPdf } from '@/lib/pdf/browser';
import { renderStudyPackPdf } from './studypack';
import type { PackV2 } from '@/lib/studypack/schema';
import type { PackContent } from '@/lib/studypack';

export async function renderStudyPackPrint(studyPackId: string): Promise<Uint8Array> {
  const db = admin();
  const { data: pack } = await db.from('study_pack')
    .select('content, subject_id, year_group, week_from, week_to').eq('id', studyPackId).single();
  if (!pack) throw new Error(`No study pack ${studyPackId}`);

  const content = pack.content as Partial<PackV2>;
  const v2 = Number(content?.version) === 2;
  const html = v2
    ? renderPackHtml(content as PackV2, { paged: true })
    : renderStudyPackHtml(pack.content as PackContent, {
        subject: pack.subject_id, yearGroup: pack.year_group,
        weekFrom: pack.week_from, weekTo: pack.week_to,
      });

  try {
    const bytes = await printHtmlToPdf(html, v2 ? footerTemplate(content as PackV2) : null);
    await note(studyPackId, null);
    return bytes;
  } catch (e) {
    // Loud, then fall back: a pack with a plain PDF is usable; a pack with none is not.
    const why = e instanceof Error ? e.message : String(e);
    console.error(`[studypack-pdf] browser print failed, falling back to pdf-lib: ${why}`);
    await note(studyPackId, why);
    return renderStudyPackPdf(studyPackId);
  }
}

/**
 * Record that this pack's PDF is the plain one, and why.
 *
 * Without it a degraded render is indistinguishable from a good one: storeArtefact
 * writes the bytes and reports success either way, so nobody knew the browser had been
 * failing in production at all - the first sign was a teacher opening a PDF that had
 * nothing in it. /api/studypack/pdf hands this back so the UI can say which PDF it is,
 * and /admin/health has the message to act on.
 *
 * Never fatal, and tolerant of the column not being there: migrations are applied by
 * hand here, and a PDF must not fail to render because a note could not be filed.
 */
async function note(studyPackId: string, why: string | null): Promise<void> {
  try {
    await admin().from('study_pack').update({ render_note: why }).eq('id', studyPackId);
  } catch { /* pre-0015, or a transient write: the PDF is what matters */ }
}
