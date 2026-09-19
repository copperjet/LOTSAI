/**
 * Answer a question about the school.
 *
 * LOTS AI is not a general assistant (main spec section 1), but it is described
 * there as "grounded in the school's own curriculum, calendar, formats and
 * teaching history" - and a question the school's own calendar answers is not
 * open-ended work. "When does school open?" used to return the boundary card,
 * which was the router having no answer rather than the product having a limit.
 *
 * So the reply is classified rather than refused:
 *
 *   records     the school's own data answers it. Everything specific to Lusaka
 *               Oaktree must come from the block below and nowhere else.
 *   general     the records do not hold it, but it is a real question with a
 *               useful answer - what a Cambridge code means, how a recap is
 *               usually structured. The UI marks these as not from the school's
 *               records, because a teacher has to be able to tell the school's
 *               own answer from a general one.
 *   open_ended  a request to MAKE something - writing, brainstorming, research, and
 *               anything the workflows build. Two failures came out of this one being
 *               drawn too narrowly: asked to "create a homework", the model classified
 *               it as `records`, wrote the entire paper into the chat as prose, and
 *               presented it with no "not from the school's records" note, as though a
 *               homework were something the calendar held. Told next to "put it on a
 *               document", the router had no homework workflow to reach and answered
 *               with the boundary card - refusing the one half of the exchange this
 *               product exists for.
 *
 *               Both are fixed at once: app/page.tsx routes a request to make
 *               teaching material to the workflow that builds it (lib/homework.ts is
 *               the newest), and anything that still arrives here is classified by
 *               what is being asked for rather than by whether the records could
 *               ground it. Still the boundary: main spec section 1's four tests, and
 *               Addendum D section D5.1 on expectation creep.
 *
 * The grounding comes from the tables /api/calendar already reads, plus the two
 * that say who works here - app_user and subject.department - at the scale
 * app/api/search/route.ts already reasons about: one academic year is tens of
 * weeks and a handful of classes, so it is assembled in memory rather than
 * indexed. That is the thing to change first when the registry holds every
 * stage - the shape here stays, the source becomes a query.
 *
 * Staff are read from app_user rather than kept as a written-down list of facts,
 * so "who is the HOD for Science?" answers from the same row /admin/people edits
 * and cannot drift from it. What the block carries is deliberately narrow - name,
 * role, department. Everything else app_user holds is administration data, and
 * this block is in the prompt for every teacher who asks anything.
 *
 * school_fact is the other half of that rule: it holds only what no table holds -
 * the uniform policy, the safeguarding lead, how work is marked. A fact with a home
 * is read from its home, and /api/school-fact refuses to write the ones that have
 * one. The whole set is tens of rows, so it joins the cached prefix like everything
 * else here rather than being retrieved from.
 */
import { admin } from './supabase';
import { call } from './llm';
import { ROLE_SAYS } from './admin';
import { normaliseTopic } from './knowledge';
import { objectivesBlock, resolveSlices, type Slice } from './objectives';
import { classesFor, teachersByClass } from './classes';

/**
 * What the school's own facts are allowed to cost.
 *
 * Every one of them is in the prompt for every question anybody asks, cached prefix or
 * not, and nothing about adding one makes that visible at the time. These are the point
 * at which the design stops being the right one: a set this size is no longer something
 * to carry whole, and the answer then is retrieval rather than a bigger number here. The
 * caps exist so that day arrives as a warning in the log and a line on /admin/knowledge
 * rather than as a bill.
 */
export const MAX_FACTS = 120;
export const MAX_FACT_CHARS = 24_000;

export type AnswerKind = 'records' | 'general' | 'open_ended';

/**
 * One item of a structured answer: what it is about, and what about it.
 *
 * A question like "what do weeks 1 to 6 cover" is a list, and it used to arrive as one
 * paragraph of prose with eleven objective codes in it, printed into a single <p> with
 * no spacing anywhere in the chain. The model had no way to say "these are six things"
 * and the interface had nothing to lay out if it had.
 */
export interface AnswerPoint {
  /** What the point is about: "Week 1", "CP4B Mathematics", "Mrs Banda". Null where
   *  the point does not name a thing and is simply another sentence. */
  label: string | null;
  text: string;
}

export interface Answer {
  kind: AnswerKind;
  /** The answer itself, in a sentence or two. Never empty except on 'open_ended'. */
  answer: string;
  /** The parts, when the answer is genuinely a list. Empty for a single fact. */
  points: AnswerPoint[];
}

