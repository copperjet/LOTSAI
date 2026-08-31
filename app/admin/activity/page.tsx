import Link from 'next/link';
import { admin } from '@/lib/supabase';
import { when } from '@/lib/admin';

export const dynamic = 'force-dynamic';

interface Row {
  id: string; action: string; entity_type: string | null; entity_id: string | null;
  created_at: string; actor_id: string | null;
  app_user: { full_name: string } | null;
}

const PAGE = 200;

/**
 * The audit log, which has been written since migration 0001 and read by
 * nothing until now.
 */
export default async function Activity({ searchParams }: {
  searchParams: Promise<{ action?: string }>;
}) {
  const { action } = await searchParams;
  const db = admin();

  let q = db.from('audit_log')
    .select('id, action, entity_type, entity_id, created_at, actor_id, app_user:actor_id(full_name)')
    .order('created_at', { ascending: false }).limit(PAGE);
  if (action) q = q.eq('action', action);
  const { data } = await q;
  const rows = (data ?? []) as unknown as Row[];

  const kinds = [...new Set(rows.map(r => r.action))].sort();

  return (
    <>
      <h1>Activity</h1>
      <div className="achips">
        <Link href="/admin/activity" className={action ? '' : 'on'}>Everything</Link>
        {kinds.map(k => (
          <Link key={k} href={`/admin/activity?action=${encodeURIComponent(k)}`}
                className={action === k ? 'on' : ''}>{k}</Link>
        ))}
      </div>

      {!rows.length ? <p className="anote">Nothing recorded{action ? ` for ${action}` : ''}.</p> : (
        <table className="atable">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{when(r.created_at)}</td>
                <td>{r.actor_id
                  ? <Link href={`/admin/people/${r.actor_id}`}>{r.app_user?.full_name ?? 'unknown'}</Link>
                  : 'system'}</td>
                <td><b>{r.action}</b></td>
                <td className="wrap">{r.entity_type ? `${r.entity_type} ${r.entity_id ?? ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="anote">
        The most recent {PAGE}. The filters above are built from what is on this page, so a kind of
        event that has not happened lately does not appear.
      </p>
    </>
  );
}
