import { notFound } from 'next/navigation';
import { admin, currentUser } from '@/lib/supabase';
import { money, when, ROLES, ROLE_SAYS, PROBLEM_SAYS } from '@/lib/admin';

export const dynamic = 'force-dynamic';

interface Session {
  id: string; user_agent: string | null; created_at: string; last_seen_at: string; expires_at: string;
}
interface Call {
  id: string; workflow: string; model: string; provider: string;
  cost_usd: number; latency_ms: number | null; created_at: string;
}
interface Entry {
  id: string; action: string; entity_type: string | null; entity_id: string | null; created_at: string;
}

const RECENT = 50;

export default async function Person({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ e?: string }>;
}) {
  const { id } = await params;
  const { e } = await searchParams;
  const db = admin();
  const me = await currentUser();

  const { data: person } = await db.from('app_user')
    .select('id, full_name, email, role, department, is_active, last_seen_at, pin_set_at, locked_until')
    .eq('id', id).maybeSingle();
  if (!person) notFound();

  const [{ data: sessions }, { data: calls }, { data: log }] = await Promise.all([
    db.from('user_session').select('id, user_agent, created_at, last_seen_at, expires_at')
      .eq('user_id', id).order('last_seen_at', { ascending: false }),
    db.from('ai_usage').select('id, workflow, model, provider, cost_usd, latency_ms, created_at')
      .eq('user_id', id).order('created_at', { ascending: false }).limit(RECENT),
    db.from('audit_log').select('id, action, entity_type, entity_id, created_at')
      .eq('actor_id', id).order('created_at', { ascending: false }).limit(RECENT),
  ]);

  const locked = person.locked_until && new Date(person.locked_until) > new Date();

  return (
    <>
      <h1>{person.full_name}</h1>
      {e && <p className="aproblem">{PROBLEM_SAYS[e] ?? 'That did not work.'}</p>}
      <p className="anote awide">
        {person.email} · {ROLE_SAYS[person.role] ?? person.role}{person.department ? ` · ${person.department}` : ''} ·
        last seen {when(person.last_seen_at)} ·
        {person.pin_set_at ? ` PIN set ${when(person.pin_set_at)}` : ' no PIN set yet'}
        {locked ? <> · <b className="bad">locked out until {new Date(person.locked_until as string).toLocaleTimeString('en-GB')}</b></> : null}
      </p>

      {/* A role decides what somebody is shown and what they may sign off, so it is
          changed here rather than in the database. Never your own: an administrator
          who can demote themselves can lock the school out of this page by accident,
          and the route refuses it even if this form is bypassed. */}
      <h2>Role and department</h2>
      <form className="aform" method="post" action="/api/admin">
        <input type="hidden" name="action" value="set_role" />
        <input type="hidden" name="userId" value={person.id} />
        <label className="afield">
          <span>Role</span>
          <select name="role" defaultValue={person.role} disabled={me.id === person.id}>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_SAYS[r]}</option>)}
          </select>
        </label>
        <button type="submit" disabled={me.id === person.id}>Change the role</button>
        {me.id === person.id && <span className="anote">You cannot change your own role.</span>}
      </form>
      <form className="aform" method="post" action="/api/admin">
        <input type="hidden" name="action" value="set_department" />
        <input type="hidden" name="userId" value={person.id} />
        <label className="afield">
          <span>Department</span>
          <input name="department" defaultValue={person.department ?? ''} placeholder="Primary" />
        </label>
        <button type="submit">Save the department</button>
      </form>

      <h2>Devices</h2>
      {!sessions?.length ? <p className="anote">No signed-in devices.</p> : (
        <table className="atable">
          <thead><tr><th>Device</th><th>Signed in</th><th>Last used</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {(sessions as Session[]).map(s => (
              <tr key={s.id}>
                <td className="wrap">{s.user_agent || 'unknown'}</td>
                <td>{when(s.created_at)}</td>
                <td>{when(s.last_seen_at)}</td>
                <td>{new Date(s.expires_at).toISOString().slice(0, 10)}</td>
                <td className="r">
                  <form method="post" action="/api/admin">
                    <input type="hidden" name="action" value="revoke_session" />
                    <input type="hidden" name="sessionId" value={s.id} />
                    <input type="hidden" name="userId" value={person.id} />
                    <button className="quiet" type="submit">Revoke</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* A PIN is a thing people forget over a holiday. Clearing it makes the
          next sign-in choose a new one; it never reveals or sets one for them.
          Unlocking is the smaller version of the same favour: it clears the
          fifteen minute lockout without touching the PIN they still know.
          Deactivating is missing for yourself on purpose — locking the last
          administrator out of the dashboard is not a mistake worth allowing. */}
      <div className="arow">
        <form method="post" action="/api/admin">
          <input type="hidden" name="action" value="reset_pin" />
          <input type="hidden" name="userId" value={person.id} />
          <button className="quiet" type="submit">Clear the PIN</button>
        </form>
        {locked && (
          <form method="post" action="/api/admin">
            <input type="hidden" name="action" value="unlock" />
            <input type="hidden" name="userId" value={person.id} />
            <button className="quiet" type="submit">Unlock them now</button>
          </form>
        )}
        {me.id !== person.id && (
          <form method="post" action="/api/admin">
            <input type="hidden" name="action" value={person.is_active ? 'deactivate' : 'reactivate'} />
            <input type="hidden" name="userId" value={person.id} />
            <button className="quiet" type="submit">
              {person.is_active ? 'Deactivate this account' : 'Reactivate this account'}
            </button>
          </form>
        )}
      </div>

      <h2>Recent calls</h2>
      {!calls?.length ? <p className="anote">No model calls recorded.</p> : (
        <table className="atable">
          <thead>
            <tr><th>When</th><th>Workflow</th><th>Model</th><th className="r">Latency</th><th className="r">Cost</th></tr>
          </thead>
          <tbody>
            {(calls as Call[]).map(c => (
              <tr key={c.id}>
                <td>{when(c.created_at)}</td>
                <td><b>{c.workflow}</b></td>
                <td>{c.provider}/{c.model}</td>
                <td className="r num">{c.latency_ms ? `${c.latency_ms} ms` : '—'}</td>
                <td className="r num">{money(c.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Activity</h2>
      {!log?.length ? <p className="anote">Nothing recorded.</p> : (
        <table className="atable">
          <thead><tr><th>When</th><th>Action</th><th>On</th></tr></thead>
          <tbody>
            {(log as Entry[]).map(e => (
              <tr key={e.id}>
                <td>{when(e.created_at)}</td>
                <td><b>{e.action}</b></td>
                <td className="wrap">{e.entity_type ? `${e.entity_type} ${e.entity_id ?? ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="anote">The last {RECENT} of each.</p>
    </>
  );
}
