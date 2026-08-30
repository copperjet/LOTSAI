import { cookies } from 'next/headers';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Two clients, deliberately separate.
 *
 * `admin()` bypasses row level security and is only ever constructed inside
 * route handlers and scripts. It must never be imported into a client component.
 * `anon()` is what a browser session would use, with RLS enforcing the
 * visibility rules in Addendum A section A8.
 */

let _admin: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (!_admin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase env vars missing — copy .env.local.example to .env.local');
    _admin = createClient(url, key, { auth: { persistSession: false } });
  }
  return _admin;
}

export function anon(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/** The cookie the demo user switcher writes. Dies with SSO, like the rest of this. */
export const DEMO_COOKIE = 'lots_demo_user';

/**
 * Until Google Workspace SSO is switched on, the signed-in user comes from
 * DEMO_USER_EMAIL, or from whoever the rail's switcher last chose. Swapping
 * this for the Supabase session is the whole of the auth work — every route
 * already calls it rather than trusting input.
 *
 * The switcher is a demo affordance, not a permission model: everyone past the
 * site password is already the same person, so being able to look at the HOD's
 * side of the app takes nothing away that was being protected. It goes when
 * sign-in arrives.
 */
export async function currentUser(emailOverride?: string) {
  let chosen: string | undefined;
  if (!emailOverride) {
    try { chosen = (await cookies()).get(DEMO_COOKIE)?.value; } catch { /* outside a request */ }
  }
  const email = emailOverride ?? chosen ?? process.env.DEMO_USER_EMAIL;
  const { data, error } = await admin()
    .from('app_user').select('*').eq('email', email).single();
  if (error) throw new Error(`No app_user for ${email}. Run npm run seed.`);
  return data as { id: string; email: string; full_name: string; role: string; department: string | null };
}

export async function audit(actorId: string, action: string, entityType?: string, entityId?: string, detail?: unknown) {
  await admin().from('audit_log').insert({
    actor_id: actorId, action, entity_type: entityType ?? null,
    entity_id: entityId ?? null, detail: detail ?? null,
  });
}
