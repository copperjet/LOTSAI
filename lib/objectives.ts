/**
 * The objectives themselves, for the handful of year-group-and-subject pairs a
 * question is actually about.
 *
 * lib/ask.ts has always carried the curriculum registry as topic labels only -
 * "CP5 MATH week 3: Number: Counting & Sequences" - and never the objectives under
 * them. So the chat could say what a week was about and could not say what it
 * taught, which is the question teachers actually ask. The system prompt's
 * "OBJECTIVES ARE STATEMENTS, NOT CODES" section described data the model had
 * never been given.
 *
 * The reason it was never added is the size: semester 1 holds around 207KB of
 * objective text across 70 subject-and-year-group pairs, and MAX_FACT_CHARS is
 * 24,000. Carrying all of it on every question is the thing ask.ts's own comment
 * warns about - "the answer then is retrieval rather than a bigger number here".
 *
 * A single pair is small, though: 2.5KB median, 15KB at the widest. So this is the
 * retrieval, in the shape the rest of the codebase already uses - deterministic, no
 * second model call, no embeddings. Read the question, work out which pairs it is
 * about, load those. lib/schemeOfWork.ts resolves a topic number from a label with a
 * regular expression and lib/studypack/objectives.ts matches objective text with
 * trigrams; neither reaches for a model to decide something a string can decide,
 * and neither does this.
 *
 * What it will not do is guess. A question naming no year group and no subject,
 * asked by somebody who teaches nothing in the application, resolves to no pairs and
 * adds no block - and the records-are-silent answer is the right one, rather than
 * three arbitrary year groups of objectives.
 */
import type { admin } from './supabase';

/** A subject at a year group. The unit this file loads. */
export type Slice = { year_group: string; subject_id: string };

/**
 * What a question's objectives are allowed to cost.
 *
 * The same discipline as MAX_FACTS in lib/ask.ts and for the same reason: nothing
 * about a registry growing makes the bill visible at the time. Three pairs is what a
 * real question spans - a teacher comparing their two year groups, a head of
 * department looking across a stage - and three of the widest pair in the school is
 * still under 45KB. The character cap is the point at which pairs stop being the
 * right unit and a week filter becomes the next change.
 */
export const MAX_SLICES = 3;
export const MAX_OBJECTIVE_CHARS = 60_000;

/** Year groups as a teacher writes them, rather than as the registry keys them. */
const YEAR_ALIASES: Record<string, string> = {
  a2: 'A Level', 'a level': 'A Level', alevel: 'A Level',
  as: 'AS', 'as level': 'AS',
  ig1: 'IGCSE 1', igcse1: 'IGCSE 1', 'igcse 1': 'IGCSE 1',
  ig2: 'IGCSE 2', igcse2: 'IGCSE 2', 'igcse 2': 'IGCSE 2',
  // The school numbers Cambridge Primary 1-6 and Lower Secondary 1-3, so a teacher
  // saying "grade 7" or "year 7" means LS1, and "grade 5" means CP5.
  'grade 1': 'CP1', 'grade 2': 'CP2', 'grade 3': 'CP3',
  'grade 4': 'CP4', 'grade 5': 'CP5', 'grade 6': 'CP6',
  'grade 7': 'LS1', 'grade 8': 'LS2', 'grade 9': 'LS3',
  'year 1': 'CP1', 'year 2': 'CP2', 'year 3': 'CP3',
  'year 4': 'CP4', 'year 5': 'CP5', 'year 6': 'CP6',
  'year 7': 'LS1', 'year 8': 'LS2', 'year 9': 'LS3',
  nursery: 'EY1', reception: 'EY3',
};

/** Subjects written short. The full name and the id are matched from the table itself. */
const SUBJECT_ALIASES: Record<string, string> = {
  maths: 'MATH', math: 'MATH',
  pe: 'PE', games: 'PE',
  art: 'ART',
  mdd: 'MDD', music: 'MDD', dance: 'MDD', drama: 'MDD',
  gp: 'GP',
  'computer science': 'COMP', 'comp sci': 'COMP',
  literature: 'ENG', lit: 'ENG',
};

