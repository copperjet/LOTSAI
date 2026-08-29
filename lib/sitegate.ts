/**
 * The shared-password gate.
 *
 * v1 has no login: `currentUser()` reads DEMO_USER_EMAIL, so every visitor is
 * signed in as the same person. That is fine on a laptop and not fine on a
 * public URL, so one shared password stands in front of the whole site until
 * Google Workspace SSO is switched on — at which point this file and
 * `middleware.ts` are deleted, and nothing else changes.
 *
 * Edge-safe: Web Crypto only, no Node built-ins, no dependencies.
 */

/** The cookie the browser carries once the password has been accepted. */
export const GATE_COOKIE = 'lots_gate';

/**
 * What goes in the cookie: a digest of the password, never the password. Anyone
 * holding the cookie already knows the password, so this protects the value in
 * transit and in the browser store, nothing more. It is not a session token and
 * is not an identity.
 */
export async function gateToken(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`lots-ai:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent comparison, so a wrong guess takes the same time as a right one. */
export function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
