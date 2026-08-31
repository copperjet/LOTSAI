import { overview, fromView, money, count, when, pct, Overview } from '@/lib/admin';
import { admin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface ByWorkflow {
  workflow: string; calls: number; cost_usd: number;
  input_tokens: number; cached_tokens: number; output_tokens: number;
  cache_ratio: number | null; p50_ms: number | null; p90_ms: number | null; last_call: string | null;
}
interface ByModel {
  provider: string; model: string; calls: number; cost_usd: number;
  input_tokens: number; cached_tokens: number; output_tokens: number;
}

/** The Addendum D8 working assumption, so the meter is read against something. */
const MONTHLY_ASSUMPTION = 15;
const SEATS_COMPARISON = 320;   // sixteen ChatGPT Plus seats

const SPANS: Record<string, string> = {
  today: 'Today', week: 'Last 7 days', month: 'Last 30 days', all: 'All time',
};

export default async function AdminOverview() {
  const [head, workflows, models] = await Promise.all([
    overview(),
    fromView<ByWorkflow>('ai_usage_by_workflow', { column: 'cost_usd' }),
    fromView<ByModel>('ai_usage_by_model', { column: 'cost_usd' }),
  ]);

  if (!head || !workflows) return <Missing />;

  const by = Object.fromEntries(head.map(h => [h.span, h])) as Record<string, Overview>;
  const month = by.month?.cost_usd ?? 0;
  const worst = Math.max(...workflows.map(w => Number(w.cost_usd)), 0.000001);
  const reuse = await reuseRate();

  return (
    <>
      <h1>Spend</h1>
      <div className="acards">
        {['today', 'week', 'month', 'all'].map(k => (
          <div className="acard" key={k}>
            <span className="alabel">{SPANS[k]}</span>
            <b className="num">{money(by[k]?.cost_usd)}</b>
            <span className="anote">{count(by[k]?.calls)} calls</span>
          </div>
        ))}
      </div>

      <p className="anote awide">
        The working assumption is under <b>${MONTHLY_ASSUMPTION} a month</b> in model spend for the whole
        primary section (Addendum D8). Last 30 days: <b className="num">{money(month)}</b>
        {month > MONTHLY_ASSUMPTION
          ? <> — <b className="bad">over the assumption</b>, so the estimate needs correcting, not the meter.</>
          : <> — inside it.</>}
        {' '}Sixteen ChatGPT Plus seats would be about ${SEATS_COMPARISON} a month for the same people.
        Model spend is not the cost of this system; hosting and developer time are. Quote all three.
      </p>

      <h2>By workflow</h2>
      <table className="atable">
        <thead>
          <tr>
            <th>Workflow</th><th className="r">Calls</th><th className="r">Spend</th>
            <th className="r">Cache hits</th><th className="r">p50</th><th className="r">p90</th>
            <th className="r">Last</th>
          </tr>
        </thead>
        <tbody>
          {workflows.map(w => (
            <tr key={w.workflow}>
              <td>
                <b>{w.workflow}</b>
                <span className="bar"><i style={{ width: `${(Number(w.cost_usd) / worst) * 100}%` }} /></span>
              </td>
              <td className="r num">{count(w.calls)}</td>
              <td className="r num">{money(w.cost_usd)}</td>
              <td className={`r num ${zeroCache(w) ? 'bad' : ''}`}>{pct(w.cache_ratio)}</td>
              <td className="r num">{ms(w.p50_ms)}</td>
              <td className="r num">{ms(w.p90_ms)}</td>
              <td className="r">{when(w.last_call)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {workflows.some(zeroCache) && (
        <p className="anote awide bad">
          A workflow reading no cached tokens across repeated calls means its prompt prefix is being
          invalidated — something volatile has moved in front of the breakpoint. Cache reads cost about
          a tenth of base input, so this is the single largest correctable line above.
        </p>
      )}

      <h2>By model</h2>
      <table className="atable">
        <thead>
          <tr>
            <th>Provider</th><th>Model</th><th className="r">Calls</th><th className="r">Spend</th>
            <th className="r">In</th><th className="r">Cached</th><th className="r">Out</th>
          </tr>
        </thead>
        <tbody>
          {(models ?? []).map(m => (
            <tr key={`${m.provider}/${m.model}`}>
              <td>{m.provider}</td>
              <td><b>{m.model}</b></td>
              <td className="r num">{count(m.calls)}</td>
              <td className="r num">{money(m.cost_usd)}</td>
              <td className="r num">{count(m.input_tokens)}</td>
              <td className="r num">{count(m.cached_tokens)}</td>
              <td className="r num">{count(m.output_tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Reuse</h2>
      <p className="anote awide">
        {reuse === null
          ? 'No generations recorded yet.'
          : <>
              <b className="num">{pct(reuse.rate)}</b> of demand was met from the bank rather than by
              generating ({count(reuse.reuses)} reuses against {count(reuse.generations)} generations).
              Addendum B assumes roughly 60% at steady state, and this is the largest cost lever there
              is — it costs nothing to run.
            </>}
      </p>
    </>
  );
}

const zeroCache = (w: ByWorkflow) => w.calls > 3 && Number(w.cached_tokens) === 0;
const ms = (n: number | null) => (n === null || n === undefined ? '—' : `${Math.round(Number(n))} ms`);

/** Counted here rather than in a view: it spans two tables that share no key. */
async function reuseRate() {
  const db = admin();
  const [{ count: reuses }, { count: generations }] = await Promise.all([
    db.from('reuse_event').select('*', { count: 'exact', head: true }),
    db.from('ai_usage').select('*', { count: 'exact', head: true }),
  ]);
  const r = reuses ?? 0, g = generations ?? 0;
  if (r + g === 0) return null;
  return { reuses: r, generations: g, rate: r / (r + g) };
}

function Missing() {
  return (
    <div className="anotice">
      <h1>Migration 0012 has not been run</h1>
      <p>
        The dashboard reads the views in <code>supabase/migrations/0012_admin_views.sql</code>.
        Paste that file into the Supabase SQL editor — DDL is applied by hand on this project — and
        reload. Nothing else is affected in the meantime; <code>ai_usage</code> is still being written
        on every call.
      </p>
    </div>
  );
}
