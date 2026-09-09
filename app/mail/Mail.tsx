'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The inbox screen.
 *
 * Three things it does that a mail client does not, and they are the whole reason it
 * exists rather than a link to Gmail:
 *
 *   1. It says what each message is and what it wants, in one line, before the
 *      teacher opens anything. A teacher with forty minutes of free period does not
 *      need their mail sorted by time; they need to know which three of these cost
 *      them something today.
 *
 *   2. It writes the reply, and then makes a person read it. The draft appears in a
 *      box the teacher can type into. Save puts it in Gmail Drafts. Send is a
 *      separate button that asks once more, because the thing on the other end is a
 *      parent and there is no unsend.
 *
 *   3. It shows an attempt as an attempt. A message flagged suspicious is drawn in
 *      the warning colour with its reply buttons removed, and says what it asked
 *      for. Silently declining to act would leave the teacher looking at a normal
 *      row and wondering why LOTS AI had nothing to say about it.
 *
 * Everything here is presentation. Nothing sends, labels or drafts in this file; each
 * button is one POST to /api/mail, which holds the authorisation.
 */

interface Verdict {
  category: string; urgency: string; summary: string; suggested: string;
  needsReply: boolean; suspicious: boolean;
}
interface Item {
  id: string; threadId: string; fromName: string; fromEmail: string;
  subject: string; snippet: string; receivedAt: string; unread: boolean;
  verdict: Verdict | null;
}
interface Open {
  id: string; fromName: string; fromEmail: string; subject: string;
  receivedAt: string; body: string;
}
interface Account { email: string; connectedAt: string; lastSyncAt: string | null }

const URGENCY: Record<string, string> = {
  now: 'Now', today: 'Today', week: 'This week', none: '',
};
const CATEGORY: Record<string, string> = {
  parent: 'Parent', student: 'Student', staff: 'Staff', leadership: 'Leadership',
  admin: 'Office', external: 'Outside', notice: 'Notice',
};

/** What went wrong at Google, said to a teacher rather than to a developer. */
const PROBLEM: Record<string, string> = {
  mock: 'Mail is in demo mode on this machine — the messages below are examples, not your inbox.',
  nokey: 'This server has no encryption key set for mail, so it will not store a Google connection. Ask whoever set up LOTS AI for MAIL_TOKEN_KEY.',
  declined: 'You said no to Google. Nothing was connected.',
  refused: 'Google would not complete the connection.',
  state: 'That connection link had expired or did not match this sign-in. Try again from this page.',
  norefresh: 'Google did not return a lasting permission. Remove LOTS AI from your Google account permissions, then connect again.',
  partial: 'Some permissions were left unticked, so replying or filing would fail. Connect again and accept all of them.',
  failed: 'The connection failed. It has been recorded on the health page.',
};

