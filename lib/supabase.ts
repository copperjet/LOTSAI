import { cookies } from 'next/headers';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SESSION_COOKIE, sessionDigest } from './auth';

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

/** Thrown when the cookie is gone, forged, expired or revoked. Callers turn
 *  it into a 401 and the browser goes back to /signin. */
export const NOT_SIGNED_IN = 'not_signed_in';

export interface AppUser {
  id: string; email: string; full_name: string; role: string; department: string | null;
}

/** How often a session bumps its last-seen. Every request would be a write per page. */
const SEEN_EVERY_MS = 5 * 60 * 1000;

/**
 * The signed-in user, from the session cookie set by /api/signin.
 *
 * Every route calls this rather than trusting anything in the request, which is
 * why sign-in could be added without touching them. It replaces the demo
 * switcher: until migration 0011 there was no identity at all — DEMO_USER_EMAIL
 * named everybody, and anyone could become anybody — so nothing recorded before
 * it should be read as the act of a particular person.
 *
 * DEMO_USER_EMAIL survives for local work and for `npm run seed`, and only
 * outside production. In production a request with no valid session is not a
 * user, and the middleware has already sent it to the door.
 */
export async function currentUser(emailOverride?: string): Promise<AppUser> {
  const db = admin();

  if (!emailOverride) {
    let token: string | undefined;
    try { token = (await cookies()).get(SESSION_COOKIE)?.value; } catch { /* outside a request */ }

    if (token) {
      const { data } = await db.from('user_session')
        .select('id, expires_at, last_seen_at, app_user!inner(*)')
        .eq('token_hash', await sessionDigest(token))
        .maybeSingle();

      const row = data as unknown as {
        id: string; expires_at: string; last_seen_at: string; app_user: AppUser & { is_active?: boolean };
      } | null;

      if (row && new Date(row.expires_at) > new Date()) {
        if (row.app_user.is_active === false) throw new Error('This account is no longer active.');
        await touch(db, row.id, row.last_seen_at, row.app_user.id);
        return row.app_user as AppUser;
      }
    }
  }

  const email = emailOverride ?? process.env.DEMO_USER_EMAIL;
  if (!email || process.env.NODE_ENV === 'production') throw new Error(NOT_SIGNED_IN);

  const { data, error } = await db.from('app_user').select('*').eq('email', email).single();
  if (error) throw new Error(`No app_user for ${email}. Run npm run seed.`);
  return data as AppUser;
}

/** Best-effort, and throttled: a busy afternoon should not be a write per request. */
async function touch(db: SupabaseClient, sessionId: string, lastSeen: string, userId: string) {
  if (Date.now() - new Date(lastSeen).getTime() < SEEN_EVERY_MS) return;
  const now = new Date().toISOString();
  try {
    await db.from('user_session').update({ last_seen_at: now }).eq('id', sessionId);
    await db.from('app_user').update({ last_seen_at: now }).eq('id', userId);
  } catch { /* never fail a page over a timestamp */ }
}

export async function audit(actorId: string, action: string, entityType?: string, entityId?: string, detail?: unknown) {
  await admin().from('audit_log').insert({
    actor_id: actorId, action, entity_type: entityType ?? null,
    entity_id: entityId ?? null, detail: detail ?? null,
  });
}
