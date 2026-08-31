import { admin } from '@/lib/supabase';
import { when } from '@/lib/admin';

export const dynamic = 'force-dynamic';

interface Job { id: string; doc_type: string; doc_id: string; status: string; attempts: number; last_error: string | null; finished_at: string | null; created_at: string }
interface Gap { id: string; kind: string; year_group: string | null; subject: string | null; files: string[] | null; created_at: string }
interface Locked { id: string; full_name: string; failed_attempts: number; locked_until: string }

/**
 * Where the technical failures went.
 *
 * A teacher used to be shown `render_failed`, the Supabase Storage message
 * underneath it, and on a bad day a Google `token 401:`. None of that is
 * actionable by the person holding a class list, and all of it is actionable
 * here. The text is unabridged on purpose — this is the one screen where a
 * stack trace is the right answer.
 */
export default async function Health() {
  const db = admin();
  const [{ data: failed }, { data: gaps }, { data: locked }] = await Promise.all([
    db.from('pdf_jobs').select('id, doc_type, doc_id, status, attempts, last_error, finished_at, created_at')
      .eq('status', 'failed').order('created_at', { ascending: false }).limit(50),
    db.from('registry_gap').select('id, kind, year_group, subject, files, created_at')
      .order('created_at', { ascending: false }).limit(50),
    db.from('app_user').select('id, full_name, failed_attempts, locked_until')
      .gt('locked_until', new Date().toISOString()),
  ]);

  const jobs = (failed ?? []) as Job[];
  const problems = (gaps ?? []) as Gap[];
  const lockouts = (locked ?? []) as Locked[];

  return (
    <>
      <h1>Health</h1>

      <h2>Documents that failed to render</h2>
      {!jobs.length ? <p className="anote">Nothing has failed.</p> : (
        <table className="atable">
          <thead><tr><th>When</th><th>Kind</th><th className="r">Tries</th><th>Error</th></tr></thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.id}>
                <td>{when(j.finished_at ?? j.created_at)}</td>
                <td><b>{j.doc_type}</b><span className="anote">{j.doc_id}</span></td>
                <td className="r num">{j.attempts}</td>
                <td className="wrap"><code>{j.last_error ?? 'no message recorded'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Curriculum gaps</h2>
      {!problems.length ? <p className="anote">Every overview was read and placed.</p> : (
        <table className="atable">
          <thead><tr><th>When</th><th>Kind</th><th>Where</th><th>Files</th></tr></thead>
          <tbody>
            {problems.map(g => (
              <tr key={g.id}>
                <td>{when(g.created_at)}</td>
                <td><b>{g.kind}</b></td>
                <td>{[g.year_group, g.subject].filter(Boolean).join(' ') || '—'}</td>
                <td className="wrap"><code>{(g.files ?? []).join(', ') || '—'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Locked out</h2>
      {!lockouts.length ? <p className="anote">Nobody is locked out.</p> : (
        <table className="atable">
          <thead><tr><th>Name</th><th className="r">Wrong tries</th><th>Until</th></tr></thead>
          <tbody>
            {lockouts.map(l => (
              <tr key={l.id}>
                <td><b>{l.full_name}</b></td>
                <td className="r num">{l.failed_attempts}</td>
                <td>{new Date(l.locked_until).toLocaleTimeString('en-GB')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="anote awide">
        A lockout clears itself after fifteen minutes. If somebody has genuinely forgotten their PIN,
        clear it from their page under People — the next sign-in then chooses a new one.
      </p>
    </>
  );
}
