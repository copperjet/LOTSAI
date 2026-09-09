import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit, NOT_SIGNED_IN } from '@/lib/supabase';
import * as gmail from '@/lib/mail/gmail';
import { triage, compose } from '@/lib/mail/triage';
import { mailMocked, revoke } from '@/lib/mail/oauth';
import { open } from '@/lib/mail/crypto';

export const runtime = 'nodejs';

/**
 * GET  /api/mail            — the inbox, triaged
 * GET  /api/mail?id=…       — one message, in full
 * POST /api/mail            — { action: draft | reply | send | organise | disconnect }
 *
 * One handler with an action, the shape /api/school-fact already uses, because these
 * are five verbs against one mailbox and five files would only spread the same
 * authorisation check across five places to forget it in.
 *
 * WHO CAN TOUCH WHAT: every path takes the user from the session cookie and passes
 * that id to lib/mail/gmail.ts, which looks up that person's token. There is no
 * parameter naming a mailbox, so there is no request that reaches somebody else's.
 *
 * WHAT SENDS: only `send`, only with `approve: true` in the body, and only with the
 * exact text the teacher had on screen. `draft` and `reply` write to Gmail Drafts and
 * stop. Nothing in this file sends anything as a consequence of anything a message
 * said — that is the whole argument of lib/mail/triage.ts, and this is where it has
 * to hold.
 */

const MAX_BODY = 20_000;
const MAX_RECIPIENTS = 20;

