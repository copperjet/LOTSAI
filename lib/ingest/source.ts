/**
 * What every source of pack material has in common, whatever door it came through.
 *
 * A pasted block of notes and an uploaded worksheet are the same thing by the time
 * they reach /api/studypack/from-upload: text, reconciled against the registry, stored
 * on source_upload. These are the pieces both doors share, so the rules cannot drift
 * apart between them.
 */

/** Enough for a whole study pack's worth of source material, not a textbook. */
export const MAX_STORED_TEXT = 200_000;

/**
 * Strip what cannot be stored.
 *
 * PDF extraction brings control characters out along with the words, a NUL among them,
 * and Postgres rejects those inside jsonb ("unsupported Unicode escape sequence"): the
 * upload failed to store and the route answered with a null id. Tab, newline and
 * carriage return stay - they are the shape of the text. Nothing else does.
 */
export function cleanText(raw: string): string {
  let out = '';
  for (const ch of String(raw ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || code >= 32) out += ch;
  }
  return out;
}

/**
 * Say plainly what the source claims and how much of it the curriculum recognises.
 *
 * `from` names the material in the words the teacher would use for it - "this file",
 * "these 3 files", "this text" - because the sentence is read by a person deciding
 * whether to go ahead.
 */
export function sourceNote(o: {
  from: string; refsFound: number; unresolved: number; subjectId: string; yearGroup: string;
}): string {
  if (!o.refsFound) {
    // Not a dead end: from-upload reads the outcomes the material states and matches
    // them against the registry by text.
    return `No objective codes were found in ${o.from}. I can still build a pack from it by reading the outcomes it states, and I will show you which ones are not in the ${o.yearGroup} ${o.subjectId} curriculum.`;
  }
  if (o.unresolved) {
    return `${o.unresolved} objective(s) in ${o.from} are not in the ${o.yearGroup} ${o.subjectId} curriculum. They will not be used until someone confirms them.`;
  }
  return `Every objective in ${o.from} is in the curriculum.`;
}
