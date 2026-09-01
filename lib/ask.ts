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
 * The grounding comes from the tables /api/calendar already reads, at the scale
 * app/api/search/route.ts already reasons about: one academic year is tens of
 * weeks and a handful of classes, so it is assembled in memory rather than
 * indexed. That is the thing to change first when the registry holds every
 * stage - the shape here stays, the source becomes a query.
 */
import { admin } from './supabase';
import { call } from './llm';

export type AnswerKind = 'records' | 'general' | 'open_ended';

export interface Answer {
  kind: AnswerKind;
  answer: string;
}

const SYSTEM = `You answer questions for teachers at Lusaka Oaktree School, a Cambridge
primary/lower-secondary school in Zambia, inside LOTS AI - the school's own application for
planning, worksheets, study packs and lesson evaluation.

You are given THE SCHOOL'S RECORDS: its calendar for the academic year, its curriculum registry,
and who is asking. Classify every question, and answer it accordingly.

"records" - the records above answer it. Every fact about Lusaka Oaktree School must come from
them: dates, week numbers, topics, objectives, classes, what is planned and what is not. Never
infer a fact about this school that is not written above, and never guess at one that is missing.
Where the records are silent on the specific thing asked, say so plainly and answer what they do
cover.

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

Answer in two or three sentences, in plain British English, in the register a colleague would use.
Give the specific fact asked for rather than describing where to find it. Never use an em dash or
an en dash. Use a plain hyphen.`;

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['records', 'general', 'open_ended'] },
    answer: { type: 'string' },
  },
  required: ['kind', 'answer'],
  additionalProperties: false,
} as const;

const YEAR = '2026-27';

/**
 * The half of the grounding that is identical for everyone in the school.
 *
 * It sits in `cached` so the second teacher to ask a question today pays a tenth
 * of the input price for it - the same breakpoint discipline the planner and the
 * study pack use.
 */
async function schoolBlock(db: ReturnType<typeof admin>): Promise<string> {
  const [{ data: weeks }, { data: reg }, { data: subjects }] = await Promise.all([
    db.from('school_week').select('week_number, week_commencing, week_type, semester')
      .eq('academic_year', YEAR).order('week_commencing'),
    db.from('curriculum_week').select('week_number, year_group, subject_id, topic_label, signed_off_at')
      .eq('academic_year', YEAR).order('week_number'),
    db.from('subject').select('id, name'),
  ]);

  const lines: string[] = [`THE SCHOOL'S RECORDS - Lusaka Oaktree School, academic year ${YEAR}`];

  lines.push('');
  lines.push('CALENDAR. Every week of the year, the Monday it commences, and what kind of week it');
  lines.push('is. A "teaching" week is one the school teaches in; "break" is a holiday; the rest are');
  lines.push('revision, exam and inset weeks. The school opens on the Monday of the first teaching');
  lines.push('week of semester 1, and a term ends at the last teaching week before a break.');
  for (const w of weeks ?? []) {
    lines.push(`  Semester ${w.semester}, week ${w.week_number}: w/c ${w.week_commencing} (${w.week_type})`);
  }

  lines.push('');
  lines.push('SUBJECTS.');
  for (const s of subjects ?? []) lines.push(`  ${s.id} = ${s.name}`);

  lines.push('');
  lines.push('CURRICULUM REGISTRY. What each year group covers in each week, and whether the head of');
  lines.push('department has signed it off. Only a signed-off week can be planned or built from.');
  for (const r of reg ?? []) {
    lines.push(`  ${r.year_group} ${r.subject_id} week ${r.week_number}: ${r.topic_label ?? '(no topic recorded)'}`
      + `${r.signed_off_at ? '' : ' [not signed off]'}`);
  }

  return lines.join('\n');
}

/** The half that changes per teacher, and so must follow the cache breakpoint. */
async function askerBlock(
  db: ReturnType<typeof admin>,
  user: { id: string; full_name: string; role: string },
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`TODAY is ${today}.`, `THE PERSON ASKING is ${user.full_name}, a ${user.role}.`];

  const { data: classes } = await db.from('klass')
    .select('id, name, subject_id, year_group').eq('teacher_id', user.id).order('name');

  if (!classes?.length) {
    lines.push('They teach no classes in this application.');
    return lines.join('\n');
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

  return lines.join('\n');
}

export async function askAboutSchool(
  question: string,
  user: { id: string; full_name: string; role: string },
): Promise<Answer & { usage: unknown }> {
  const db = admin();
  const [school, asker] = await Promise.all([schoolBlock(db), askerBlock(db, user)]);

  const { data, usage } = await call<Answer>({
    tier: 'small',
    workflow: 'school_question',
    userId: user.id,
    system: SYSTEM,
    cached: [school],
    // The whole school shares this prefix, and questions come in bursts around
    // the planning window, so it earns the long TTL the same way the planner does.
    longCache: true,
    prompt: `${asker}\n\nTHE QUESTION: ${question}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 700,
  });

  // An unrecognised kind is treated as an answer from the records rather than as
  // a refusal: the failure mode of a mislabelled answer is a missing "not from
  // the school's records" note, and the failure mode of a wrong refusal is a
  // teacher told to go and use ChatGPT for their own timetable.
  const kind: AnswerKind = data?.kind === 'general' || data?.kind === 'open_ended' ? data.kind : 'records';
  return { kind, answer: String(data?.answer ?? '').trim(), usage };
}
