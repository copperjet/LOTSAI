import { admin } from './supabase';

/**
 * Who may see /admin. It lives here rather than in the layout because a Next
 * layout may only export the framework's own names, and it is checked in two
 * places - the layout, for what is rendered, and /api/admin, for what is done.
 */
export const ADMIN_ROLES = ['admin', 'principal'];

/** Every role app_user.role may hold (the check constraint in migration 0001,
 *  widened by 0026). A role a form offers that the database refuses is a 500
 *  nobody can act on. */
export const ROLES = ['teacher', 'lead_teacher', 'hod', 'coordinator', 'principal', 'admin'];

/**
 * Who may review other people's work: sign the curriculum off, approve a study pack,
 * return a planner. A named authority over what the school publishes.
 */
export const REVIEWER_ROLES = ['hod', 'coordinator', 'principal', 'admin'];

/**
 * Who sees every class rather than only their own.
 *
 * Deliberately not the same list as REVIEWER_ROLES, and deliberately a wider one.
 * Seeing across the school is what a lead teacher needs in order to do the job;
 * signing the curriculum off on a head of department's behalf is not, and folding
 * the two together would have handed them the second in order to give them the first.
 *
 * Three routes used to test `role === 'hod'` on their own for this - plan/open,
 * document/view and search - and so refused the coordinators and principals that
 * every other check in the application accepts.
 */
export const ALL_CLASSES_ROLES = ['lead_teacher', ...REVIEWER_ROLES];

/** How a role reads on the page. The rail has its own copy for the same reason:
 *  app_user.role is a database value, and neither screen should print one. */
export const ROLE_SAYS: Record<string, string> = {
  teacher: 'Teacher', lead_teacher: 'Lead Teacher', hod: 'Head of Department',
  coordinator: 'Coordinator', principal: 'Principal', admin: 'Administrator',
};

/**
 * The school's own email domain.
 *
 * Checked where accounts are created, and deliberately not at sign-in. Two people
 * who work here are not on it - one teacher whose school address was never issued,
 * and the account migration 0021 names as the ICT head - and a gate at the door
 * would lock both out of an application they already use. An account only exists
 * because an administrator made it, so refusing the wrong domain at that point is
 * the same rule enforced where somebody can see what they are doing.
 */
export const SCHOOL_DOMAIN = 'lusakaoaktree.school';

/**
 * What went wrong with the last form, said plainly.
 *
 * The admin pages are server components with no JavaScript, so a refused action
 * comes back as ?e= on the URL and is read from there. Silence would be worse
 * than a message: a form that appears to work and did nothing is the one failure
 * an administrator cannot investigate.
 */
export const PROBLEM_SAYS: Record<string, string> = {
  missing: 'Something the form needed was blank.',
  bad_email: 'That does not look like an email address.',
  duplicate_email: 'Somebody already has that email address.',
  bad_role: 'That is not a role this school has.',
  not_school_email: `That is not an @${SCHOOL_DOMAIN} address. `
    + 'Tick "Allow an outside address" if this person genuinely has no school one.',
  too_many: 'That form carried more classes than the school has.',
  save: 'That did not save. Try again.',
  self_role: 'You cannot change your own role. Ask another administrator.',
};

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
