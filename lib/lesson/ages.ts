/**
 * How old the learners are, as numbers.
 *
 * "Adapt the presentation to the learner's age" is the kind of instruction that
 * reads well in a prompt and changes nothing in the output. A model told to use
 * "simpler language for younger learners" writes the same slide it was going to
 * write. So the age band is a table, and the numbers in it are used in three
 * places from this one definition:
 *
 *   1. They narrow the JSON schema the model answers into (fewer blocks per
 *      slide for an eight-year-old than for an A-Level class).
 *   2. They enter the cached prompt prefix as explicit counts.
 *   3. They are the thresholds the quality gate measures the finished deck
 *      against (lib/lesson/gate.ts).
 *
 * That third one is what makes it real. A deck that ignores the caps does not
 * pass, and the caps came from the same place the prompt did, so the model is
 * never marked against a rule it was not told.
 *
 * The year-group patterns are the school's own, from the CURRICULUM OVERVIEWS
 * folders: EYD, CP1-CP4, CP5-CP6, LS1-LS3, then IGCSE and A Level.
 */

export type AgeBandId = 'early' | 'primary' | 'lower_sec' | 'upper_sec' | 'advanced';

export interface AgeBand {
  id: AgeBandId;
  name: string;
  /** Matched against the class's year_group. */
  years: RegExp;
  /** Every word a learner reads on one slide, title included. */
  maxWordsPerSlide: number;
  /** One idea per slide is the rule; older learners can hold two related ones. */
  maxBlocksPerSlide: number;
  /** Bullets, options, steps, table rows - anything a block lists. */
  maxItemsPerBlock: number;
  /** Mean sentence length the gate holds the prose to. */
  maxSentenceWords: number;
  /** A slide's share of the lesson, used to size the deck against the duration. */
  minutesPerSlide: [number, number];
  /**
   * At most this many teacher-led slides may pass before a student-facing one.
   * Younger learners cannot watch for long; older ones can follow a longer
   * explanation before they need to do something with it.
   */
  interactionEvery: number;
  /** One line, in the cached prefix. Written for the model, not for us. */
  note: string;
}

/**
 * Ordered most specific first. A year group matching nothing lands on
 * lower secondary, which is the middle of the school and the least wrong guess.
 */
export const AGE_BANDS: AgeBand[] = [
  {
    id: 'early', name: 'Early Years',
    years: /^\s*(EYD|EY|nursery|reception|pre[-\s]?school)/i,
    maxWordsPerSlide: 25, maxBlocksPerSlide: 1, maxItemsPerBlock: 3,
    maxSentenceWords: 10, minutesPerSlide: [2, 4], interactionEvery: 1,
    note: 'These are four to six year olds who are still learning to read. A slide carries a '
      + 'picture and at most one short sentence, read aloud by the teacher. Every second slide '
      + 'asks them to do, say or point at something.',
  },
  {
    id: 'primary', name: 'Lower Primary',
    years: /^\s*CP\s*[1-4]\b/i,
    maxWordsPerSlide: 45, maxBlocksPerSlide: 1, maxItemsPerBlock: 4,
    maxSentenceWords: 12, minutesPerSlide: [3, 6], interactionEvery: 2,
    note: 'These are seven to ten year olds. One idea per slide, in short sentences of about ten '
      + 'words. Prefer a picture or a diagram to a paragraph. They lose attention after two '
      + 'slides of listening, so ask them something on the third.',
  },
  {
    id: 'lower_sec', name: 'Upper Primary and Lower Secondary',
    years: /^\s*(CP\s*[56]|LS\s*[12])\b/i,
    maxWordsPerSlide: 70, maxBlocksPerSlide: 2, maxItemsPerBlock: 5,
    maxSentenceWords: 16, minutesPerSlide: [4, 7], interactionEvery: 3,
    note: 'These are eleven to thirteen year olds. They can follow a worked example and a short '
      + 'explanation. Keep a slide to one idea with at most two parts, and give them something '
      + 'to work out at least every third slide.',
  },
  {
    id: 'upper_sec', name: 'Upper Secondary',
    years: /^\s*(LS\s*3|IGCSE\s*1|IGCSE\s*2|Y(ear)?\s*(9|10|11))\b/i,
    maxWordsPerSlide: 100, maxBlocksPerSlide: 2, maxItemsPerBlock: 6,
    maxSentenceWords: 20, minutesPerSlide: [5, 9], interactionEvery: 3,
    note: 'These are fourteen to sixteen year olds working towards an IGCSE. They can hold a '
      + 'longer explanation and a more detailed diagram, and they need exam-style application '
      + 'questions rather than recall alone. Do not write them a primary slide.',
  },
  {
    id: 'advanced', name: 'A Level',
    years: /^\s*(A\s*(S)?\s*Level|AS|A2|Y(ear)?\s*(12|13)|Sixth)\b/i,
    maxWordsPerSlide: 130, maxBlocksPerSlide: 2, maxItemsPerBlock: 7,
    maxSentenceWords: 26, minutesPerSlide: [6, 12], interactionEvery: 4,
    note: 'These are A Level students. Information density is appropriate where the content '
      + 'demands it: full notation, a real dataset, a multi-step derivation, a case study with '
      + 'competing explanations. Questions should require evaluation, not recall.',
  },
];

export const DEFAULT_BAND = AGE_BANDS[2];   // lower secondary - the middle of the school

export function bandFor(yearGroup: string | null | undefined): AgeBand {
  const y = String(yearGroup ?? '').trim();
  if (!y) return DEFAULT_BAND;
  return AGE_BANDS.find(b => b.years.test(y)) ?? DEFAULT_BAND;
}

export function bandById(id: string | null | undefined): AgeBand {
  return AGE_BANDS.find(b => b.id === id) ?? DEFAULT_BAND;
}

/** The caps, as the lines that go into the cached prompt prefix. */
export function bandBlock(band: AgeBand): string {
  return [
    `LEARNERS - ${band.name}`,
    band.note,
    `Hard limits for this age: at most ${band.maxWordsPerSlide} words of learner-facing text on a `
      + `slide (the title counts), at most ${band.maxBlocksPerSlide} block(s) per slide, at most `
      + `${band.maxItemsPerBlock} items in any list, and sentences of about `
      + `${band.maxSentenceWords} words or fewer.`,
    `A slide that goes over these is cut down before the teacher sees it, so write to them.`,
  ].join('\n');
}
