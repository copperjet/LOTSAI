/**
 * Encryption for the one secret in this application that is not ours.
 *
 * A Google refresh token does not expire, is not scoped to a session, and opens
 * the mailbox on its own. Everything else stored here is the school's own work;
 * this is a key to a teacher's private correspondence, held on their behalf. So
 * it is encrypted at rest, which means the service-role key and a database dump
 * are two separate losses rather than one.
 *
 * AES-256-GCM, from node:crypto — authenticated, so a tampered ciphertext fails
 * loudly instead of decrypting to rubbish. The stored form is `iv || tag || data`
 * in one bytea column: no separate columns to keep in step, and no way to store
 * half of it.
 *
 * MAIL_TOKEN_KEY is 32 bytes, base64. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * Losing it does not lose a mailbox — it means every teacher reconnects.
 */
import crypto from 'node:crypto';

const IV_BYTES = 12;   // GCM's own size; anything else is a misuse
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = process.env.MAIL_TOKEN_KEY;
  if (!raw) throw new Error('MAIL_TOKEN_KEY is not set — mail cannot store a token safely.');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error(`MAIL_TOKEN_KEY must be 32 bytes of base64, got ${k.length}.`);
  return k;
}

/** True when a token could be stored right now. Lets a route say so rather than throw. */
export function canStoreTokens(): boolean {
  try { key(); return true; } catch { return false; }
}

export function seal(plaintext: string): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}

export function open(sealed: Buffer | Uint8Array | string): string {
  // Supabase hands bytea back as `\x…` hex over PostgREST, and as a Buffer over a
  // direct driver. Both arrive here, so both are accepted rather than guessed at
  // by the caller.
  const buf = typeof sealed === 'string'
    ? Buffer.from(sealed.startsWith('\\x') ? sealed.slice(2) : sealed, 'hex')
    : Buffer.from(sealed);

  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = buf.subarray(IV_BYTES + TAG_BYTES);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** What goes into a bytea column over PostgREST. */
export function toHex(b: Buffer): string {
  return '\\x' + b.toString('hex');
}
