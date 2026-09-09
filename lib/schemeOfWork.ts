/**
 * What the published scheme of work suggests for this week's objectives.
 *
 * The registry says what a week covers. The school's own overview sometimes says how to
 * teach it - `curriculum_week.activities`, which lib/planner.ts has always put in the
 * planner's cached block. Almost no overview fills that column: 15 weeks out of 377. So
 * for nearly every week the planner has been inventing the teaching activity from the
 * objective text alone, while the department's own Cambridge scheme of work sat outside
 * the system with a suggested activity written against every objective in it.
 *
 * This reads that bank (objective_activity, migration 0022) for the objectives the week
 * actually carries. Two lookups, because two of the syllabuses are written two different
 * ways and subject_curriculum.joins_on says which is which:
 *
 *   ref    0059 and 0860 code every objective, and the code in the school's overview is
 *          the code in Cambridge's scheme of work. The week's own refs are the keys.
 *   topic  0417 and 9626 have no objective codes. Both they and the school's overviews
 *          organise by numbered syllabus topic, and the overview writes that number into
 *          the week's topic - "1. Types & Components of Computer Systems (1/5)". So the
 *          topic label supplies the keys, and a week on topic 6 gets 6.1 through 6.11.
 *
 * Nothing here is an objective and nothing here is a resource the school owns. It is
 * material for the model to adapt, and lib/planner.ts introduces it as exactly that -
 * the resource inventory still decides what a lesson may actually call for.
 */
import { admin } from './supabase';

export interface Published {
  key: string;
  objective_text: string | null;
  activities: string[];
  resources: string[];
  notes: string[];
  source: string;
}

/**
 * How much of the bank one week may carry into the prompt.
 *
 * A topic-keyed lookup is broad by nature - topic 6 of 0417 is eleven sub-topics - and
 * all of it would ride the cached block on every planning call for that week. These
 * bounds keep a week's worth of suggestion to something a person would actually read,
 * and they bite on the topic path rather than the reference one, where a week has three
 * or four objectives and each has a handful of activities.
 */
const MAX_ENTRIES = 12;
const MAX_LINES = 6;

/** The number a topic label cites: "1. Types & Components (1/5)" and "19. Presentations"
 *  give 1 and 19. Written by hand in a Word table, so the separator varies. */
const TOPIC_IN_LABEL = /(?:^|[^\d.])(\d{1,2})\s*[.)]\s+[A-Za-z]/g;

export async function publishedActivities(
  subjectId: string,
  yearGroup: string,
  objectives: { ref: string | null; text: string }[],
  topicLabel: string,
): Promise<Published[]> {
  const db = admin();

  // Which framework this class follows. Migrations here are applied by hand, so a
  // database without 0021 or 0022 has no bank and no routing - that is a planner
  // without published suggestions, exactly as it was before, not an error.
  const { data: routing, error } = await db
    .from('subject_curriculum')
    .select('syllabus_code, joins_on')
    .eq('subject_id', subjectId)
    .contains('year_groups', [yearGroup]);
  if (error || !routing?.length) return [];

  const wanted = new Map<string, Set<string>>();   // syllabus_code -> keys
  for (const { syllabus_code, joins_on } of routing) {
    const keys = new Set<string>();
    if (joins_on === 'ref') {
      for (const o of objectives) if (o.ref) keys.add(o.ref);
    } else {
      for (const m of topicLabel.matchAll(TOPIC_IN_LABEL)) keys.add(m[1]);
    }
    if (keys.size) wanted.set(syllabus_code, keys);
  }
  if (!wanted.size) return [];

  const out: Published[] = [];
  for (const [code, keys] of wanted) {
    const kind = routing.find(r => r.syllabus_code === code)?.joins_on;

    // A reference is the whole key. A topic number is the start of one: the bank holds
    // 6.1 to 6.11 and the week cites 6, so the sub-topics are what it wants.
    const query = db.from('objective_activity')
      .select('key, objective_text, activities, resources, notes, source')
      .eq('syllabus_code', code);

    const { data } = kind === 'ref'
      ? await query.in('key', [...keys])
      : await query.or([...keys].map(k => `key.eq.${k},key.like.${k}.%`).join(','));

    for (const row of data ?? []) {
      if (!row.activities?.length && !row.notes?.length) continue;
      out.push({
        key: row.key,
        objective_text: row.objective_text,
        activities: (row.activities ?? []).slice(0, MAX_LINES),
        resources: (row.resources ?? []).slice(0, MAX_LINES),
        notes: (row.notes ?? []).slice(0, 2),
        source: row.source,
      });
    }
  }

  // Ordered so the block is stable between calls - the prefix is cached, and a set that
  // reshuffles itself is a set that never gets a cache hit.
  out.sort((a, b) => a.source.localeCompare(b.source)
    || a.key.localeCompare(b.key, undefined, { numeric: true }));
  return out.slice(0, MAX_ENTRIES);
}
