/**
 * Render a stored study pack to its HTML bytes, for the engine's renderer
 * registry. Reads the study_pack row and hands its content to the Build Kit
 * template. Returns bytes (like every renderer) so storeArtefact can upload it —
 * with a text/html content type rather than a PDF's.
 */
import { admin } from './supabase';
import type { PackContent } from './studypack';
import { renderStudyPackHtml } from './studypack_html';

export async function renderStudyPack(studyPackId: string): Promise<Uint8Array> {
  const db = admin();
  const { data: pack } = await db.from('study_pack')
    .select('content, subject_id, year_group, week_from, week_to').eq('id', studyPackId).single();
  if (!pack) throw new Error(`No study pack ${studyPackId}`);

  const html = renderStudyPackHtml(pack.content as PackContent, {
    subject: pack.subject_id, yearGroup: pack.year_group,
    weekFrom: pack.week_from, weekTo: pack.week_to,
  });
  return new TextEncoder().encode(html);
}