/**
 * Something shaped like a year group, whether or not the school has one.
 *
 * Used to tell "the question named a year group this registry does not hold" apart
 * from "the question named no year group at all". The two must not be treated the
 * same: the second falls back to the asker's own classes, and doing that to the
 * first answered "what does EY2 art cover" with a CP4 maths week.
 */
const YEAR_SHAPE = /\b(?:cp|ls|ey|ig)\s?\d\b|\b(?:grade|year|stage)\s?\d+\b|\bigcse\b|\ba2\b|\ba level\b|\bas level\b/;

/**
 * Words that make a question one about what is taught.
 *
 * Only consulted when the question names neither a year group nor a subject, to
 * decide whether falling back to the asker's own classes is right. "What am I
 * teaching this week" names neither and means both; "when do reports go home" names
 * neither and means neither, and used to get a teacher's whole maths curriculum
 * attached to a question about the calendar.
 */
const ABOUT_CURRICULUM = /\b(objective|objectives|teach|teaching|taught|cover|covers|covering|curriculum|topic|topics|syllabus|scheme|lesson|lessons|unit|units|learn|learning|plan|planning)\b/;

/**
 * Which year groups and subjects a question is about.
 *
 * Anything the question does not say, the asker's own classes say instead: "what am
 * I teaching this week" names neither and means both. A question naming a subject
 * but no year group, asked by somebody who teaches that subject, means their year
 * groups - which is why the two sides are filled in independently rather than as a
 * single all-or-nothing match.
 *
 * Both fallbacks are guarded, because a wrong block is worse than no block: it is a
 * page of real objectives about a class nobody asked about, sitting in the prompt
 * under a heading that says these are the objectives for the question.
 */
export function resolveSlices(
  question: string,
  vocabulary: { years: string[]; subjects: { id: string; name: string }[] },
  mine: Slice[],
  available: Slice[],
): Slice[] {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const has = (term: string) => q.includes(` ${term.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `);

  const years = new Set<string>();
  for (const y of vocabulary.years) if (has(y)) years.add(y);
  for (const [alias, y] of Object.entries(YEAR_ALIASES)) {
    if (has(alias) && vocabulary.years.includes(y)) years.add(y);
  }

  const subjects = new Set<string>();
  for (const s of vocabulary.subjects) if (has(s.name) || has(s.id)) subjects.add(s.id);
  for (const [alias, id] of Object.entries(SUBJECT_ALIASES)) {
    if (has(alias) && vocabulary.subjects.some(s => s.id === id)) subjects.add(id);
  }

  // A year group was named and it is not one this registry holds. The honest answer
  // is that the records are silent about it, so nothing is loaded and the model is
  // left to say so - rather than being handed the asker's own year group instead.
  if (!years.size && YEAR_SHAPE.test(q)) return [];

  // Something was not named, so the asker's own teaching would have to stand in for
  // it - which is only right if the question is about teaching at all. "Who is the
  // head of department for Science?" names a subject and no year group, and used to
  // attach the asker's own Science objectives to a question about a person.
  if ((!years.size || !subjects.size) && !ABOUT_CURRICULUM.test(q)) return [];

  if (!years.size) for (const m of mine) years.add(m.year_group);
  if (!subjects.size) for (const m of mine) subjects.add(m.subject_id);
  if (!years.size || !subjects.size) return [];

  // Only pairs the registry actually holds. The cross product of "CP5, CP6" and
  // "maths, French" is four pairs where the school may teach three, and asking for
  // the fourth is how a confident answer about a class nobody teaches begins.
  const real = new Set(available.map(s => `${s.year_group}|${s.subject_id}`));
  const out: Slice[] = [];
  for (const year_group of [...years].sort()) {
    for (const subject_id of [...subjects].sort()) {
      if (real.has(`${year_group}|${subject_id}`)) out.push({ year_group, subject_id });
    }
  }

  // Over the cap, the asker's own pairs are the ones to keep: a head of department
  // asking something broad gets three of them, a teacher gets their own first.
  if (out.length > MAX_SLICES) {
    const isMine = new Set(mine.map(s => `${s.year_group}|${s.subject_id}`));
    out.sort((a, b) =>
      Number(isMine.has(`${b.year_group}|${b.subject_id}`))
      - Number(isMine.has(`${a.year_group}|${a.subject_id}`)));
    return out.slice(0, MAX_SLICES);
  }
  return out;
}