export default function Mail({ name }: { name: string }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [mock, setMock] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [open, setOpen] = useState<Open | null>(null);
  const [openVerdict, setOpenVerdict] = useState<Verdict | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string; note: string } | null>(null);
  const [steer, setSteer] = useState('');
  const [confirming, setConfirming] = useState(false);

  // Whatever the connect round trip had to say, said once and then taken out of the
  // address bar so a refresh does not repeat it.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('problem')) setProblem(PROBLEM[p.get('problem')!] ?? 'That did not work.');
    if (p.get('connected')) setNote('Mailbox connected.');
    if (p.toString()) window.history.replaceState({}, '', '/mail');
  }, []);

  const load = useCallback(async (search?: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/mail${search ? `?q=${encodeURIComponent(search)}` : ''}`);
      const j = await r.json();
      setConnected(!!j.connected);
      setMock(!!j.mock);
      setAccount(j.account ?? null);
      setItems(j.messages ?? []);
      if (j.error) setProblem(j.error);
    } catch {
      setProblem('Could not reach the mailbox.');
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(payload: Record<string, unknown>) {
    const r = await fetch('/api/mail', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? 'That did not work.');
    return j;
  }

  async function openMessage(id: string) {
    setBusy(true); setDraft(null); setSteer(''); setConfirming(false);
    try {
      const j = await (await fetch(`/api/mail?id=${encodeURIComponent(id)}`)).json();
      setOpen(j.message ?? null);
      setOpenVerdict(j.verdict ?? null);
      setItems(list => list.map(m => m.id === id ? { ...m, unread: false } : m));
    } catch { setProblem('Could not open that message.'); }
    finally { setBusy(false); }
  }

  async function writeReply() {
    if (!open) return;
    setBusy(true);
    try {
      const j = await post({ action: 'reply', id: open.id, instruction: steer.trim() || undefined });
      setDraft(j.draft);
    } catch (e) { setProblem(String((e as Error).message)); }
    finally { setBusy(false); }
  }

  async function saveDraft() {
    if (!open || !draft) return;
    setBusy(true);
    try {
      await post({ action: 'draft', id: open.id, subject: draft.subject, body: draft.body });
      setNote('Saved in your Gmail drafts.');
    } catch (e) { setProblem(String((e as Error).message)); }
    finally { setBusy(false); }
  }

  async function reallySend() {
    if (!open || !draft) return;
    setBusy(true);
    try {
      const j = await post({
        action: 'send', id: open.id, subject: draft.subject, body: draft.body, approve: true,
      });
      setNote(`Sent to ${(j.to ?? []).join(', ')}.`);
      setDraft(null); setConfirming(false);
    } catch (e) { setProblem(String((e as Error).message)); }
    finally { setBusy(false); }
  }

  async function organise(ids: string[], what: string, label?: string) {
    setBusy(true);
    try {
      await post({ action: 'organise', ids, what, label });
      if (what === 'archive') {
        setItems(list => list.filter(m => !ids.includes(m.id)));
        if (open && ids.includes(open.id)) setOpen(null);
        setNote('Archived. It is still in All Mail.');
      } else setNote(what === 'label' ? `Filed under ${label}.` : 'Done.');
    } catch (e) { setProblem(String((e as Error).message)); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect this mailbox? LOTS AI will hand the permission back to Google and forget everything it read.')) return;
    setBusy(true);
    try {
      const j = await post({ action: 'disconnect' });
      setConnected(false); setItems([]); setOpen(null); setAccount(null);
      setNote(j.revokedAtGoogle
        ? 'Disconnected, and the permission was handed back to Google.'
        : 'Disconnected here. Google did not confirm — remove LOTS AI from your Google account permissions to be sure.');
    } catch (e) { setProblem(String((e as Error).message)); }
    finally { setBusy(false); }
  }

  if (connected === null) return <main className="mail"><p className="mnote">Looking at your mail…</p></main>;

  return (
    <main className="mail">
      <header className="mhead">
        <div>
          <h1>Mail</h1>
          {account
            ? <p className="mnote">{account.email}{mock ? ' — demo mailbox' : ''}</p>
            : <p className="mnote">Not connected</p>}
        </div>
        <div className="macts">
          <a className="btn" href="/">Back to LOTS AI</a>
          {connected && <button className="btn" onClick={disconnect} disabled={busy}>Disconnect</button>}
        </div>
      </header>

      {problem && <p className="mbad" onClick={() => setProblem(null)}>{problem}</p>}
      {note && <p className="mok" onClick={() => setNote(null)}>{note}</p>}

      {!connected ? <Connect /> : (
        <div className="mgrid">
          <section className="mlist">
            <form className="msearch" onSubmit={e => { e.preventDefault(); load(q); }}>
              <input value={q} onChange={e => setQ(e.target.value)}
                placeholder="Search this mailbox" aria-label="Search this mailbox" />
              <button className="btn" disabled={busy}>Search</button>
            </form>

            {!items.length && <p className="mnote">Nothing in the inbox.</p>}

            {items.map(m => (
              <button key={m.id}
                className={`mrow${open?.id === m.id ? ' on' : ''}${m.unread ? ' unread' : ''}${m.verdict?.suspicious ? ' bad' : ''}`}
                onClick={() => openMessage(m.id)}>
                <span className="mtop">
                  <b>{m.fromName}</b>
                  <span className="mwhen">{when(m.receivedAt)}</span>
                </span>
                <span className="msub">{m.subject}</span>
                {m.verdict ? (
                  <>
                    <span className="mtags">
                      {m.verdict.suspicious && <i className="tag bad">Suspicious</i>}
                      {CATEGORY[m.verdict.category] && <i className="tag">{CATEGORY[m.verdict.category]}</i>}
                      {URGENCY[m.verdict.urgency] && <i className={`tag ${m.verdict.urgency === 'now' ? 'bad' : m.verdict.urgency === 'today' ? 'warn' : ''}`}>{URGENCY[m.verdict.urgency]}</i>}
                      {m.verdict.needsReply && <i className="tag ok">Owes a reply</i>}
                    </span>
                    <span className="msum">{m.verdict.summary}</span>
                  </>
                ) : <span className="msum dim">{m.snippet}</span>}
              </button>
            ))}
          </section>

          <section className="mread">
            {!open ? <p className="mnote">Pick a message.</p> : (
              <>
                <h2>{open.subject}</h2>
                <p className="mnote">{open.fromName} &lt;{open.fromEmail}&gt; · {when(open.receivedAt)}</p>

                {openVerdict?.suspicious && (
                  <p className="mbad">
                    <b>This message tried to give LOTS AI instructions.</b> {openVerdict.summary}{' '}
                    Nothing in it was acted on, and no reply will be drafted for it. Send it to
                    whoever handles IT, then archive it.
                  </p>
                )}
                {openVerdict && !openVerdict.suspicious && openVerdict.suggested && (
                  <p className="msug">{openVerdict.suggested}</p>
                )}

                <pre className="mbody">{open.body}</pre>

                <div className="macts">
                  <button className="btn" onClick={() => organise([open.id], 'archive')} disabled={busy}>Archive</button>
                  <button className="btn" onClick={() => organise([open.id], 'unread')} disabled={busy}>Mark unread</button>
                  <button className="btn" onClick={() => {
                    const l = window.prompt('File this under which label?');
                    if (l?.trim()) organise([open.id], 'label', l.trim());
                  }} disabled={busy}>Label…</button>
                </div>

                {!openVerdict?.suspicious && (
                  <div className="mreply">
                    <h3>Reply</h3>
                    <label className="msteer">
                      <span>What should it say? Leave this empty and LOTS AI will write the obvious reply.</span>
                      <input value={steer} onChange={e => setSteer(e.target.value)}
                        placeholder="e.g. yes, but Thursday after school, not Saturday" />
                    </label>
                    <button className="btn primary" onClick={writeReply} disabled={busy}>
                      {draft ? 'Write it again' : 'Write a reply'}
                    </button>

                    {draft && (
                      <>
                        {draft.note && <p className="msug">{draft.note}</p>}
                        <input className="msubject" value={draft.subject}
                          onChange={e => setDraft({ ...draft, subject: e.target.value })}
                          aria-label="Subject" />
                        <textarea className="mdraft" rows={12} value={draft.body}
                          onChange={e => setDraft({ ...draft, body: e.target.value })}
                          aria-label="Reply" />
                        <p className="mnote">
                          Goes to {open.fromEmail} — the address this message came from, and only that
                          one. Signed off as {name}.
                        </p>
                        <div className="macts">
                          <button className="btn" onClick={saveDraft} disabled={busy || !draft.body.trim()}>
                            Save to Gmail drafts
                          </button>
                          {!confirming
                            ? <button className="btn primary" onClick={() => setConfirming(true)}
                                disabled={busy || !draft.body.trim()}>Send…</button>
                            : <>
                                <button className="btn primary" onClick={reallySend} disabled={busy}>
                                  Yes — send to {open.fromEmail}
                                </button>
                                <button className="btn" onClick={() => setConfirming(false)}>Not yet</button>
                              </>}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

/**
 * The consent explained before it is asked for.
 *
 * A Google screen listing "Read, compose, send and permanently delete all your email"
 * is alarming, correctly, and a teacher who meets it with no warning says no. So the
 * scopes are described here first, in the order that matters to them, including the
 * part where they can take it back without asking anyone.
 */
function Connect() {
  return (
    <div className="mconnect">
      <h2>Connect your mailbox</h2>
      <p>
        LOTS AI can read your school mail, tell you what each message wants, write the
        reply, and file it. It uses your own Google account, not the school&rsquo;s: nobody
        else can see your mail through LOTS AI, including whoever administers it.
      </p>
      <ul>
        <li><b>It reads</b> your inbox to sort it. Message text is never stored here — only who
          it was from, the subject, and the one-line verdict.</li>
        <li><b>It writes drafts</b> into your own Gmail drafts, unsent.</li>
        <li><b>It sends only when you press send</b>, on words you have read, to the address the
          message came from.</li>
        <li><b>It files</b> — labels, archives, marks read. Archiving is not deleting, and it
          cannot delete.</li>
        <li><b>You can take it back</b> at any time, here or from your own Google account.</li>
      </ul>
      <p className="mnote">
        Google will show a permission screen. Accept all of what it lists — with any of it
        unticked, replying or filing fails later with an error nobody can act on.
      </p>
      <a className="btn primary" href="/api/mail/connect">Connect Google mail</a>
    </div>
  );
}

/** Time as a teacher reads it: how long ago, then a date once that stops meaning anything. */
function when(iso: string): string {
  const then = new Date(iso), mins = (Date.now() - then.getTime()) / 60_000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 60 * 20) return `${Math.round(mins / 60)} h ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