export async function GET(req: NextRequest) {
  let user;
  try { user = await currentUser(); } catch { return NextResponse.json({ error: NOT_SIGNED_IN }, { status: 401 }); }

  const account = await gmail.account(user.id);
  if (!account) return NextResponse.json({ connected: false, mock: mailMocked(), messages: [] });

  const id = req.nextUrl.searchParams.get('id');

  try {
    if (id) {
      const msg = await gmail.message(user.id, id);
      const verdict = (await triage(user.id, [msg])).get(msg.id) ?? null;
      // Opening a message is reading it, and Gmail should agree. Best effort: the
      // message is already on the screen and a failed label change must not hide it.
      gmail.organise(user.id, [msg.id], { remove: ['UNREAD'] }).catch(() => {});
      return NextResponse.json({ connected: true, mock: mailMocked(), account, message: msg, verdict });
    }

    const q = req.nextUrl.searchParams.get('q') ?? undefined;
    const box = req.nextUrl.searchParams.get('box') ?? 'INBOX';
    const headers = await gmail.list(user.id, { q, labelIds: box === 'all' ? [] : [box], max: 25 });
    const verdicts = await triage(user.id, headers);

    await admin().from('mail_account')
      .update({ last_sync_at: new Date().toISOString() }).eq('user_id', user.id);

    return NextResponse.json({
      connected: true, mock: mailMocked(), account,
      messages: headers.map(h => ({ ...h, verdict: verdicts.get(h.id) ?? null })),
    });
  } catch (e) {
    return NextResponse.json({
      connected: true, mock: mailMocked(), account, messages: [],
      error: friendly(e),
    }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  let user;
  try { user = await currentUser(); } catch { return NextResponse.json({ error: NOT_SIGNED_IN }, { status: 401 }); }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? '');

  const account = await gmail.account(user.id);
  if (!account && action !== 'disconnect') {
    return NextResponse.json({ error: 'No mailbox is connected.' }, { status: 400 });
  }

  try {
    switch (action) {
      case 'draft':     return await doDraft(user, body, account!.email);
      case 'reply':     return await doReply(user, body);
      case 'send':      return await doSend(user, body, account!.email);
      case 'organise':  return await doOrganise(user, body);
      case 'disconnect':return await doDisconnect(user);
      default:          return NextResponse.json({ error: `Unknown action ${action}.` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: friendly(e) }, { status: 502 });
  }
}

type Who = { id: string; full_name: string; email: string };

/**
 * Write a reply, but do not save it anywhere.
 *
 * Returns text for the teacher to read and change. Separate from `draft` on purpose:
 * the model's first attempt should reach a person before it reaches their Gmail, so
 * that a draft nobody wanted is never something they have to go and delete.
 */
async function doReply(user: Who, body: Record<string, unknown>) {
  const id = String(body.id ?? '');
  if (!id) return NextResponse.json({ error: 'Which message?' }, { status: 400 });

  const msg = await gmail.message(user.id, id);
  const instruction = String(body.instruction ?? '').slice(0, 2000) || undefined;
  const drafted = await compose(user.id, msg, user.full_name, instruction);

  return NextResponse.json({
    draft: drafted,
    // Computed here, not asked for: see doDraft.
    to: [msg.fromEmail],
    threadId: msg.threadId,
    inReplyTo: msg.messageIdHeader,
  });
}

/**
 * Put a draft in the teacher's Gmail.
 *
 * RECIPIENTS ON A REPLY ARE NOT TAKEN FROM THE REQUEST. They are read back off the
 * message being replied to, server-side. This is the specific defence against the
 * one thing a hostile message could otherwise achieve: text that persuades a reply
 * to go to an address of its choosing, with the teacher glancing at a draft that
 * looks right. A teacher who genuinely needs a different recipient writes a new
 * message, where they type the address themselves and there is no untrusted text in
 * the room.
 */
async function doDraft(user: Who, body: Record<string, unknown>, from: string) {
  const replyTo = String(body.id ?? '');
  const text = String(body.body ?? '').slice(0, MAX_BODY);
  if (!text.trim()) return NextResponse.json({ error: 'Nothing to save — the draft is empty.' }, { status: 400 });

  let out: gmail.Outgoing;
  if (replyTo) {
    const msg = await gmail.message(user.id, replyTo);
    out = {
      to: [msg.fromEmail],
      subject: String(body.subject ?? `Re: ${msg.subject}`).slice(0, 400),
      body: text,
      threadId: msg.threadId,
      inReplyTo: msg.messageIdHeader,
      references: [msg.references, msg.messageIdHeader].filter(Boolean).join(' ') || null,
    };
  } else {
    const to = recipients(body.to);
    if (!to.length) return NextResponse.json({ error: 'Who is this going to?' }, { status: 400 });
    out = { to, subject: String(body.subject ?? '').slice(0, 400), body: text };
  }

  const w = await gmail.draft(user.id, out, from);
  await record(user, 'draft', out, w);
  return NextResponse.json({ ok: true, draftId: w.id, mock: w.mock, to: out.to });
}

/**
 * Send.
 *
 * `approve` is not ceremony. It is the difference between a request the teacher made
 * by pressing a button under text they had read, and a request that arrived some
 * other way. The body sent is the body posted — this route never re-generates it,
 * never edits it, and never appends to it, so what leaves the school is exactly what
 * was on the screen.
 */
async function doSend(user: Who, body: Record<string, unknown>, from: string) {
  if (body.approve !== true) {
    return NextResponse.json({ error: 'A person has to approve a send.' }, { status: 400 });
  }
  const text = String(body.body ?? '').slice(0, MAX_BODY);
  if (!text.trim()) return NextResponse.json({ error: 'Nothing to send.' }, { status: 400 });

  const replyTo = String(body.id ?? '');
  let out: gmail.Outgoing;

  if (replyTo) {
    const msg = await gmail.message(user.id, replyTo);
    out = {
      to: [msg.fromEmail],                              // as in doDraft: never from the request
      subject: String(body.subject ?? `Re: ${msg.subject}`).slice(0, 400),
      body: text,
      threadId: msg.threadId,
      inReplyTo: msg.messageIdHeader,
      references: [msg.references, msg.messageIdHeader].filter(Boolean).join(' ') || null,
    };
  } else {
    const to = recipients(body.to);
    if (!to.length) return NextResponse.json({ error: 'Who is this going to?' }, { status: 400 });
    out = { to, subject: String(body.subject ?? '').slice(0, 400), body: text };
  }

  const w = await gmail.send(user.id, out, from);
  await record(user, 'send', out, w);
  await audit(user.id, 'mail.send', 'mail', w.id, { to: out.to, subject: out.subject });
  return NextResponse.json({ ok: true, id: w.id, mock: w.mock, to: out.to });
}

/** Archive, mark read or unread, apply a label. All reversible, all recorded. */
async function doOrganise(user: Who, body: Record<string, unknown>) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 50) : [];
  const what = String(body.what ?? '');
  if (!ids.length) return NextResponse.json({ error: 'Nothing selected.' }, { status: 400 });

  const change: { add?: string[]; remove?: string[] } = {};
  if (what === 'archive') change.remove = ['INBOX'];
  else if (what === 'read') change.remove = ['UNREAD'];
  else if (what === 'unread') change.add = ['UNREAD'];
  else if (what === 'label') {
    const name = String(body.label ?? '').trim().slice(0, 60);
    if (!name) return NextResponse.json({ error: 'Which label?' }, { status: 400 });
    change.add = [await gmail.ensureLabel(user.id, name)];
  } else return NextResponse.json({ error: `Unknown change ${what}.` }, { status: 400 });

  const n = await gmail.organise(user.id, ids, change);

  await admin().from('mail_action').insert(ids.map(id => ({
    user_id: user.id, kind: what === 'label' ? 'label' : what,
    gmail_id: id, approved_by: user.id, detail: { change, label: body.label ?? null },
  }))).then(() => {}, () => {});
  await audit(user.id, `mail.${what}`, 'mail', ids[0], { count: n });

  return NextResponse.json({ ok: true, changed: n });
}

