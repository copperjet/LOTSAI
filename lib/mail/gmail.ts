/**
 * Gmail, over REST.
 *
 * The same shape as lib/drive.ts — fetch, no SDK — with one thing drive.ts does not
 * need: a token per person rather than one for the server. `accessFor` is where that
 * lives. It reads the teacher's stored refresh token, decrypts it, trades it for an
 * access token, and keeps that in memory until shortly before it expires, so a
 * teacher clicking through ten messages costs one token call rather than ten.
 *
 * The cache is per process and deliberately not in the database: an access token is
 * worth an hour and is trivially re-minted, so writing one down is all cost.
 */
import { admin } from '@/lib/supabase';
import { open } from './crypto';
import { refreshAccess, mailMocked } from './oauth';
import { mockAccount, mockList, mockMessage } from './mocks';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface Account {
  email: string; connectedAt: string; scopes: string[]; lastSyncAt: string | null;
}

export interface Header {
  id: string; threadId: string;
  fromName: string; fromEmail: string;
  to: string[]; subject: string; snippet: string;
  receivedAt: string; unread: boolean; labels: string[];
}

export interface Full extends Header {
  body: string; messageIdHeader: string | null; references: string | null;
}

export interface Outgoing {
  to: string[]; cc?: string[]; subject: string; body: string;
  /** Set on a reply, so Gmail files it in the thread the teacher was reading. */
  threadId?: string; inReplyTo?: string | null; references?: string | null;
}

/** The teacher's connection, or null if they have not made one. */
export async function account(userId: string): Promise<Account | null> {
  if (mailMocked()) return mockAccount();
  const { data } = await admin().from('mail_account')
    .select('email, scopes, connected_at, last_sync_at')
    .eq('user_id', userId).is('revoked_at', null).maybeSingle();
  if (!data) return null;
  const a = data as { email: string; scopes: string[] | null; connected_at: string; last_sync_at: string | null };
  return { email: a.email, scopes: a.scopes ?? [], connectedAt: a.connected_at, lastSyncAt: a.last_sync_at };
}

const cache = new Map<string, { token: string; until: number }>();
const EARLY_MS = 60_000;   // re-mint a minute early rather than field a 401 mid-send

async function accessFor(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && hit.until > Date.now()) return hit.token;

  const { data } = await admin().from('mail_account')
    .select('refresh_token').eq('user_id', userId).is('revoked_at', null).maybeSingle();
  if (!data) throw new Error('no_mailbox');

  const t = await refreshAccess(open((data as { refresh_token: string }).refresh_token));
  cache.set(userId, { token: t.accessToken, until: Date.now() + t.expiresIn * 1000 - EARLY_MS });
  return t.accessToken;
}

/** Drop a cached token — after a disconnect, so a token in flight cannot outlive the row. */
export function forget(userId: string) { cache.delete(userId); }