const SYSTEM = `You answer questions for teachers at Lusaka Oaktree School, a Cambridge
primary/lower-secondary school in Zambia, inside LOTS AI - the school's own application for
planning, worksheets, study packs and lesson evaluation.

You are given THE SCHOOL'S RECORDS: its calendar for the academic year, its subjects and the
department each belongs to, its staff, its curriculum registry, and who is asking. Classify
every question, and answer it accordingly.

"records" - the records above answer it. Every fact about Lusaka Oaktree School must come from
them: dates, week numbers, topics, objectives, classes, who works there and what they do, which
department a subject sits in, the school's own policy and practice, what is planned and what is
not. Never infer a fact about this school that is not written above, and never guess at one that
is missing. Where the records are silent on the specific thing asked, say so plainly and answer
what they do cover.

School policy is the case where guessing is most tempting and worst. Every school has a uniform
rule, a marking policy and a safeguarding lead, so you know the shape of the answer without
knowing this school's. If SCHOOL FACTS does not cover what was asked, say the records do not hold
it and suggest they ask the school office - never answer with what a school would usually do.

Who somebody is is a records question like any other. "Who is the Head of Department for Science?"
is answered by reading the department Science belongs to and naming the Head of Department in it -
not by declining because it is about a person. But the same rule binds harder here than anywhere:
name only people the STAFF list holds, in the role it gives them. If no Head of Department matches
that subject's department, or the subject records no department, say the records do not show one.
A guessed name is a teacher sending work to the wrong person.

Contact details are not in these records at all. Asked for an email address, a phone number or
where somebody lives, say the records do not hold it - never construct one from a name, and never
suggest a likely address.

"general" - the records do not hold it, but it is a genuine question you can answer usefully from
general knowledge: what a Cambridge objective code means, how a recap lesson is usually
structured, what differentiation is. Answer it, but state nothing specific to Lusaka Oaktree
School - no dates, no timetable, no policy, no staff. If answering would need you to invent
something about this school, it is not this kind.

"open_ended" - the teacher is asking you to MAKE something rather than to tell them something:
homework, a worksheet, a study pack, a lesson plan, a test, a letter, a display, or any other piece
of writing, research or drafting. Leave "answer" empty; the application says its own piece.

This one matters most, so read it twice. A request to produce teaching material is never "records"
and never "general", however much of it the records could ground - not "write a homework on factors
and multiples", not "give me five questions on this week's topic", not "draft a note to parents".
Asked to create a homework, you once wrote the whole paper into the chat as though it were a fact
about this school, and the teacher then had a homework in a chat window and no document. The
application has workflows that build these properly, and it can only route to them if you say what
kind of request this is. Telling a teacher what week 5 covers is "records"; writing the homework for
week 5 is "open_ended".

HOW TO ANSWER

Plain British English, in the register a colleague would use. Give the specific fact asked for
rather than describing where to find it. Never use an em dash or an en dash. Use a plain hyphen.

"answer" is the answer itself, in a sentence or two. Lead with it: a teacher between lessons
reads the first line and stops.

"points" is for when the answer is genuinely a list - a week each, a class each, a person each,
an objective each. Give each one a short "label" naming what it is about and a "text" saying
what about it. Six at most. A question with one fact in it gets one or two sentences and an
empty "points"; padding a single fact into a list is worse than a paragraph. Never repeat in
"points" what "answer" already said.

OBJECTIVES ARE STATEMENTS, NOT CODES

A teacher does not read "4Ri.02". They read "read and explore a range of fiction genres". The
code is an index for sign-off and coverage, and the objective is the thing. So say what an
objective asks for, in its own words from the records, and put the code after it in brackets
if it helps them find it on a Cambridge overview - never a code on its own, and never a list of
codes as though it answered anything. "Week 1 covers reading a range of fiction genres (4Ri.02)
and enjoying independent reading (4Ra.01)" is the answer; "Week 1 is 4Ri.02 and 4Ra.01" is the
question asked again.

The objectives come in the CURRICULUM OBJECTIVES block, which holds only the year groups and
subjects this particular question is about. The CURRICULUM REGISTRY in the school's records is
a different thing: it is one line per week naming the topic, for every year group in the school,
and a topic label is not an objective. So if the question needs objectives and no CURRICULUM
OBJECTIVES block is present, the records have not been asked for them - say which year group and
subject you would need rather than reading the objectives off the topic labels, which do not
contain them. Never turn a topic label into an objective by rewording it.`;

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['records', 'general', 'open_ended'] },
    answer: { type: 'string' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: ['string', 'null'] },
          text: { type: 'string' },
        },
        required: ['label', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['kind', 'answer', 'points'],
  additionalProperties: false,
} as const;

