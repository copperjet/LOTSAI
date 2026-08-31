/**
 * Objectives for a pack built from a file rather than from the registry.
 *
 * `lib/ingest/reconcile.ts` resolves objective *codes* - "9E.01" - against
 * curriculum_week. That is the right guard and it stays first. But the school's own
 * documents often carry no codes at all: "ART LS1 STUDY PACK S1 2026-2027.pdf"
 * opens with "By the end of this lesson: P.S.B.A. to: Explain and define the terms
 * below" and never names a syllabus reference. Refusing to build from it (the old
 * 409 nothing_resolved) made the whole "turn this file into a pack" path unusable
 * for exactly the documents teachers actually have.
 *
 * So a second, weaker door: read the outcomes the file states, and try to match them
 * to registry objectives *by text*. A match keeps the registry's wording and its
 * code - the file's phrasing is never promoted to curriculum. Anything that does not
 * match is carried verbatim, marked source 'file', and flagged by the gate for a
 * human to confirm. Nothing here writes curriculum, and no code is ever invented.
 *
 * The matcher is deterministic (trigram Dice) rather than a model call: an objective
 * mapping that changes between two runs of the same file is worse than one that is
 * merely approximate, and this way it is free.
 */
import { call } from '@/lib/llm';
import { admin } from '@/lib/supabase';
import type { PackObjective } from './schema';

/** Below this, a text match is not worth asserting - carry the file's wording instead. */
export const MATCH_THRESHOLD = 0.55;

const SYSTEM = `You read a teacher's document and list the learning outcomes it states.

Copy each outcome verbatim, as a single line. Do not summarise, reword, number or explain
them. Do not invent outcomes the document does not state, and never write a syllabus code
that is not already in the text.

Outcomes usually follow a phrase like "By the end of this lesson", "Learners will be able
to", "Objectives", or appear as the document's own list of topics to be covered. List the
outcomes themselves, never the line that introduces them. If the document states none,
return an empty list.

Never use an em dash or an en dash. Use a plain hyphen.`;

const OUTCOME_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcomes'],
  properties: { outcomes: { type: 'array', items: { type: 'string' } } },
} as const;

/**
 * The outcome lines a document states, verbatim. Small tier: this is extraction,
 * not authorship, and it is metered like every other call (lib/llm.ts).
 */
export async function extractStatedOutcomes(text: string, userId: string): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const { data } = await call<{ outcomes: string[] }>({
    tier: 'small',
    workflow: 'studypack_outcomes',
    userId,
    system: SYSTEM,
    // The document is the volatile part - one file, read once - so it is the prompt,
    // not a cached block.
    prompt: `Document:\n\n${trimmed.slice(0, 60_000)}\n\nList the learning outcomes it states.`,
    schema: OUTCOME_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2000,
  });
  return (data?.outcomes ?? [])
    .map(o => String(o ?? '').trim())
    // "By the end of this lesson: P.S.B.A. to:" is the stem the outcomes hang off,
    // not an outcome, and the ART LS1 pack led with exactly that. A line that ends in
    // a colon is introducing the list rather than being in it.
    .filter(o => o.length > 12 && !o.endsWith(':'))
    .slice(0, 40);
}

/** Words that carry no signal in an objective and skew a short-string match. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'from',
  'be', 'is', 'are', 'as', 'at', 'it', 'that', 'this', 'their', 'them', 'they',
  'will', 'can', 'able', 'should', 'learners', 'learner', 'students', 'student',
  'pupils', 'end', 'lesson', 'objective', 'objectives',
]);

function normalise(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOP.has(w))
    .join(' ');
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams: robust to word order and inflection. */
export function similarity(a: string, b: string): number {
  const A = trigrams(normalise(a)), B = trigrams(normalise(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

export interface RegistryObjective { ref: string | null; text: string; week_number: number }

/** Every objective the registry holds for one subject and year, flattened. */
export async function registryObjectives(
  subjectId: string, yearGroup: string, academicYear = '2026-27',
): Promise<RegistryObjective[]> {
  const { data } = await admin().from('curriculum_week')
    .select('week_number, objectives')
    .eq('subject_id', subjectId).eq('year_group', yearGroup).eq('academic_year', academicYear)
    .order('week_number');

  const out: RegistryObjective[] = [];
  const seen = new Set<string>();
  for (const w of data ?? []) {
    for (const o of (w.objectives as { ref: string | null; text: string }[]) ?? []) {
      const key = `${o.ref ?? ''}|${o.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: o.ref ?? null, text: o.text, week_number: w.week_number });
    }
  }
  return out;
}

/**
 * Map stated outcomes onto the registry.
 *
 * A match above the threshold yields the *registry's* wording and code; below it,
 * the file's own wording with a null ref and source 'file'. Duplicate matches onto
 * the same registry objective collapse, so a document that restates an outcome three
 * times does not triple it in the pack.
 */
export async function matchToRegistry(
  outcomes: string[], subjectId: string, yearGroup: string,
): Promise<PackObjective[]> {
  if (!outcomes.length) return [];
  const registry = await registryObjectives(subjectId, yearGroup);

  const out: PackObjective[] = [];
  const takenRefs = new Set<string>();
  const takenText = new Set<string>();

  for (const outcome of outcomes) {
    let best: RegistryObjective | null = null;
    let bestScore = 0;
    for (const cand of registry) {
      const s = similarity(outcome, cand.text);
      if (s > bestScore) { bestScore = s; best = cand; }
    }

    if (best && bestScore >= MATCH_THRESHOLD) {
      const key = best.ref ?? best.text;
      if (takenRefs.has(key)) continue;
      takenRefs.add(key);
      out.push({ ref: best.ref, text: best.text, source: 'matched', score: Number(bestScore.toFixed(3)) });
      continue;
    }

    const key = normalise(outcome);
    if (!key || takenText.has(key)) continue;
    takenText.add(key);
    out.push({ ref: null, text: outcome, source: 'file' });
  }
  return out;
}

/** Registry objectives already resolved by code, in the shape the pack carries. */
export function fromRegistry(objectives: { ref: string | null; text: string }[]): PackObjective[] {
  return objectives.map(o => ({ ref: o.ref ?? null, text: o.text, source: 'registry' as const }));
}

/** Counts for the response and the gate: how much of this pack rests on the registry. */
export function sourceCounts(objectives: PackObjective[]) {
  return {
    registry: objectives.filter(o => o.source === 'registry').length,
    matched: objectives.filter(o => o.source === 'matched').length,
    file: objectives.filter(o => o.source === 'file').length,
  };
}
