/**
 * The Google consent round trip, per teacher.
 *
 * No SDK, for the reason lib/drive.ts gives: this is three form posts and a
 * redirect, and googleapis is a large dependency to carry into a serverless
 * bundle for that. `fetch` and node:crypto do it.
 *
 * The scopes are the smallest set that does what was asked of it:
 *
 *   gmail.modify  — read, label, archive, mark read, and create drafts. It cannot
 *                   permanently delete, and it cannot send.
 *   gmail.send    — send. Separate from modify in Google's model, and worth keeping
 *                   separate here too: it is the only scope that puts words in the
 *                   school's name in front of a parent.
 *   userinfo.email — so the connection can be shown as "connected as x@…". A teacher
 *                   with two Google accounts open in one browser will otherwise
 *                   connect the wrong one and never find out.
 *
 * There is deliberately no gmail.settings scope. Filters, forwarding addresses and
 * auto-replies are standing rules that outlive any conversation with LOTS AI, and
 * nothing here has a reason to write one.
 */
import crypto from 'node:crypto';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

/** Faked when asked, or whenever the OAuth client has not been created yet. */
export function mailMocked(): boolean {
  return process.env.MOCK_MAIL === '1'
    || !process.env.GOOGLE_OAUTH_CLIENT_ID
    || !process.env.GOOGLE_OAUTH_CLIENT_SECRET;
}

export function redirectUri(origin: string): string {
  return process.env.GOOGLE_OAUTH_REDIRECT || `${origin}/api/mail/callback`;
}

/**
 * `state`, signed.
 *
 * The callback arrives as a plain GET from Google with whatever query string the
 * browser was handed, so the only thing tying it to the person who started the
 * flow is this value. Signed with the same secret that protects nothing else, it
 * carries the user id and an expiry, and a forged or stale one is refused before a
 * token is ever requested. This is the CSRF defence for the whole connect path.
 */
function stateSecret(): string {
  return process.env.MAIL_TOKEN_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-only';
}

const STATE_MINUTES = 10;

export function signState(userId: string): string {
  const body = Buffer.from(JSON.stringify({
    u: userId, x: Date.now() + STATE_MINUTES * 60_000, n: crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const mac = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readState(state: string): { userId: string } | null {
  const [body, mac] = String(state ?? '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  // Constant time: a comparison that returns early leaks the signature a byte at a time.
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, x } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof u !== 'string' || typeof x !== 'number' || x < Date.now()) return null;
    return { userId: u };
  } catch { return null; }
}

export function consentUrl(origin: string, state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    // Without both of these Google returns a refresh token on the first consent and
    // never again, so a teacher who reconnects gets an account that works for an hour.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export interface Tokens {
  accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[];
}

export async function exchangeCode(code: string, origin: string): Promise<Tokens> {
  return token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(origin),
  });
}

export async function refreshAccess(refreshToken: string): Promise<Tokens> {
  return token({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function token(fields: Record<string, string>): Promise<Tokens> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      ...fields,
    }),
  });
  if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
  const j = await res.json() as {
    access_token: string; refresh_token?: string; expires_in: number; scope?: string;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresIn: j.expires_in,
    scopes: (j.scope ?? '').split(' ').filter(Boolean),
  };
}

/** Which account this actually is. Asked once, at connect time. */
export async function whoami(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo ${res.status}: ${await res.text()}`);
  return (await res.json() as { email: string }).email;
}

/**
 * Hand the grant back.
 *
 * Disconnecting has to do this, not just delete our row. A token we have forgotten
 * but Google still honours is worse than one we hold: it is live, and nobody is
 * watching it. Best effort — if Google refuses, the row still goes, and the teacher
 * is told to remove the app from their Google account themselves.
 */
export async function revoke(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
    return res.ok;
  } catch { return false; }
}
