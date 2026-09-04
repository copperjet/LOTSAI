/**
 * Telling a new school fact from one the school already holds.
 *
 * `school_fact` is read into the cached grounding prefix on every question anybody
 * asks (lib/ask.ts). Two copies of the marking policy in that block is worse than
 * none: the model has to choose between them, nobody knows which it chose, and the
 * copies drift the moment one of them is updated. So a duplicate has to be caught
 * before it is written, and the person writing it has to be the one who decides.
 *
 * Deterministic on purpose. The live set is tens of rows - the whole design of this
 * table depends on it staying that way - so comparing a candidate against all of them
 * is a loop over an array, not an index, an embedding or a similarity search. When it
 * reaches the hundreds, that is the moment to reconsider, and the moment the caps in
 * lib/ask.ts will make impossible to miss.
 */

export interface Fact { id: string; topic: string; body: string }
export interface Candidate { topic: string; body: string }

export type DuplicateReason = 'same' | 'topic' | 'near';

export interface Duplicate {
  id: string;
  topic: string;
  body: string;
  reason: DuplicateReason;
  /** 0 to 1, over the body. Shown as a percentage; used for ordering. */
  score: number;
}

/**
 * The thresholds, in one place, because the cost of each one being wrong is not
 * symmetrical.
 *
 * Too low and an administrator clicks past a warning that was not a duplicate: one
 * click, once. Too high and a second copy of a policy reaches the prefix, where it is
 * invisible and stays wrong until somebody notices the model hedging. So these are set
 * to over-report, and every one of them is a question rather than a decision.
 */
const SAME_BODY = 0.95;      // the same words under the same topic: it is already saved
const NEAR_BODY = 0.55;      // reworded, but recognisably the same policy
const NEAR_TOPIC = 0.8;      // "Marking" against "Marking policy"
const NEAR_TOPIC_BODY = 0.35;

/** Words that carry no meaning for this comparison, so two policies are not judged
 *  similar for sharing "the", "of" and "must". */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'must', 'not', 'of', 'on', 'or', 'that', 'the', 'their', 'them',
  'they', 'this', 'to', 'was', 'were', 'which', 'will', 'with', 'you', 'your',
]);

/**
 * A topic reduced to what it is actually about.
 *
 * "Marking policy", "marking policy." and "Marking  Policy" are one topic written
 * three ways, and a school handbook read twice will produce all three.
 */
export function normaliseTopic(topic: string): string {
  return String(topic ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 2 && !STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

/**
 * How much two pieces of text say the same thing, 0 to 1.
 *
 * Jaccard over the words that carry meaning. It does not understand paraphrase, and
 * it is not asked to: the case this exists for is the same document read twice and the
 * same policy retyped, both of which share most of their words.
 */
export function similarity(a: string, b: string): number {
  const left = tokens(a), right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Existing facts that this candidate may already be, best match first.
 *
 * At most two: a third is noise on a card somebody is reading in order to make one
 * decision. `same` and `topic` always outrank `near`, because they are the two cases
 * where an administrator is almost certainly looking at a re-import rather than at a
 * new fact.
 */
export function findDuplicates(candidate: Candidate, live: Fact[]): Duplicate[] {
  const topic = normaliseTopic(candidate.topic);
  const found: Duplicate[] = [];

  for (const fact of live ?? []) {
    const sameTopic = normaliseTopic(fact.topic) === topic;
    const bodyScore = similarity(candidate.body, fact.body);
    const topicScore = similarity(candidate.topic, fact.topic);

    let reason: DuplicateReason | null = null;
    if (sameTopic && bodyScore >= SAME_BODY) reason = 'same';
    else if (sameTopic) reason = 'topic';
    else if (bodyScore >= NEAR_BODY) reason = 'near';
    else if (topicScore >= NEAR_TOPIC && bodyScore >= NEAR_TOPIC_BODY) reason = 'near';

    if (reason) found.push({ id: fact.id, topic: fact.topic, body: fact.body, reason, score: bodyScore });
  }

  const rank: Record<DuplicateReason, number> = { same: 0, topic: 1, near: 2 };
  return found
    .sort((a, b) => rank[a.reason] - rank[b.reason] || b.score - a.score)
    .slice(0, 2);
}

/** What the page says about a match, so the route and the page cannot disagree. */
export const DUPLICATE_SAYS: Record<DuplicateReason, string> = {
  same: 'This is already saved, word for word.',
  topic: 'There is already a fact under this topic.',
  near: 'This looks like a reworded version of a fact already saved.',
};
