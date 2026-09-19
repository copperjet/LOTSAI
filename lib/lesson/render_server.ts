/**
 * The deck renderer, with the database attached.
 *
 * lib/lesson/render_html.ts is pure on purpose: the editor imports it into the
 * browser so its canvas and the exported artefact are drawn by the same code.
 * That means it cannot load anything, and this is the four lines that do.
 */
import { loadAssets } from './assets';
import { readLesson } from './persist';
import { renderDeckHtml } from './render_html';

/** Registered as the `lesson` renderer (lib/workflows/registry.ts). */
export async function renderLessonHtml(lessonId: string): Promise<Uint8Array> {
  const row = await readLesson(lessonId);
  if (!row?.content) throw new Error('lesson not found');
  const assets = await loadAssets(lessonId);
  return new TextEncoder().encode(renderDeckHtml(row.content, { assets }));
}