/** How many points a reply may carry. Past this it is a document, not an answer. */
const MAX_POINTS = 6;

const YEAR = '2026-27';

/**
 * The half of the grounding that is identical for everyone in the school.
 *
 * It sits in `cached` so the second teacher to ask a question today pays a tenth
 * of the input price for it - the same breakpoint discipline the planner and the
 * study pack use.
 *
 * It returns the registry's vocabulary alongside the text. lib/objectives.ts has to
 * decide which year groups and subjects a question is about, and the lists it needs
 * to decide against are the ones assembled here - reading them a second time would
 * be the same two queries for the same rows.
 */
async function schoolBlock(db: ReturnType<typeof admin>): Promise<{
  text: string;
  years: string[];
  subjects: { id: string; name: string }[];
  pairs: Slice[];
}> {
  const [{ data: weeks }, { data: reg }, { data: subjects }, { data: staff }, { data: facts },
         { data: classes }, { data: dates }, teachers] = await Promise.all([
    db.from('school_week').select('week_number, week_commencing, week_type, semester, note')
      .eq('academic_year', YEAR).order('week_commencing'),
    db.from('curriculum_week').select('week_number, year_group, subject_id, topic_label, signed_off_at')
      .eq('academic_year', YEAR).order('week_number'),
    db.from('subject').select('id, name, department'),
    // Name, role and department only. `app_user` also carries email, last_seen_at,
    // pin_set_at and locked_until; those are administration data for /admin/people,
    // not school records, and this block is read by every teacher who asks a question.
    db.from('app_user').select('full_name, role, department')
      .eq('is_active', true).order('full_name'),
    // What the school knows about itself that no other table holds. Ordered so the
    // cached prefix is byte-identical between calls and actually caches.
    db.from('school_fact').select('topic, body')
      .eq('academic_year', YEAR).is('retired_at', null).order('topic'),
    // Who teaches what. askerBlock lists the asker's OWN classes, which answers
    // "what am I teaching" but not "who teaches CP4 Maths" - a question a teacher
    // asks in order to go and speak to somebody. A school has a handful of classes.
    db.from('klass').select('id, name, year_group, subject_id')
      .order('name'),
    // The dates that are not weeks: examinations, conferences, reports, holidays. They
    // are a page of the school's own calendar and were previously nowhere in the data,
    // so "when do reports go home" got the records-are-silent answer. Migration 0018 is
    // applied by hand like the rest, so a missing table is a missing section here, not
    // an error - the same tolerance every other read on this page has.
    db.from('school_date').select('starts_on, ends_on, kind, label, note')
      .eq('academic_year', YEAR).order('starts_on'),
    // Allocation moved to class_teacher in 0026, so a class can now name more than
    // one teacher. Reading the single klass.teacher_id here would have quietly kept
    // naming the first of them and calling that the answer.
    teachersByClass(db),
  ]);

  const lines: string[] = [`THE SCHOOL'S RECORDS - Lusaka Oaktree School, academic year ${YEAR}`];

  lines.push('');
  lines.push('CALENDAR. Every week of the year, the Monday it commences, and what kind of week it');
  lines.push('is. A "teaching" week is one the school teaches in; "break" is a holiday; the rest are');
  lines.push('revision, exam and inset weeks. The school opens on the Monday of the first teaching');
  lines.push('week of semester 1, and a term ends at the last teaching week before a break.');
  for (const w of weeks ?? []) {
    lines.push(`  Semester ${w.semester}, week ${w.week_number}: w/c ${w.week_commencing} (${w.week_type})`
      + `${w.note ? ` - ${w.note}` : ''}`);
  }

  if (dates?.length) {
    lines.push('');
    lines.push('DATES. What happens on a day rather than across a week: terms opening and closing,');
    lines.push('breaks, examination and assessment windows, parent conferences, when reports go');
    lines.push('home, national holidays, and the events the school runs. A range covers both');
    lines.push('days named and everything between them. This is the published calendar, so a');
    lines.push('date not listed here is one the records do not hold - say so rather than working');
    lines.push('one out from the weeks above.');
    for (const d of dates) {
      lines.push(`  ${d.starts_on}${d.ends_on ? ` to ${d.ends_on}` : ''} (${d.kind}): ${d.label}`
        + `${d.note ? ` - ${d.note}` : ''}`);
    }
  }

  lines.push('');
  lines.push('SUBJECTS, and the department each one belongs to. A subject\'s department is what');
  lines.push('connects it to the staff below: the Head of Department for a subject is the person');
  lines.push('whose department matches that subject\'s. Where a subject records no department, the');
  lines.push('records do not say who heads it - say so rather than choosing the nearest name.');
  for (const s of subjects ?? []) {
    lines.push(`  ${s.id} = ${s.name}${s.department ? ` (${s.department} department)` : ' (no department recorded)'}`);
  }

  lines.push('');
  lines.push('STAFF. Everyone who works at the school, what they do, and the department they are');
  lines.push('in. This is the whole list - a name that is not here does not work here, or has left.');
  lines.push('Their email addresses, sign-in details and last-seen times are deliberately not in');
  lines.push('these records; the school keeps those somewhere a teacher does not need them.');
  for (const p of staff ?? []) {
    lines.push(`  ${p.full_name} - ${ROLE_SAYS[p.role] ?? p.role}`
      + `${p.department ? `, ${p.department} department` : ''}`);
  }

  lines.push('');
  lines.push('CLASSES, and who teaches each one. A class can have more than one teacher');
  lines.push('against it - a subject shared between two, or somebody covering. A class with no');
  lines.push('teacher has not been assigned one in these records - say that, rather than naming');
  lines.push('whoever teaches the subject elsewhere.');
  for (const k of classes ?? []) {
    const names = teachers.get(k.id) ?? [];
    lines.push(`  ${k.name} (${k.year_group} ${k.subject_id}): `
      + (names.length ? names.join(', ') : 'no teacher assigned'));
  }

  lines.push('');
  lines.push('CURRICULUM REGISTRY. What each year group covers in each week, and whether the head of');
  lines.push('department has signed it off. Only a signed-off week can be planned or built from.');
  for (const r of reg ?? []) {
    lines.push(`  ${r.year_group} ${r.subject_id} week ${r.week_number}: ${r.topic_label ?? '(no topic recorded)'}`
      + `${r.signed_off_at ? '' : ' [not signed off]'}`);
  }

  if (facts?.length) {
    lines.push('');
    lines.push('SCHOOL FACTS. The school\'s own policy and practice, as the school has written it');
    lines.push('down: what is expected, who to go to, how things are done here. These are current -');
    lines.push('anything the school has withdrawn is not in this list. A question about school');
    lines.push('policy is answered from here or not at all; never fill a gap in it from what');
    lines.push('schools usually do.');
    // Two guards, both cheap, both here rather than at the write: a fact can also reach
    // this table through the SQL editor, and the prefix is where the damage would be.
    //
    // A repeated topic is dropped - /api/school-fact catches those, and a second copy
    // in here is a question the model has to choose an answer to. The caps then hold
    // the whole block to a size worth carrying on every request.
    const emitted = new Set<string>();
    let used = 0, shown = 0;
    for (const f of facts) {
      const key = normaliseTopic(f.topic);
      if (emitted.has(key)) continue;
      const line = `  ${f.topic}: ${f.body}`;
      if (shown >= MAX_FACTS || used + line.length > MAX_FACT_CHARS) break;
      emitted.add(key);
      lines.push(line);
      used += line.length;
      shown++;
    }

    if (shown < facts.length) {
      lines.push(`  (${shown} of ${facts.length} facts are shown here. The rest are recorded in`);
      lines.push('  the administration pages. If a question needs one that is not above, say the');
      lines.push('  records do not show it here rather than guessing at it.)');
      console.warn(`[ask] school facts over budget: ${shown}/${facts.length} shown, `
        + `${used}/${MAX_FACT_CHARS} chars. Time to reconsider carrying them whole.`);
    }
  }

  return {
    text: lines.join('\n'),
    years: [...new Set((reg ?? []).map(r => r.year_group))].sort(),
    subjects: (subjects ?? []).map(s => ({ id: s.id, name: s.name })),
    pairs: [...new Map((reg ?? []).map(r =>
      [`${r.year_group}|${r.subject_id}`, { year_group: r.year_group, subject_id: r.subject_id }],
    )).values()],
  };
}

