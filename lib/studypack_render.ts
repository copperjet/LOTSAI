/**
 * Render a stored study pack to its HTML bytes, for the engine's renderer
 * registry. Reads the study_pack row and hands its content to the right template.
 * Returns bytes (like every renderer) so storeArtefact can upload it — with a
 * text/html content type rather than a PDF's.
 *
 * Two content versions live in the bank at once. v1 packs (units → topics → quiz)
 * keep the tabbed Build Kit template they were written for; v2 packs are block
 * documents and go to the paged renderer. Branching here rather than migrating the
 * stored content means an approved pack from before this change opens unchanged.
 */
import { admin } from './supabase';
import type { PackContent } from './studypack';
import { renderStudyPackHtml } from './studypack_html';
import { renderPackHtml } from './studypack/render_html';
import type { PackV2 } from './studypack/schema';
import { loadAssets } from './studypack/assets';

export async function renderStudyPack(studyPackId: string): Promise<Uint8Array> {
  const db = admin();
  const { data: pack } = await db.from('study_pack')
    .select('content, subject_id, year_group, week_from, week_to').eq('id', studyPackId).single();
  if (!pack) throw new Error(`No study pack ${studyPackId}`);

  const content = pack.content as Partial<PackV2>;
  // The pack's own pictures, inlined. A pack with none pays one query for an empty
  // object; a pack with some has to carry them in the document, because the print has
  // no session to fetch them with (lib/studypack/assets.ts).
  const assets = Number(content?.version) === 2 ? await loadAssets(studyPackId) : {};
  const html = Number(content?.version) === 2
    ? renderPackHtml(content as PackV2, { assets })
    : renderStudyPackHtml(pack.content as PackContent, {
        subject: pack.subject_id, yearGroup: pack.year_group,
        weekFrom: pack.week_from, weekTo: pack.week_to,
      });
  return new TextEncoder().encode(html);
}