async function api<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await accessFor(userId)}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`gmail ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------- reading

interface RawPart {
  mimeType?: string; filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: RawPart[];
}
interface RawMessage {
  id: string; threadId: string; snippet?: string; internalDate?: string;
  labelIds?: string[]; payload?: RawPart;
}

/**
 * A page of the mailbox.
 *
 * Gmail's list endpoint returns ids and nothing else, so each one is then fetched
 * with `format=metadata` — headers only, no body, no attachment bytes. That is a
 * request per message, which is why `max` is small and why triage is cached in
 * mail_message rather than re-run on every page load.
 */
export async function list(
  userId: string, opts: { q?: string; labelIds?: string[]; max?: number } = {},
): Promise<Header[]> {
  if (mailMocked()) return mockList(opts);

  const max = Math.min(opts.max ?? 25, 50);
  const q = new URLSearchParams({ maxResults: String(max) });
  if (opts.q) q.set('q', opts.q);
  for (const l of opts.labelIds ?? ['INBOX']) q.append('labelIds', l);

  const page = await api<{ messages?: { id: string }[] }>(userId, `/messages?${q}`);
  const ids = (page.messages ?? []).map(m => m.id);

  const wanted = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'References'];
  const hq = wanted.map(h => `metadataHeaders=${h}`).join('&');
  const got = await Promise.all(ids.map(id =>
    api<RawMessage>(userId, `/messages/${id}?format=metadata&${hq}`).catch(() => null)));

  return got.filter((m): m is RawMessage => !!m).map(header);
}

/** One message, body and all. Fetched only when a teacher opens it. */
export async function message(userId: string, id: string): Promise<Full> {
  if (mailMocked()) return mockMessage(id);
  const m = await api<RawMessage>(userId, `/messages/${id}?format=full`);
  return {
    ...header(m),
    body: bodyOf(m.payload),
    messageIdHeader: head(m, 'Message-ID'),
    references: head(m, 'References'),
  };
}

function head(m: RawMessage, name: string): string | null {
  const hit = (m.payload?.headers ?? []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : null;
}

function header(m: RawMessage): Header {
  const from = decodeWords(head(m, 'From') ?? '');
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const name = match ? match[1] : '';
  const addr = match ? match[2] : from.trim();
  return {
    id: m.id, threadId: m.threadId,
    fromName: name.trim() || addr.split('@')[0],
    fromEmail: addr.trim().toLowerCase(),
    to: decodeWords(head(m, 'To') ?? '').split(',').map(s => s.trim()).filter(Boolean),
    subject: decodeWords(head(m, 'Subject') ?? '') || '(no subject)',
    snippet: unescapeEntities(m.snippet ?? ''),
    receivedAt: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
    unread: (m.labelIds ?? []).includes('UNREAD'),
    labels: m.labelIds ?? [],
  };
}

/**
 * RFC 2047 encoded-words.
 *
 * A subject with an accent, a curly apostrophe or an em dash arrives as
 * `=?UTF-8?B?...?=` and shows on the screen exactly like that if nobody decodes it.
 * Several names on the staff list are enough to trigger it on their own.
 */
function decodeWords(s: string): string {
  return s
    .replace(/\?=[\s]+=\?/g, '?==?')   // adjacent encoded words are one string, not two
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_full, charset: string, enc: string, text: string) => {
        try {
          const bytes = enc.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
                  (_m, hx: string) => String.fromCharCode(parseInt(hx, 16))),
                'binary');
          return new TextDecoder(charset.toLowerCase()).decode(bytes);
        } catch { return text; }
      });
}

const ENTITY: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};
function unescapeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ENTITY[m] ?? m);
}

/**
 * The readable text of a message.
 *
 * Prefers text/plain, falls back to stripping the HTML part, and skips anything with
 * a filename — an attachment is not the message. Nested multiparts are walked,
 * because a reply sent from a phone is routinely multipart/alternative inside
 * multipart/mixed.
 */
function bodyOf(part: RawPart | undefined, depth = 0): string {
  if (!part || depth > 8) return '';
  if (part.filename) return '';

  const decode = (d?: string) => d ? Buffer.from(d, 'base64url').toString('utf8') : '';

  if (part.mimeType === 'text/plain') return decode(part.body?.data);
  if (part.mimeType === 'text/html') return stripHtml(decode(part.body?.data));

  for (const child of part.parts ?? []) {
    const plain = bodyOf(child, depth + 1);
    if (plain.trim()) return plain;
  }
  return decode(part.body?.data);
}

function stripHtml(html: string): string {
  return unescapeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- writing

/**
 * A message as the wire wants it: RFC 2822, base64url.
 *
 * The subject is encoded rather than sent raw, because a subject line is where the
 * accents are and a bare 8-bit byte in a header is not legal mail. The body goes out
 * as UTF-8 text with the charset declared, which is enough for a reply to a parent
 * and stops short of building HTML nobody asked for.
 */
export function mime(o: Outgoing, from: string): string {
  const ascii = (s: string) => /^[\x20-\x7E]*$/.test(s);
  const enc = (s: string) =>
    ascii(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

  const lines = [
    `From: ${from}`,
    `To: ${o.to.join(', ')}`,
    ...(o.cc?.length ? [`Cc: ${o.cc.join(', ')}`] : []),
    `Subject: ${enc(o.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    // Without these two a reply starts a new conversation in the recipient's client,
    // however carefully Gmail files it in ours.
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    '',
    o.body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export interface Written { id: string; threadId?: string; mock: boolean }

/** A draft. Sits in the teacher's own Gmail Drafts, unsent, until a person sends it. */
export async function draft(userId: string, o: Outgoing, from: string): Promise<Written> {
  if (mailMocked()) {
    return { id: 'mock_draft_' + Date.now().toString(36), threadId: o.threadId, mock: true };
  }
  const r = await api<{ id: string; message?: { threadId: string } }>(userId, '/drafts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { raw: mime(o, from), ...(o.threadId ? { threadId: o.threadId } : {}) },
    }),
  });
  return { id: r.id, threadId: r.message?.threadId ?? o.threadId, mock: false };
}

/** Send. Only ever called from a route that has a person's approval on the record. */
export async function send(userId: string, o: Outgoing, from: string): Promise<Written> {
  if (mailMocked()) {
    return { id: 'mock_sent_' + Date.now().toString(36), threadId: o.threadId, mock: true };
  }
  const r = await api<{ id: string; threadId: string }>(userId, '/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw: mime(o, from), ...(o.threadId ? { threadId: o.threadId } : {}) }),
  });
  return { id: r.id, threadId: r.threadId, mock: false };
}

/**
 * Label, archive, mark read — all one Gmail call.
 *
 * Archiving is removing INBOX, not deleting: the message stays in All Mail and the
 * teacher can undo it from Gmail. Nothing here can permanently delete a message, and
 * the scope granted could not do it if it tried.
 */
export async function organise(
  userId: string, ids: string[], change: { add?: string[]; remove?: string[] },
): Promise<number> {
  if (!ids.length) return 0;
  if (mailMocked()) return ids.length;
  await api(userId, '/messages/batchModify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] }),
  });
  return ids.length;
}

/** The labels this mailbox already has, so the UI offers real ones. */
export async function labels(userId: string): Promise<{ id: string; name: string }[]> {
  if (mailMocked()) return [{ id: 'Label_parents', name: 'Parents' }, { id: 'Label_admin', name: 'Admin' }];
  const r = await api<{ labels?: { id: string; name: string; type: string }[] }>(userId, '/labels');
  return (r.labels ?? []).filter(l => l.type === 'user').map(l => ({ id: l.id, name: l.name }));
}

/** Create a label on demand, so "file this under Parents" works the first time. */
export async function ensureLabel(userId: string, name: string): Promise<string> {
  if (mailMocked()) return 'Label_' + name.toLowerCase().replace(/\W+/g, '_');
  const found = (await labels(userId)).find(l => l.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const r = await api<{ id: string }>(userId, '/labels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  });
  return r.id;
}