/** The half that changes per teacher, and so must follow the cache breakpoint. */
async function askerBlock(
  db: ReturnType<typeof admin>,
  user: { id: string; full_name: string; role: string },
): Promise<{ text: string; mine: Slice[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`TODAY is ${today}.`, `THE PERSON ASKING is ${user.full_name}, a ${user.role}.`];

  const classes = await classesFor(db, user);

  if (!classes.length) {
    lines.push('They teach no classes in this application.');
    return { text: lines.join('\n'), mine: [] };
  }

  lines.push('', 'THEIR CLASSES:');
  for (const k of classes) lines.push(`  ${k.name} (${k.year_group} ${k.subject_id})`);

  const { data: planners } = await db.from('planner')
    .select('status, school_week, class_id').in('class_id', classes.map(k => k.id));

  if (planners?.length) {
    const { data: weeks } = await db.from('school_week')
      .select('id, week_number').eq('academic_year', YEAR);
    const weekOf = new Map((weeks ?? []).map(w => [w.id, w.week_number]));
    const nameOf = new Map(classes.map(k => [k.id, k.name]));
    lines.push('', 'THEIR PLANNERS so far:');
    for (const p of planners) {
      lines.push(`  ${nameOf.get(p.class_id) ?? p.class_id}, week ${weekOf.get(p.school_week) ?? '?'}: ${p.status}`);
    }
  } else {
    lines.push('', 'THEY HAVE NO PLANNERS yet.');
  }

  return {
    text: lines.join('\n'),
    mine: [...new Map(classes.map(k =>
      [`${k.year_group}|${k.subject_id}`, { year_group: k.year_group, subject_id: k.subject_id }],
    )).values()],
  };
}

