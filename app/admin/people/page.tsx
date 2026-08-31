import Link from 'next/link';
import { fromView, money, count, when } from '@/lib/admin';

export const dynamic = 'force-dynamic';

interface Person {
  user_id: string; full_name: string; email: string; role: string; department: string | null;
  is_active: boolean; last_seen_at: string | null; pin_set_at: string | null;
  calls: number; cost_usd: number; input_tokens: number; cached_tokens: number; output_tokens: number;
  first_call: string | null; last_call: string | null;
}
interface Activity {
  user_id: string; planners: number; evaluations: number; reuses: number; shared: number; live_sessions: number;
}

/**
 * Everyone who can use LOTS AI, and what each of them has actually done.
 *
 * The left join in ai_usage_by_user is deliberate: a member of staff who has
 * never generated anything still has a row here. During a pilot the people who
 * are *not* using it are the more useful half of the list.
 */
export default async function People() {
  const [people, activity] = await Promise.all([
    fromView<Person>('ai_usage_by_user', { column: 'cost_usd' }),
    fromView<Activity>('user_activity'),
  ]);
  if (!people) return <p className="anotice">Run migration 0012 first.</p>;

  const act = Object.fromEntries((activity ?? []).map(a => [a.user_id, a]));
  const spend = people.reduce((t, p) => t + Number(p.cost_usd), 0);
  const dormant = people.filter(p => p.is_active && !p.last_seen_at).length;

  return (
    <>
      <h1>People</h1>
      <p className="anote awide">
        {people.length} accounts, {money(spend)} between them.
        {dormant > 0 && <> <b>{dormant}</b> have never signed in.</>}
        {' '}Anything recorded before sign-in was added names a seat rather than a person: until then
        everyone past the school password was the same seeded user, and the rail let them switch.
      </p>

      <table className="atable">
        <thead>
          <tr>
            <th>Name</th><th>Role</th><th>Last seen</th>
            <th className="r">Devices</th><th className="r">Planners</th><th className="r">Evaluations</th>
            <th className="r">Reuses</th><th className="r">Calls</th><th className="r">Spend</th>
          </tr>
        </thead>
        <tbody>
          {people.map(p => {
            const a = act[p.user_id];
            return (
              <tr key={p.user_id} className={p.is_active ? '' : 'off'}>
                <td>
                  <Link href={`/admin/people/${p.user_id}`}><b>{p.full_name}</b></Link>
                  <span className="anote">{p.email}</span>
                  {!p.pin_set_at && <span className="pill warn">no PIN set</span>}
                  {!p.is_active && <span className="pill">inactive</span>}
                </td>
                <td>{p.role}{p.department ? ` · ${p.department}` : ''}</td>
                <td>{when(p.last_seen_at)}</td>
                <td className="r num">{a?.live_sessions ?? 0}</td>
                <td className="r num">{a?.planners ?? 0}</td>
                <td className="r num">{a?.evaluations ?? 0}</td>
                <td className="r num">{a?.reuses ?? 0}</td>
                <td className="r num">{count(p.calls)}</td>
                <td className="r num">{money(p.cost_usd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