type Week = {
  year_group: string; subject_id: string; week_number: number;
  topic_label: string | null; objectives: unknown; signed_off_at: string | null;
};

/**
 * The objectives for those pairs, as the block that goes in the prompt.
 *
 * Unsigned weeks are included and marked. Sign-off gates *generation* - a week
 * nobody has read is not a week to build a lesson from - but a teacher asking what
 * week 3 covers is owed the honest answer that the registry holds it and the head of
 * department has not checked it yet. That is what schoolBlock already does with its
 * topic labels, and disagreeing with it here would read as two different records.
 */
export async function objectivesBlock(
  db: ReturnType<typeof admin>,
  slices: Slice[],
  academicYear: string,
  semester: number,
): Promise<string> {
  if (!slices.length) return '';

  const { data } = await db.from('curriculum_week')
    .select('year_group, subject_id, week_number, topic_label, objectives, signed_off_at')
    .eq('academic_year', academicYear)
    .eq('semester', semester)
    .in('year_group', [...new Set(slices.map(s => s.year_group))])
    .in('subject_id', [...new Set(slices.map(s => s.subject_id))])
    .order('week_number');

  // The two `in` filters above are a rectangle and the pairs asked for are a subset
  // of it, so the corners it adds are dropped here rather than in four round trips.
  const wanted = new Set(slices.map(s => `${s.year_group}|${s.subject_id}`));
  const rows = ((data ?? []) as Week[]).filter(r => wanted.has(`${r.year_group}|${r.subject_id}`));
  if (!rows.length) return '';

  const lines: string[] = [
    '',
    'CURRICULUM OBJECTIVES. What these weeks actually teach, as the school-s own',
    'curriculum overview states it. An objective is the statement; where Cambridge gives',
    'it a code, the code is shown before the statement. These are the only objectives',
    'these records hold for the year groups and subjects the question is about - a week',
    'not listed is one the registry does not hold for this semester. Quote an objective',
    'as it is written rather than summarising it back into a topic.',
  ];

  const by = new Map<string, Week[]>();
  for (const r of rows) {
    const k = `${r.year_group} ${r.subject_id}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }

  let used = 0, shown = 0, full = false;
  for (const [pair, weeks] of [...by].sort()) {
    if (full) break;
    lines.push('', `${pair}, semester ${semester}:`);
    for (const w of weeks) {
      const objectives = (Array.isArray(w.objectives) ? w.objectives : []) as
        { ref?: string | null; text: string }[];
      lines.push(`  Week ${w.week_number}: ${w.topic_label ?? '(no topic recorded)'}`
        + `${w.signed_off_at ? '' : ' [not signed off]'}`);
      if (!objectives.length) {
        lines.push('    (the registry records no objectives for this week)');
        continue;
      }
      for (const o of objectives) {
        const line = `    - ${o.ref ? `${o.ref} ` : ''}${o.text}`;
        if (used + line.length > MAX_OBJECTIVE_CHARS) { full = true; break; }
        used += line.length; shown++;
        lines.push(line);
      }
      if (full) break;
    }
  }

  if (full) {
    lines.push('',
      `(Cut off at ${MAX_OBJECTIVE_CHARS} characters. There are more objectives in these weeks`,
      'than fitted here; say so rather than answering as though this were the whole list.)');
    console.warn(`[objectives] ${slices.map(s => `${s.year_group} ${s.subject_id}`).join(', ')} `
      + `exceeded MAX_OBJECTIVE_CHARS after ${shown} objectives. `
      + 'A week filter is the next change, not a bigger number.');
  }

  return lines.join('\n');
}