/**
 * Which semester the school is in today.
 *
 * The next teaching week at or after today, which is how app/api/agenda/route.ts
 * already decides what "this week" means: on a Wednesday it is still the week you
 * are in, and it rolls forward on Monday. Past the last teaching week of the year
 * there is no next one, and semester 2 is the honest answer then - the year ends in
 * it. Week numbers restart each semester, so getting this wrong does not fail, it
 * quietly answers about the wrong half of the year.
 */
async function currentSemester(db: ReturnType<typeof admin>): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db.from('school_week')
    .select('semester')
    .eq('academic_year', YEAR).eq('week_type', 'teaching')
    .gte('week_commencing', today)
    .order('week_commencing').limit(1).maybeSingle();
  return data?.semester ?? 2;
}

export async function askAboutSchool(
  question: string,
  user: { id: string; full_name: string; role: string },
): Promise<Answer & { usage: unknown }> {
  const db = admin();
  const [school, asker, semester] = await Promise.all([
    schoolBlock(db), askerBlock(db, user), currentSemester(db),
  ]);

  // Which year groups and subjects the question is about, and then their objectives.
  //
  // This goes after the cache breakpoint, with the asker, rather than into `cached`
  // with the school block - which is the opposite of what it looks like it wants.
  // lib/providers/anthropic.ts puts the one breakpoint on the *last* cached block, so
  // a per-question block appended there would make the whole prefix per-question: the
  // school block is what the whole school shares, and a French question would evict it
  // for the CP5 maths teacher who asked a second earlier. The saving forgone is small -
  // a pair is 700 tokens at the median - and the prefix it would cost is 8,000.
  const slices = resolveSlices(question, school, asker.mine, school.pairs);
  const objectives = await objectivesBlock(db, slices, YEAR, semester);

  const { data, usage } = await call<Answer>({
    tier: 'small',
    workflow: 'school_question',
    userId: user.id,
    system: SYSTEM,
    cached: [school.text],
    // The whole school shares this prefix, and questions come in bursts around
    // the planning window, so it earns the long TTL the same way the planner does.
    longCache: true,
    prompt: `${asker.text}${objectives}\n\nTHE QUESTION: ${question}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 700,
  });

  // An unrecognised kind is treated as an answer from the records rather than as
  // a refusal: the failure mode of a mislabelled answer is a missing "not from
  // the school's records" note, and the failure mode of a wrong refusal is a
  // teacher told to go and use ChatGPT for their own timetable.
  const kind: AnswerKind = data?.kind === 'general' || data?.kind === 'open_ended' ? data.kind : 'records';

  // A point with no text is a bullet with nothing on it, which reads as a fault in
  // the application rather than as a short answer.
  const points: AnswerPoint[] = (Array.isArray(data?.points) ? data.points : [])
    .map(p => ({
      label: p?.label ? String(p.label).trim() : null,
      text: String(p?.text ?? '').trim(),
    }))
    .filter(p => p.text)
    .slice(0, MAX_POINTS);

  return { kind, answer: String(data?.answer ?? '').trim(), points, usage };
}
