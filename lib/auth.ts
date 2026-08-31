/**
 * Personal sign-in: a PIN per member of staff, behind the shared school
 * password.
 *
 * Web Crypto only, so this runs unchanged on the edge and in a route handler,
 * and adds no dependency — the same discipline as lib/sitegate.ts. bcrypt and
 * argon2 are both better password hashes than PBKDF2 and both are native
 * modules; on Vercel's edge runtime neither is available, and a native module
 * that only loads in one of two runtimes is a worse problem than a slightly
 * older KDF.
 *
 * A four-digit PIN is weak on its own and is not asked to stand on its own.
 * Three things carry it:
 *
 *   1. the school password in front of it, so the PIN is never the first door
 *   2. lockout after LOCK_AFTER wrong tries, which is what actually stops
 *      guessing when the keyspace is 10,000
 *   3. a session token with real entropy, so the PIN is used once per device
 *      per month rather than on every request
 */

export const SESSION_COOKIE = 'lots_session';
export const SESSION_DAYS = 30;

export const PIN_MIN = 4;
export const PIN_MAX = 8;
export const LOCK_AFTER = 5;
export const LOCK_MINUTES = 15;

const ITERATIONS = 120_000;

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

async function derive(pin: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256' },
    key, 256);
  return hex(bits);
}

/** `pbkdf2$iterations$salt$hash` — self-describing, so the cost can be raised later. */
export async function hashPin(pin: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  return `pbkdf2$${ITERATIONS}$${salt}$${await derive(pin, salt, ITERATIONS)}`;
}

/** Length-independent comparison, so a near-miss takes as long as a wild guess. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterations, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterations || !salt || !hash) return false;
  return same(await derive(pin, salt, Number(iterations)), hash);
}

/** Digits only, so it can be typed on a phone keypad and said over a desk. */
export function pinShape(pin: string): string | null {
  if (!/^[0-9]+$/.test(pin)) return `Your PIN is numbers only.`;
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) {
    return `Your PIN needs to be between ${PIN_MIN} and ${PIN_MAX} numbers.`;
  }
  return null;
}

/**
 * The cookie value, and the digest that goes in the table. Only the digest is
 * ever stored, so nothing in the database can be replayed as a session.
 */
export function newSessionToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export async function sessionDigest(token: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}
