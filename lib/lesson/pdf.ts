/**
 * The deck, printed.
 *
 * One page per slide at 254mm by 143mm, which is what the document's own @page
 * rule asks for - so this is a thin wrapper over the browser print and the
 * design lives entirely in lib/lesson/render_html.ts, as the study pack's does.
 *
 * NO PAGINATION. A study pack has to be measured and split because its pages
 * hold the teacher's own text and nobody knows how tall it is until it is laid
 * out. A slide is a fixed box: what does not fit was cut by the caps in
 * lib/lesson/repair.ts long before it got here. So this does not define
 * `window.__packPaginate`, and lib/pdf/browser.ts already guards for its absence.
 *
 * NO FALLBACK. The study pack keeps a pdf-lib renderer for the day Chromium will
 * not start, because a pack is the artefact. A lesson's artefact is the
 * PowerPoint, which needs no browser at all - so when the print fails the
 * teacher still has the thing they came for, and redrawing the whole slide
 * design a second time in pdf-lib would buy a worse copy of a file they already
 * have. The failure is recorded on the row and shown in /admin/health.
 */
import { printHtmlToPdf } from '@/lib/pdf/browser';
import { loadAssets } from './assets';
import { readLesson, saveDeck } from './persist';
import { renderDeckHtml } from './render_html';

export async function renderLessonPdf(lessonId: string): Promise<Uint8Array> {
  const row = await readLesson(lessonId);
  if (!row?.content) throw new Error('lesson not found');

  const assets = await loadAssets(lessonId);
  // The notes are a screen affordance. What prints is what the class sees.
  const html = renderDeckHtml(row.content, { assets, notesOpen: false });

  try {
    // No running footer: each slide carries its own, and Chrome's would be
    // stamped into the slide rather than into a margin there is none of.
    return await printHtmlToPdf(html, null);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await saveDeck(lessonId, {
      ...row.content,
      render_note: `The PDF could not be printed: ${why}. The PowerPoint is unaffected.`,
    }).catch(() => { /* the render already failed; do not compound it */ });
    throw e;
  }
}
