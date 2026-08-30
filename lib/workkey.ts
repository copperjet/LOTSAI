/**
 * The work key (Addendum B section B3).
 *
 * Because objectives are retrieved from the registry rather than written by a
 * model, their syllabus references are a controlled vocabulary — which makes
 * this index exact, free, and usable offline. No embeddings, no vector store.
 */

export interface KeyParts {
  artefactType: string;
  subjectId: string;
  yearGroup: string;
  academicYear: string;
  weekNumber: number;
  refs: string[];
}

export function workKey(p: KeyParts): string {
  const refs = [...p.refs].sort().join(',');
  return [p.artefactType, p.subjectId, p.yearGroup, p.academicYear, `W${p.weekNumber}`, refs || 'no-refs']
    .join('|');
}

export type MatchTier = 1 | 2 | 3 | 4 | 5;

export const TIER_MEANING: Record<MatchTier, { mode: 'reuse' | 'adapt'; why: string }> = {
  1: { mode: 'reuse', why: 'Exact match - same objectives, same week, approved' },
  2: { mode: 'reuse', why: 'Same objectives, taught in a different week' },
  3: { mode: 'adapt', why: 'Same week last academic year' },
  4: { mode: 'adapt', why: 'Most of the same objectives' },
  5: { mode: 'adapt', why: 'Same topic, different objectives - reference only' },
};

/** Jaccard over syllabus references. Tier 4 needs 60%. */
export function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let shared = 0;
  for (const r of A) if (B.has(r)) shared++;
  return shared / (A.size + B.size - shared);
}
