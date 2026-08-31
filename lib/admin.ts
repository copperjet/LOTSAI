import { admin } from './supabase';

/**
 * Who may see /admin. It lives here rather than in the layout because a Next
 * layout may only export the framework's own names, and it is checked in two
 * places - the layout, for what is rendered, and /api/admin, for what is done.
 */
export const ADMIN_ROLES = ['admin', 'principal'];

/**
 * Reads for the admin dashboard.
 *
 * All of it comes from the views in migration 0012, so the aggregation happens
 * in Postgres and a page is a handful of small round trips rather than one
 * large download that gets slower every week.
 *
 * Every read is tolerant of a missing view, because migrations here are applied
 * by hand in the SQL editor (see CONTINUE_HERE.md) and a dashboard that white-
 * screens between deploying the code and pasting the SQL would be worse than
 * one that says the migration has not been run yet.
 */
export interface Overview { span: string; calls: number; cost_usd: number; input_tokens: number; cached_tokens: number }

export async function overview(): Promise<Overview[] | null> {
  const { data, error } = await admin().rpc('admin_overview');
  return error ? null : (data as Overview[]);
}

export async function fromView<T>(view: string, order?: { column: string; ascending?: boolean }, limit = 500):
  Promise<T[] | null> {
  let q = admin().from(view).select('*').limit(limit);
  if (order) q = q.order(order.column, { ascending: order.ascending ?? false, nullsFirst: false });
  const { data, error } = await q;
  return error ? null : (data as T[]);
}

/** $0.0031 is noise on a board slide and everything on a per-call line. */
export function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v === 0) return '$0';
  return v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function count(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso), mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  if (mins < 60 * 24 * 30) return `${Math.round(mins / (60 * 24))} d ago`;
  return then.toISOString().slice(0, 10);
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `${Math.round(Number(n) * 100)}%`;
}
