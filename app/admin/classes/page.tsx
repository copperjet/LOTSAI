import { admin } from '@/lib/supabase';
import { PROBLEM_SAYS } from '@/lib/admin';

export const dynamic = 'force-dynamic';

interface Klass {
  id: string; name: string; year_group: string; subject_id: string;
  periods_per_week: number;
  subject: { name: string | null } | null;
}
interface Teacher { id: string; full_name: string; role: string; is_active: boolean }

/**
 * Who teaches what.
 *
 * class_teacher decides whose agenda a week appears on, which planner belongs to
 * whom, and whether anybody is ever asked to evaluate the lesson. Until now it was
 * set once by scripts/seed.mjs, so a teacher leaving in October meant editing a seed
 * file and running it against production - or, in practice, nobody being asked to
 * plan that class at all. A class with nobody in front of it fails silently, which is
 * why the unassigned ones are counted at the top rather than left to be noticed.
 *
 * A class takes more than one teacher since 0026 - a subject shared between two, or
 * somebody covering - so the control adds a name rather than replacing the one there.
 * Taking somebody off is its own button, because it is its own decision.
 *
 * Every role is offered, not only teachers: a head of department who teaches a class
 * is ordinary here, and the timetable is not the place to argue about seniority.
 */
export default async function Classes({ searchParams }: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { e } = await searchParams;
  const db = admin();

  const [{ data: classes }, { data: staff }, { data: allocations }] = await Promise.all([
    db.from('klass')
      .select('id, name, year_group, subject_id, periods_per_week, subject:subject_id(name)')
      .order('year_group').order('subject_id'),
    db.from('app_user').select('id, full_name, role, is_active')
      .eq('is_active', true).order('full_name'),
    db.from('class_teacher').select('class_id, user_id, app_user:user_id(full_name)'),
  ]);

  const rows = (classes ?? []) as unknown as Klass[];
  const teachers = (staff ?? []) as Teacher[];

  const held = new Map<string, { id: string; name: string }[]>();
  for (const a of (allocations ?? []) as unknown as
       { class_id: string; user_id: string; app_user: { full_name: string } | null }[]) {
    held.set(a.class_id, [...(held.get(a.class_id) ?? []),
      { id: a.user_id, name: a.app_user?.full_name ?? 'Somebody' }]);
  }
  for (const names of held.values()) names.sort((x, y) => x.name.localeCompare(y.name));
  const unassigned = rows.filter(k => !held.has(k.id)).length;

  return (
    <>
      <h1>Classes</h1>
      <p className="anote awide">
        {rows.length} classes.
        {unassigned > 0
          ? <> <b className="bad">{unassigned}</b> have nobody teaching them: no agenda, no planner and
              no evaluation is ever asked for a class with no teacher.</>
          : <> Every class has a teacher.</>}
      </p>

      {e && <p className="aproblem">{PROBLEM_SAYS[e] ?? 'That did not work.'}</p>}

      {!rows.length ? <p className="anote">No classes yet. They are created by the seed script.</p> : (
        <table className="atable">
          <thead>
            <tr><th>Class</th><th>Year</th><th>Subject</th><th className="r">Periods</th><th>Teacher</th></tr>
          </thead>
          <tbody>
            {rows.map(k => {
              const mine = held.get(k.id) ?? [];
              return (
              <tr key={k.id} className={mine.length ? '' : 'off'}>
                <td><b>{k.name}</b><span className="anote">{k.id}</span></td>
                <td>{k.year_group}</td>
                <td>{k.subject?.name ?? k.subject_id}</td>
                <td className="r num">{k.periods_per_week}</td>
                <td>
                  {mine.map(t => (
                    <form key={t.id} method="post" action="/api/admin"
                          style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                      <input type="hidden" name="action" value="unassign_class" />
                      <input type="hidden" name="classId" value={k.id} />
                      <input type="hidden" name="teacherId" value={t.id} />
                      <span>{t.name}</span>
                      <button className="abtn" type="submit"
                              aria-label={`Take ${t.name} off ${k.name}`}>Remove</button>
                    </form>
                  ))}
                  <form method="post" action="/api/admin" style={{ display: 'flex', gap: 6 }}>
                    <input type="hidden" name="action" value="assign_class" />
                    <input type="hidden" name="classId" value={k.id} />
                    <select name="teacherId" defaultValue="">
                      <option value="">{mine.length ? 'Add another' : 'Nobody yet'}</option>
                      {teachers.filter(t => !mine.some(m => m.id === t.id)).map(t => (
                        <option key={t.id} value={t.id}>{t.full_name}</option>
                      ))}
                    </select>
                    <button className="abtn" type="submit">Add</button>
                  </form>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="anote awide">
        Adding a teacher puts the class on their agenda from the next page load, and removing one
        takes it off. Planners already written keep the name of whoever wrote them - the work is
        theirs and the log says so.
      </p>
    </>
  );
}
