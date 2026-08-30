/**
 * Reconcile an uploaded document against the registry.
 *
 * The founding rule of this system is that objectives are retrieved, never
 * generated (main spec §4). An uploaded file — a worksheet a teacher wants turned
 * into a study pack, say — carries objective codes that may be last year's,
 * another school's, or simply wrong. So every reference it names is matched
 * against curriculum_week for the stated subject and year group, and whatever does
 * not resolve is returned marked, for a human, never accepted as truth.
 *
 * This is the guard the Phase-2 "turn this PDF into X" path is built on. It uses
 * the same Cambridge reference pattern the ingest does, so the two agree on what a
 * reference even looks like.
 */
import { admin } from '@/lib/supabase';

// Identical to REF in scripts/ingest_overviews.py — one or two capitals for the
// strand (English Speaking & Listening uses two: 4SLp, 4SLm …).
export const REF = /\b(\d{1,2}[A-Z]{1,2}[a-z]{0,2}\.\d{2})\b/g;

export interface Reconciliation {
  refsFound: string[];
  resolved: { ref: string; text: string; week_number: number }[];
  unresolved: string[];   // ref-shaped, but not in this subject/year's registry
}

export function extractRefs(text: string): string[] {
  return [...new Set(text.match(REF) ?? [])].sort();
}

/**
 * Match found references against the registry for one subject/year group. A ref
 * that is not signed-off-or-not is still "resolved" if the registry holds it —
 * reconciliation is about provenance (does the school's own curriculum contain
 * this objective?), which is separate from whether that week is plannable yet.
 */
export async function reconcile(text: string, subjectId: string, yearGroup: string): Promise<Reconciliation> {
  const refsFound = extractRefs(text);
  if (!refsFound.length) return { refsFound, resolved: [], unresolved: [] };

  const db = admin();
  const { data: weeks } = await db.from('curriculum_week')
    .select('week_number, objectives')
    .eq('subject_id', subjectId).eq('year_group', yearGroup).eq('academic_year', '2026-27');

  // Build ref → {text, week} from the registry the school actually holds.
  const known = new Map<string, { text: string; week_number: number }>();
  for (const w of weeks ?? []) {
    for (const o of (w.objectives as { ref: string | null; text: string }[]) ?? []) {
      if (o.ref && !known.has(o.ref)) known.set(o.ref, { text: o.text, week_number: w.week_number });
    }
  }

  const resolved: Reconciliation['resolved'] = [];
  const unresolved: string[] = [];
  for (const ref of refsFound) {
    const hit = known.get(ref);
    if (hit) resolved.push({ ref, text: hit.text, week_number: hit.week_number });
    else unresolved.push(ref);
  }
  return { refsFound, resolved, unresolved };
}
