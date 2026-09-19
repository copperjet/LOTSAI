/**
 * Which classes a person teaches, and who teaches a class.
 *
 * Four places asked `klass.teacher_id = me` and each wrote the query out again -
 * the agenda, the calendar, search, and the asker block in lib/ask.ts. Migration
 * 0026 moves the allocation to `class_teacher`, because one nullable column cannot
 * hold two teachers and teachers now pick their own classes; this is the one place
 * that knows that, so moving it again is one edit rather than four.
 *
 * A role in ALL_CLASSES_ROLES gets the whole school. That is the school's own rule -
 * heads of department, coordinators, principals, administrators and lead teachers see
 * across it - and putting it here rather than at each call site is what stopped three
 * routes testing for 'hod' alone and refusing everybody else.
 */
import type { admin } from './supabase';
import { ALL_CLASSES_ROLES } from './admin';

export type TeachingClass = {
  id: string; name: string; year_group: string; subject_id: string;
};

/**
 * The ids of the classes this person teaches, or null meaning every class.
 *
 * Null rather than "all the ids" so a caller can leave its query unfiltered instead
 * of passing the whole school to an `in`, which is also the difference between a
 * reviewer seeing a class nobody has been assigned to yet and not seeing it.
 */
export async function classIdsFor(
  db: ReturnType<typeof admin>,
  user: { id: string; role: string },
): Promise<string[] | null> {
  if (ALL_CLASSES_ROLES.includes(user.role)) return null;
  const { data } = await db.from('class_teacher').select('class_id').eq('user_id', user.id);
  return (data ?? []).map(r => r.class_id);
}

/**
 * The classes this person teaches, or every class if their role says so.
 *
 * Ordered by name so two calls in one request agree with each other, and so the
 * cached prompt blocks built from it are byte-identical between questions.
 */
export async function classesFor(
  db: ReturnType<typeof admin>,
  user: { id: string; role: string },
): Promise<TeachingClass[]> {
  const ids = await classIdsFor(db, user);
  if (ids?.length === 0) return [];

  const q = db.from('klass').select('id, name, year_group, subject_id').order('name');
  const { data } = await (ids ? q.in('id', ids) : q);
  return (data ?? []) as TeachingClass[];
}

/**
 * Everyone who teaches each class, by class id.
 *
 * For the school-wide list in lib/ask.ts, which used to read the single teacher_id
 * and so could only ever name one person. A class with nobody against it is absent
 * from the map rather than present and empty - the caller says "no teacher assigned",
 * and an empty array would make that two different ways of saying the same thing.
 */
export async function teachersByClass(
  db: ReturnType<typeof admin>,
): Promise<Map<string, string[]>> {
  const { data } = await db.from('class_teacher')
    .select('class_id, app_user:user_id(full_name)');

  const out = new Map<string, string[]>();
  for (const row of data ?? []) {
    const name = (row as unknown as { app_user?: { full_name: string } }).app_user?.full_name;
    if (!name) continue;
    out.set(row.class_id, [...(out.get(row.class_id) ?? []), name]);
  }
  for (const names of out.values()) names.sort();
  return out;
}
