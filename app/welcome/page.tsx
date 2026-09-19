import { redirect } from 'next/navigation';
import { admin, currentUser } from '@/lib/supabase';
import { ALL_CLASSES_ROLES } from '@/lib/admin';
import { CREST } from '@/lib/crest';

export const dynamic = 'force-dynamic';

/**
 * Which classes do you teach.
 *
 * A teacher whose classes nobody has recorded has an empty agenda, an empty
 * calendar, and no way to find out why - which is what every teacher had, because
 * klass.teacher_id was set once by a seed script and never again. So this is asked
 * at the first sign-in, and reachable afterwards to correct a mistake or pick up a
 * cover class.
 *
 * The teacher chooses, and can choose anything. That is a real decision and not an
 * accident: an approval step would mean somebody waiting on a head of department
 * before they could plan anything, and in a school of twenty staff the wrong box
 * ticked is a conversation rather than a breach. Every change is written to
 * audit_log, and /admin/classes is where it is put right.
 *
 * A plain form, no client JavaScript, so it works on a slow phone on school wifi.
 * Two hundred classes is a lot of checkboxes, so they are grouped by year group in
 * the order the school runs them - which is not alphabetical order, where A Level
 * would come first and EY1 in the middle.
 */

/** Year groups in the order a school says them, rather than the order they sort in. */
const YEAR_ORDER = [
  'EY1', 'EY2', 'EY3',
  'CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6',
  'LS1', 'LS2', 'LS3',
  'IGCSE 1', 'IGCSE 2', 'AS', 'A Level',
];

export default async function Welcome({ searchParams }: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { e } = await searchParams;
  const user = await currentUser();

  // Nothing to choose: they already see every class in the school.
  if (ALL_CLASSES_ROLES.includes(user.role)) redirect('/');

  const db = admin();
  const [{ data: classes }, { data: mine }] = await Promise.all([
    db.from('klass').select('id, name, year_group, subject_id, subject:subject_id(name)')
      .order('name'),
    db.from('class_teacher').select('class_id').eq('user_id', user.id),
  ]);

  const rows = (classes ?? []) as unknown as {
    id: string; name: string; year_group: string; subject_id: string;
    subject: { name: string | null } | null;
  }[];
  const picked = new Set((mine ?? []).map(r => r.class_id));

  const groups = new Map<string, typeof rows>();
  for (const k of rows) groups.set(k.year_group, [...(groups.get(k.year_group) ?? []), k]);

  const order = [...groups.keys()].sort((a, b) => {
    const ia = YEAR_ORDER.indexOf(a), ib = YEAR_ORDER.indexOf(b);
    // A year group nobody thought of goes to the end rather than to the front.
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  return (
    <div className="gatepage">
      <form className="welcard" method="post" action="/api/welcome">
        <img src={CREST} alt="Lusaka Oaktree School" width={44} height={44}
             style={{ borderRadius: 13 }} />
        <h1>Which classes do you teach, {user.full_name.split(' ')[0]}?</h1>
        <p>
          Tick every class you teach. This is what puts a week on your agenda and lets you
          plan it - nothing appears until at least one is ticked. You can change it later.
        </p>

        {e && <p className="gerr">That did not save. Try again.</p>}

        {!rows.length ? (
          <p className="anote">
            No classes have been set up yet. Ask an administrator to add them on the Classes
            page before you carry on - there is nothing here to choose from until they do.
          </p>
        ) : (
          <div className="welgroups">
            {order.map(year => (
              <div className="welgroup" key={year}>
                <b>{year}</b>
                <div className="welpick">
                  {(groups.get(year) ?? []).map(k => (
                    <label key={k.id}>
                      <input type="checkbox" name="classId" value={k.id}
                             defaultChecked={picked.has(k.id)} />
                      <span>{k.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <footer>
          <small>
            {picked.size
              ? `${picked.size} class${picked.size === 1 ? '' : 'es'} recorded against your name now.`
              : 'Nothing recorded against your name yet.'}
          </small>
          <button className="btn primary" type="submit">
            {rows.length ? 'Save and carry on' : 'Carry on'}
          </button>
        </footer>
      </form>
    </div>
  );
}
