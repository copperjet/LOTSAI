/**
 * Writing a pack to the bank, and describing one back to the caller.
 *
 * Migrations here are applied by hand in the Supabase SQL editor, so a deployment
 * routinely runs code that is one migration ahead of its database (see
 * CONTINUE_HERE.md). Every other route degrades cleanly in that gap; this one has to
 * as well, because 0014's columns are the ones v2 wants. So the insert is tried with
 * the v2 columns and retried without them if the database has not got them yet: the
 * pack is stored either way, and the v2 content in `content` is self-describing
 * (it carries its own `version`), which is what the renderers actually branch on.
 */
import { admin } from '@/lib/supabase';
import type { PackObjective, PackV2 } from './schema';

export interface PackRow {
  work_key: string; academic_year: string; year_group: string; subject_id: string;
  class_id: string | null; week_from: number; week_to: number; title: string;
  objective_refs: string[]; content: PackV2; author_id: string; status: string;
}

export interface PackV2Columns {
  content_version: 2;
  layout: PackV2['layout'];
  source_kind: 'registry' | 'document';
  objective_sources: PackObjective[];
}

/** Insert a pack, falling back to the pre-0014 column set. */
export async function insertPack(row: PackRow, v2: PackV2Columns): Promise<{ id: string } | null> {
  const db = admin();
  const full = await db.from('study_pack').insert({ ...row, ...v2 }).select('id').single();
  if (!full.error) return full.data;

  // 0014 has not been applied here yet. PostgREST answers PGRST204 ("Could not find
  // the 'content_version' column ... in the schema cache") before the statement ever
  // reaches Postgres; 42703 is what Postgres itself says if it does.
  const missingColumn = full.error.code === 'PGRST204' || full.error.code === '42703'
    || /could not find the '.*' column|column .* does not exist/i.test(full.error.message);
  if (!missingColumn) {
    console.error(`[studypack] insert failed: ${full.error.message}`);
    return null;
  }
  console.warn('[studypack] study_pack is missing the 0014 columns; storing without them.');
  const bare = await db.from('study_pack').insert(row).select('id').single();
  if (bare.error) {
    console.error(`[studypack] insert failed: ${bare.error.message}`);
    return null;
  }
  return bare.data;
}

/** The shape every study pack route returns to the UI. */
export function packSummary(content: PackV2) {
  return {
    title: content.title,
    subtitle: content.subtitle,
    layout: content.layout,
    pages: content.pages.map(p => ({ title: p.title, blocks: p.blocks.length })),
    // Kept for the existing PackCard, which counts units and topics.
    units: content.pages
      .filter(p => p.objective_indexes.length)
      .map(p => ({ label: p.title, topics: p.blocks.length })),
    refs: content.objective_refs,
    glossary: content.pages.flatMap(p => p.blocks)
      .filter(b => b.type === 'glossary')
      .reduce((n, b) => n + (b.type === 'glossary' ? b.terms.length : 0), 0),
  };
}
