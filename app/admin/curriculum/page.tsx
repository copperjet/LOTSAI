import { admin } from '@/lib/supabase';
import { when, PROBLEM_SAYS } from '@/lib/admin';

export const dynamic = 'force-dynamic';

interface Gap {
  id: string; kind: string; year_group: string | null; subject: string | null;
  semester: number | null; detail: string; files: string[] | null;
  resolved_file: string | null; resolved_at: string | null;
  app_user: { full_name: string } | null;
}

/**
 * The decisions the importer will not make for itself.
 *
 * Two overview files claim the same subject, year and semester. The importer will not
 * guess which is current (Addendum C §C7), so it writes the pair down and stops -
 * and until now nothing in the product could write the answer back, so the row sat in
 * registry_gap being reported and never resolved.
 *
 * Recording a decision here does not rewrite the registry. scripts/ingest_overviews.py
 * reads these back and honours them on its next run, which is the honest order: the
 * files are the source, the import is what reads them, and a decision made in a web
 * page does not get to edit curriculum behind the import's back. The page says so
 * rather than leaving somebody waiting for weeks that will not appear.
 */
export default async function Curriculum({ searchParams }: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { e } = await searchParams;
  const db = admin();

  const { data } = await db.from('registry_gap')
    .select('id, kind, year_group, subject, semester, detail, files, resolved_file, resolved_at, app_user:resolved_by(full_name)')
    .eq('academic_year', '2026-27')
    .order('kind');

  const gaps = (data ?? []) as unknown as Gap[];
  const conflicts = gaps.filter(g => g.kind === 'conflict');
  const open = conflicts.filter(g => !g.resolved_file);
  const decided = conflicts.filter(g => g.resolved_file);
  const others = gaps.filter(g => g.kind !== 'conflict');

  return (
    <>
      <h1>Curriculum</h1>
      <p className="anote awide">
        {open.length
          ? <><b>{open.length}</b> conflict{open.length === 1 ? '' : 's'} waiting on a decision. Two files
              claim the same subject, year and semester; the import will not guess which is current.</>
          : <>Nothing is waiting on a decision.</>}
        {' '}A decision recorded here is honoured the next time the overviews are imported
        (<code>npm run ingest</code>). It does not change the registry on its own.
      </p>

      {e && <p className="aproblem">{PROBLEM_SAYS[e] ?? 'That did not work.'}</p>}

      <h2>Conflicts</h2>
      {!open.length ? <p className="anote">None outstanding.</p> : open.map(g => (
        <form key={g.id} className="aform" method="post" action="/api/admin"
              style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <input type="hidden" name="action" value="resolve_gap" />
          <input type="hidden" name="gapId" value={g.id} />
          <b>{[g.year_group, g.subject].filter(Boolean).join(' ') || 'Unplaced'}
            {g.semester ? ` · S${g.semester}` : ''}</b>
          <span className="anote">{g.detail}</span>
          <div className="afiles">
            {(g.files ?? []).map(f => (
              <label key={f}>
                <input type="radio" name="resolvedFile" value={f} required />
                <code>{f}</code>
              </label>
            ))}
          </div>
          <div><button type="submit">This one is current</button></div>
        </form>
      ))}

      {decided.length > 0 && (
        <>
          <h2>Decided</h2>
          <table className="atable">
            <thead><tr><th>Where</th><th>Current file</th><th>Decided by</th><th>When</th></tr></thead>
            <tbody>
              {decided.map(g => (
                <tr key={g.id}>
                  <td><b>{[g.year_group, g.subject].filter(Boolean).join(' ') || '—'}</b></td>
                  <td className="wrap"><code>{g.resolved_file}</code></td>
                  <td>{g.app_user?.full_name ?? '—'}</td>
                  <td>{when(g.resolved_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Could not be read or placed</h2>
      {!others.length ? <p className="anote">Every overview was read and placed.</p> : (
        <table className="atable">
          <thead><tr><th>Kind</th><th>Where</th><th>Why</th><th>Files</th></tr></thead>
          <tbody>
            {others.map(g => (
              <tr key={g.id}>
                <td><b>{g.kind}</b></td>
                <td>{[g.year_group, g.subject].filter(Boolean).join(' ') || '—'}</td>
                <td className="wrap">{g.detail}</td>
                <td className="wrap"><code>{(g.files ?? []).join(', ') || '—'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="anote awide">
        These need the file itself looked at, not a decision: a table the reader could not find, or a
        filename it could not place into a subject and year. Fix the file, then import again.
      </p>
    </>
  );
}