/**
 * Hand the grant back and forget the token.
 *
 * The revoke at Google comes first. A row deleted here while the grant stands leaves
 * a live permission nobody is tracking, which is the worse of the two failures — so
 * if Google refuses, the row still goes and the teacher is told to remove the app
 * from their own Google account, where they always could.
 */
async function doDisconnect(user: Who) {
  const db = admin();
  const { data } = await db.from('mail_account')
    .select('refresh_token, email').eq('user_id', user.id).maybeSingle();

  let handedBack = false;
  if (data) {
    try { handedBack = await revoke(open((data as { refresh_token: string }).refresh_token)); }
    catch { handedBack = false; }
  }

  await db.from('mail_account').delete().eq('user_id', user.id);
  // The triage cache is headers and verdicts about that person's mail. It goes too:
  // disconnecting should leave nothing behind that reading the mailbox produced.
  await db.from('mail_message').delete().eq('user_id', user.id).then(() => {}, () => {});
  gmail.forget(user.id);

  await db.from('mail_action').insert({
    user_id: user.id, kind: 'disconnect', approved_by: user.id,
    detail: { revokedAtGoogle: handedBack },
  }).then(() => {}, () => {});
  await audit(user.id, 'mail.disconnect', 'mail_account', user.id, { revokedAtGoogle: handedBack });

  return NextResponse.json({ ok: true, revokedAtGoogle: handedBack });
}

/** Every write to a mailbox lands in mail_action, with the body kept verbatim. */
async function record(user: Who, kind: string, out: gmail.Outgoing, w: gmail.Written) {
  try {
    await admin().from('mail_action').insert({
      user_id: user.id, kind,
      gmail_id: w.id, thread_id: w.threadId ?? out.threadId ?? null,
      to_addrs: out.to, subject: out.subject, body: out.body,
      approved_by: user.id, detail: { mock: w.mock },
    });
  } catch { /* the mail went; a missing table must not turn that into an error */ }
}

function recipients(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[,;]/);
  return raw.map(s => s.trim().toLowerCase())
    .filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))
    .slice(0, MAX_RECIPIENTS);
}

/** Google's own text, kept — /admin/health is where a `gmail 403:` is readable. */
function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === 'no_mailbox') return 'No mailbox is connected.';
  if (m.startsWith('gmail 401') || m.startsWith('google token 400')) {
    return 'Google has stopped accepting the connection. Connect the mailbox again.';
  }
  if (m.startsWith('gmail 403')) return 'Google refused that — the mailbox may not allow it.';
  return m;
}
