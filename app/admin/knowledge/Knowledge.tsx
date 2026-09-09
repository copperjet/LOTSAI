'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DUPLICATE_SAYS, type Duplicate } from '@/lib/knowledge';

/**
 * The school-fact editor.
 *
 * The one client component in /admin - everything else here is a server component and a
 * plain form POST, and this would be too if it were only a form. It is not: a document
 * is read into candidate facts that a person edits, accepts, replaces or drops before
 * any of it is saved, and that review step is the entire safety property of the feature.
 * Doing it without JavaScript would mean posting the candidates back through a hidden
 * field and re-reading the document on every mistake.
 *
 * Three doors, one review list. Paste, upload or type it yourself - by the time it
 * reaches the list they are the same thing: a topic, a body, a note about where it came
 * from, and whatever it might already be a copy of. Nothing is written until "Save".
 *
 * The review list is the part worth protecting. It costs a model call and a person's
 * attention to build, and it lived only in React state - so a refresh, a back button or
 * a closed tab threw away a document somebody had just spent five minutes checking. It
 * is kept in sessionStorage between renders and the tab warns before it goes.
 */

type Reason = Duplicate['reason'];

interface Candidate {
  /** Stable for the life of the list, so editing one card cannot land on another. */
  uid: string;
  topic: string;
  body: string;
  /** Where this one came from. Per candidate, not per page: one review list is often
   *  two documents, and "Staff handbook" against one of them is a lie about the other. */
  source_note: string;
  duplicates: Duplicate[];
  /** What to do about the duplicate. 'keep' saves it alongside, 'replace' retires the
   *  old row, 'skip' leaves it out. Defaulted by how sure the match is. */
  decision: 'keep' | 'replace' | 'skip';
  replaces: string[];
}

interface Fact {
  id: string; topic: string; body: string; source_note: string | null;
  added_at: string; retired_at?: string | null;
  /** On a withdrawn fact: the live fact that took its place, where one did. */
  replacedBy?: { id: string; topic: string } | null;
  app_user?: { full_name: string } | null;
}

interface Budget { facts: number; chars: number; maxFacts: number; maxChars: number }

type Tab = 'paste' | 'upload' | 'write';

/** The same limits /api/school-fact enforces. Checked here as well so a mistake costs
 *  a sentence rather than an upload that is rejected after it has finished - and, for
 *  the size, so that it is refused before it is sent at all: past the host's body limit
 *  the request never reaches our code and there is no message of ours to show.
 *  Copied rather than imported: lib/ingest/extract.ts pulls pdfjs and the vision model
 *  in behind it, and none of that belongs in a browser bundle. */
const MAX_FILES = 5;
const MAX_UPLOAD_MB = 4;
const MAX_COMMIT = 60;
const MIN_TEXT = 120;
const READABLE = ['.pdf', '.docx'];

/** Survives a refresh, dies with the tab. A half-checked review list is worth keeping
 *  for ten minutes and worth nobody else inheriting. */
const DRAFT = 'lots.school-fact.review';

const WHEN = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(36).slice(2)}`);

/** A `same` match is a re-import and defaults to being left out; anything softer is a
 *  question, and the safe answer to a question is to keep what the school already has
 *  and let the administrator decide. */
function defaultDecision(duplicates: Duplicate[]): Candidate['decision'] {
  if (!duplicates.length) return 'keep';
  return duplicates[0].reason === 'same' ? 'skip' : 'keep';
}

/** What is wrong with this file, said before it is uploaded rather than after. */
function unreadable(file: File): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.doc')) {
    return `${file.name} is in the old Word format. Open it and save it as .docx.`;
  }
  const ok = READABLE.some(ext => name.endsWith(ext)) || file.type.startsWith('image/');
  if (!ok) return `${file.name} is not a kind of file I can read. Send a PDF, a .docx, or a photograph.`;
  return null;
}

/** Everything together, which is what the host actually measures. A phone photograph
 *  is 2 to 5 MB, so two pages of a handbook is already the ordinary way to hit this. */
function tooMuch(files: File[]): string | null {
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total <= MAX_UPLOAD_MB * 1024 * 1024) return null;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return files.length === 1
    ? `${files[0].name} is ${mb(total)}. One upload must be under ${MAX_UPLOAD_MB} MB - `
      + 'take the photograph again at a lower resolution, or send the pages separately.'
    : `Those ${files.length} files come to ${mb(total)} together. One upload must be under `
      + `${MAX_UPLOAD_MB} MB - send them in two goes.`;
}

export default function Knowledge() {
  const [tab, setTab] = useState<Tab>('paste');
  const [facts, setFacts] = useState<Fact[]>([]);
  const [retired, setRetired] = useState<Fact[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  /** Distinguishes "nothing saved yet" from "the read failed" - which is the same
   *  table to look at and the opposite thing to do about it. */
  const [loadFailed, setLoadFailed] = useState(false);

  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [own, setOwn] = useState({ topic: '', body: '', source: '' });
  const [ownDuplicates, setOwnDuplicates] = useState<Duplicate[]>([]);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [skippedNames, setSkippedNames] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [query, setQuery] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  /**
   * One read at a time, and only the newest one is listened to.
   *
   * Every door here is an async POST that ends by setting `busy`, `said` and the
   * review list. Dropping a file while a paste is still being read used to leave two
   * of them racing to write the same three pieces of state, and whichever landed
   * second won - including the one that had been superseded.
   */
  const turn = useRef(0);
  const checking = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/school-fact').then(r => r.json()).catch(() => null);
    if (!r || r.error) { setLoadFailed(true); return; }
    setLoadFailed(false);
    setFacts(r.facts ?? []);
    setRetired(r.retired ?? []);
    setBudget(r.budget ?? null);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── the review list, kept across a refresh ─────────────────────────────────
  useEffect(() => {
    try {
      const held = sessionStorage.getItem(DRAFT);
      if (!held) return;
      const list = JSON.parse(held) as Candidate[];
      if (!Array.isArray(list) || !list.length) return;
      setCandidates(list.map(c => ({ ...c, uid: c.uid || uid() })));
      setSaid('The list you were checking is still here. Nothing has been saved.');
    } catch { /* a browser with storage turned off simply does not get this. */ }
  }, []);

  useEffect(() => {
    try {
      if (candidates.length) sessionStorage.setItem(DRAFT, JSON.stringify(candidates));
      else sessionStorage.removeItem(DRAFT);
    } catch { /* nothing here is worth failing a render over. */ }
  }, [candidates]);

  // sessionStorage covers a refresh; it does not cover the tab being closed, which is
  // the way this list actually gets lost.
  useEffect(() => {
    if (!candidates.length) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [candidates.length]);

  function received(
    r: { candidates?: Omit<Candidate, 'uid' | 'decision' | 'replaces' | 'source_note'>[];
         source_note?: string; note?: string; error?: string; message?: string },
    fallback: string, fallbackSource: string,
  ) {
    if (r.error) { setProblem(r.message ?? r.error); return; }
    // The read knows where the material came from - the filenames, on the upload door,
    // which is the one place an administrator has not typed it. Taking it from the
    // response is the difference between "Staff handbook 2026.pdf" and "Added by hand".
    const from = (source.trim() || r.source_note || fallbackSource).slice(0, 300);
    const got = (r.candidates ?? []).map(c => ({
      ...c,
      uid: uid(),
      source_note: from,
      duplicates: c.duplicates ?? [],
      decision: defaultDecision(c.duplicates ?? []),
      replaces: [] as string[],
    }));
    setCandidates(list => [...list, ...got]);
    setSaid(r.note ?? fallback);
  }

  async function readText() {
    const my = ++turn.current;
    setProblem(null); setSaid(null); setSkippedNames([]);
    setBusy('Reading it. This takes a few seconds.');
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'read', text, source_note: source }),
    }).then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    if (my !== turn.current) return;
    setBusy(null);
    if (!r.error) setText('');
    received(r, 'Read.', 'Pasted text');
  }

  async function readFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;

    // Checked here as well as in the route: an administrator on a school connection
    // should not upload five photographs to be told the sixth was one too many.
    if (files.length > MAX_FILES) {
      setSaid(null);
      setProblem(`${files.length} files at once. Send up to ${MAX_FILES}.`);
      return;
    }
    const wrong = files.map(unreadable).find(Boolean) ?? tooMuch(files);
    if (wrong) { setSaid(null); setProblem(wrong); return; }

    const my = ++turn.current;
    setProblem(null); setSaid(null); setSkippedNames([]);
    setBusy(`Reading ${files.length === 1 ? files[0].name : `${files.length} files`}.`);
    const form = new FormData();
    for (const file of files) form.append('file', file);
    const r = await fetch('/api/school-fact', { method: 'POST', body: form })
      .then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    if (my !== turn.current) return;
    setBusy(null);
    received(r, 'Read.',
      files.length === 1 ? files[0].name : `${files[0].name} and ${files.length - 1} more`);
  }

  /** The typed-by-hand path gets the same duplicate check as the read one, without a
   *  model call - otherwise the one door a person uses most is the one with no guard.
   *  Fires on every blur, so the one still in flight is abandoned rather than raced. */
  async function checkOwn() {
    if (!own.topic.trim() || own.body.trim().length < 10) { setOwnDuplicates([]); return; }
    checking.current?.abort();
    const ctrl = new AbortController();
    checking.current = ctrl;
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ action: 'check', topic: own.topic, body: own.body }),
    }).then(r => r.json()).catch(() => null);
    if (ctrl.signal.aborted) return;
    setOwnDuplicates(r?.duplicates ?? []);
  }

  function addOwn() {
    if (!own.topic.trim() || !own.body.trim()) {
      setProblem('A fact needs a topic and a body.');
      return;
    }
    setProblem(null);
    setCandidates(list => [...list, {
      uid: uid(),
      topic: own.topic.trim(), body: own.body.trim(),
      source_note: (own.source.trim() || source.trim() || 'Added by hand').slice(0, 300),
      duplicates: ownDuplicates,
      decision: defaultDecision(ownDuplicates),
      replaces: [],
    }]);
    setSource(s => s || own.source);
    setOwn({ topic: '', body: '', source: own.source });
    setOwnDuplicates([]);
    setSaid('Added to the list below. Nothing is saved until you save it.');
  }

  function edit(id: string, patch: Partial<Candidate>) {
    setCandidates(list => list.map(c => (c.uid === id ? { ...c, ...patch } : c)));
  }

  function decide(id: string, decision: Candidate['decision']) {
    setCandidates(list => list.map(c => c.uid === id ? {
      ...c, decision,
      replaces: decision === 'replace' && c.duplicates[0] ? [c.duplicates[0].id] : [],
    } : c));
  }

  const keeping = candidates.filter(c => c.decision !== 'skip');
  const replacing = candidates.filter(c => c.decision === 'replace').length;
  const skipping = candidates.length - keeping.length;

  /**
   * What this save does to the prompt budget.
   *
   * The page has always shown what the saved set costs. It did not show what saving
   * *this* would cost, so an administrator could walk past the cap that lib/ask.ts
   * enforces - and past it, facts stop being carried without anything on this page or
   * in an answer saying so. A replacement is not growth, so the count is net.
   */
  const netFacts = keeping.length - replacing;
  const netChars = keeping.reduce((n, c) => n + c.topic.length + c.body.length + 4, 0);
  const after = budget
    ? { facts: budget.facts + netFacts, chars: budget.chars + netChars }
    : null;
  const overflows = !!after && !!budget
    && (after.facts > budget.maxFacts || after.chars > budget.maxChars);

  async function save() {
    if (!keeping.length) return;
    if (keeping.length > MAX_COMMIT) {
      setProblem(`That is ${keeping.length} facts in one save. Save at most ${MAX_COMMIT} at a time.`);
      return;
    }
    if (overflows && !confirm(
      'This takes the school past what is carried on every question. The facts over the '
      + 'limit stop reaching the model, and nothing in an answer will say so. Save anyway?')) {
      return;
    }

    const my = ++turn.current;
    setProblem(null); setSaid(null); setSkippedNames([]);
    setBusy('Saving.');
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'commit',
        facts: keeping.map(c => ({
          topic: c.topic, body: c.body,
          source_note: c.source_note || source || 'Added by hand',
          replaces: c.replaces,
        })),
      }),
    }).then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    if (my !== turn.current) return;
    setBusy(null);

    if (r.error) { setProblem(r.message ?? r.error); return; }
    setCandidates([]);
    // Which ones were left out, not how many. "3 skipped as already saved" is the
    // start of a hunt through a table for the three.
    setSkippedNames((r.skippedFacts ?? []).map((f: { topic: string }) => f.topic));
    if (r.budget) setBudget(r.budget);
    setSaid(`${r.saved} saved`
      + (r.replaced ? `, ${r.replaced} replaced` : '')
      + (r.skipped ? `, ${r.skipped} skipped as already saved` : '')
      + '. LOTS AI answers from these from the next question on.');
    load();
  }

  /** Editing is superseding: the old row is retired and the new one carries the change,
   *  so what the school was saying last term survives being corrected this one. */
  function editExisting(fact: Fact) {
    setCandidates(list => [...list, {
      uid: uid(),
      topic: fact.topic, body: fact.body,
      source_note: fact.source_note ?? '',
      duplicates: [{ id: fact.id, topic: fact.topic, body: fact.body, reason: 'topic' as Reason, score: 1 }],
      decision: 'replace',
      replaces: [fact.id],
    }]);
    setSaid('Loaded below. Change it and save - the old wording is retired, not overwritten.');
    document.querySelector('#review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function retire(fact: Fact) {
    if (!confirm(`Withdraw "${fact.topic}"? LOTS AI stops answering from it immediately. The record of it stays.`)) return;
    const my = ++turn.current;
    setProblem(null);
    setBusy('Withdrawing it.');
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retire', id: fact.id }),
    }).then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    if (my !== turn.current) return;
    setBusy(null);
    if (r.error) { setProblem(r.message ?? r.error); return; }
    setSaid(`"${fact.topic}" is withdrawn. It is in the withdrawn list at the bottom, `
      + 'and it can be put back from there.');
    load();
  }

  /** Withdrawal is one click behind one confirm, and the wrong row is easy to hit in a
   *  list of similar topics. The way back used to be retyping the policy out of the
   *  withdrawn table, which is how a school ends up with a wording it never chose. */
  async function reinstate(fact: Fact) {
    const my = ++turn.current;
    setProblem(null);
    setBusy('Putting it back.');
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reinstate', id: fact.id }),
    }).then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    if (my !== turn.current) return;
    setBusy(null);
    if (r.error) { setProblem(r.message ?? r.error); return; }
    setSaid(`"${fact.topic}" is answered from again.`);
    load();
  }

  const hunt = query.trim().toLowerCase();
  const shown = hunt
    ? facts.filter(f => `${f.topic} ${f.body} ${f.source_note ?? ''}`.toLowerCase().includes(hunt))
    : facts;

  return (
    <>
      <h2 id="add">Add what the school knows</h2>

      <div className="ktabs">
        {([['paste', 'Paste it'], ['upload', 'Upload a document'], ['write', 'Write it yourself']] as [Tab, string][])
          .map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
      </div>

      {tab === 'paste' && (
        <div className="kcard">
          <label className="afield kwide">
            <span>The policy, or the part of the handbook that states it</span>
            <textarea rows={7} value={text} onChange={e => setText(e.target.value)}
              placeholder="Uniform: full school uniform is worn every day. PE kit is worn only on the day a class has PE..." />
          </label>
          <label className="afield kwide">
            <span>Where it came from</span>
            <input value={source} onChange={e => setSource(e.target.value)}
              placeholder="Staff handbook 2026, page 4" />
          </label>
          <div className="arow">
            <button className="abtn" onClick={readText} disabled={!!busy || text.trim().length < MIN_TEXT}>
              Read it
            </button>
            <span className="anote">
              {text.trim().length < MIN_TEXT
                ? `${text.trim().length} of ${MIN_TEXT} characters minimum.`
                : 'Nothing is saved yet - you see what it read first.'}
            </span>
          </div>
        </div>
      )}

      {tab === 'upload' && (
        <div className={`kcard kdrop${dropping ? ' dropping' : ''}`}
          onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
          onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false); }}
          onDrop={e => { e.preventDefault(); setDropping(false); readFiles(e.dataTransfer.files); }}>
          <input ref={picker} type="file" hidden multiple
            accept=".pdf,.docx,image/png,image/jpeg,image/webp"
            onChange={e => { readFiles(e.target.files); e.target.value = ''; }} />
          <p><b>Drop the handbook here</b>, or <button className="quiet" onClick={() => picker.current?.click()}>choose a file</button>.</p>
          <p className="anote">
            Up to {MAX_FILES} at a time and {MAX_UPLOAD_MB} MB altogether - which is one or two
            phone photographs, so send a long handbook a few pages at a time. PDFs, .docx, or a
            photograph of a page - a photograph is read by the vision model, so give it good light.
            A file&rsquo;s name is kept as where the facts came from, so you need only type that in
            if you want it to say something else.
          </p>
          <label className="afield kwide" style={{ marginTop: 10 }}>
            <span>Where it came from</span>
            <input value={source} onChange={e => setSource(e.target.value)}
              placeholder="Taken from the file name unless you say otherwise" />
          </label>
        </div>
      )}

      {tab === 'write' && (
        <div className="kcard">
          <label className="afield kwide">
            <span>Topic - in the words a teacher would ask it in</span>
            <input value={own.topic} onBlur={checkOwn}
              onChange={e => setOwn({ ...own, topic: e.target.value })}
              placeholder="Marking policy" />
          </label>
          <label className="afield kwide">
            <span>What the school says about it</span>
            <textarea rows={4} value={own.body} onBlur={checkOwn}
              onChange={e => setOwn({ ...own, body: e.target.value })}
              placeholder="Books are marked once a week. Every piece carries one thing done well and one thing to fix..." />
          </label>
          <label className="afield kwide">
            <span>Where it came from</span>
            <input value={own.source} onChange={e => setOwn({ ...own, source: e.target.value })}
              placeholder="Principal's email, 12 August" />
          </label>

          {ownDuplicates.length > 0 && (
            <div className="kdupe">
              <b>{DUPLICATE_SAYS[ownDuplicates[0].reason]}</b>
              <p className="anote"><b>{ownDuplicates[0].topic}</b>: {ownDuplicates[0].body}</p>
              <p className="anote">Add it anyway and you can choose to replace that one below.</p>
            </div>
          )}

          <div className="arow">
            <button className="abtn" onClick={addOwn} disabled={!!busy}>Add it to the list</button>
            <span className="anote">No model call - this one goes straight to the review list.</span>
          </div>
        </div>
      )}

      {busy && <p className="anote awide"><b>{busy}</b></p>}
      {problem && <p className="aproblem">{problem}</p>}
      {said && !problem && <p className="anote awide ksaid">{said}</p>}
      {skippedNames.length > 0 && (
        <p className="anote awide">
          Already saved word for word, so left out: {skippedNames.join(', ')}.
        </p>
      )}

      {candidates.length > 0 && (
        <>
          <h2 id="review">Check these before they are saved</h2>
          {candidates.map(c => (
            <div key={c.uid} className={`kcand${c.decision === 'skip' ? ' off' : ''}`}>
              <div className="kfields">
                <label className="afield">
                  <span>Topic</span>
                  <input value={c.topic} onChange={e => edit(c.uid, { topic: e.target.value })} />
                </label>
                <label className="afield kgrow">
                  <span>What the school says</span>
                  <textarea rows={3} value={c.body} onChange={e => edit(c.uid, { body: e.target.value })} />
                </label>
                <label className="afield">
                  <span>Where it came from</span>
                  <input value={c.source_note} placeholder="Added by hand"
                    onChange={e => edit(c.uid, { source_note: e.target.value })} />
                </label>
              </div>

              {c.duplicates.length > 0 && (
                <div className="kdupe">
                  <b>{DUPLICATE_SAYS[c.duplicates[0].reason]}</b>
                  <div className="kside">
                    <div>
                      <span className="alabel">Already saved</span>
                      <p><b>{c.duplicates[0].topic}</b></p>
                      <p className="anote">{c.duplicates[0].body}</p>
                    </div>
                    <div>
                      <span className="alabel">This one</span>
                      <p><b>{c.topic}</b></p>
                      <p className="anote">{c.body}</p>
                    </div>
                  </div>
                  <div className="arow">
                    {([['replace', 'Replace the saved one'], ['keep', 'Keep both'], ['skip', 'Leave this out']] as
                      [Candidate['decision'], string][]).map(([value, label]) => (
                      <label key={value} className="kchoice">
                        <input type="radio" name={`decision-${c.uid}`} checked={c.decision === value}
                          onChange={() => decide(c.uid, value)} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!c.duplicates.length && (
                <div className="arow">
                  <button className="quiet" onClick={() => decide(c.uid, c.decision === 'skip' ? 'keep' : 'skip')}>
                    {c.decision === 'skip' ? 'Put it back' : 'Leave this one out'}
                  </button>
                </div>
              )}
            </div>
          ))}

          {overflows && budget && after && (
            <p className="aproblem">
              Saving these takes the school to {after.facts} facts and {after.chars.toLocaleString()}{' '}
              characters, past the {budget.maxFacts} and {budget.maxChars.toLocaleString()} that are
              carried on every question. The ones over the line stop reaching the model, and no
              answer will say so. Withdraw something first, or fold these into facts already saved.
            </p>
          )}

          <div className="arow">
            <button className="abtn" onClick={save} disabled={!!busy || !keeping.length}>
              Save {keeping.length} fact{keeping.length === 1 ? '' : 's'}
            </button>
            <span className="anote">
              {replacing > 0 && `${replacing} replacing something already saved. `}
              {skipping > 0 && `${skipping} left out. `}
              Saved facts are answered from immediately.
            </span>
            <button className="quiet" onClick={() => {
              if (confirm(`Discard ${candidates.length} unsaved fact${candidates.length === 1 ? '' : 's'}? They were read but never saved.`)) {
                setCandidates([]); setSaid(null);
              }
            }}>Discard the list</button>
          </div>
        </>
      )}

      <h2>What the school has said</h2>
      {budget && (
        <p className="anote awide">
          {budget.facts} fact{budget.facts === 1 ? '' : 's'}, {budget.chars.toLocaleString()} characters.
          Every one of them is in the prompt for every question anybody asks, so they are kept few on
          purpose: past {budget.maxFacts} facts or {budget.maxChars.toLocaleString()} characters the
          rest stop being carried, and the answer then is to record them somewhere they can be looked
          up rather than carried whole.
        </p>
      )}

      {facts.length > 6 && (
        <label className="afield kwide" style={{ maxWidth: 340 }}>
          <span>Find one</span>
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="uniform, marking, reports..." />
        </label>
      )}

      {loadFailed ? (
        <p className="aproblem">
          The saved facts could not be read just now. This says nothing about what is in the
          table - reload the page. Do not re-add anything until it comes back.
        </p>
      ) : !facts.length ? (
        <p className="anote">
          Nothing yet. Until something is here, LOTS AI answers a policy question by saying the
          records do not hold it - which is right, and useless.
        </p>
      ) : !shown.length ? (
        <p className="anote">Nothing saved matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <table className="atable">
          <thead>
            <tr><th>Topic</th><th>What it says</th><th>Where from</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {shown.map(f => (
              <tr key={f.id}>
                <td><b>{f.topic}</b></td>
                <td className="wrap">{f.body}</td>
                <td className="anote">{f.source_note ?? '—'}</td>
                <td>{WHEN(f.added_at)}<span className="anote">{f.app_user?.full_name ?? ''}</span></td>
                <td className="r">
                  <button className="quiet" onClick={() => editExisting(f)}>Edit</button>{' '}
                  <button className="quiet" onClick={() => retire(f)} disabled={!!busy}>Withdraw</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {retired.length > 0 && (
        <details className="kretired">
          <summary>{retired.length} withdrawn</summary>
          <p className="anote awide">
            No longer answered from. Kept because a teacher who acted on one of these needs the school
            to be able to see what it was telling them at the time. One withdrawn by mistake goes back
            as it was - putting it back is better than retyping it, which is how a wording nobody chose
            gets into the record.
          </p>
          <table className="atable">
            <thead><tr><th>Topic</th><th>What it said</th><th>Withdrawn</th><th /></tr></thead>
            <tbody>
              {retired.map(f => (
                <tr key={f.id} className="off">
                  <td><b>{f.topic}</b></td>
                  <td className="wrap">{f.body}</td>
                  <td>
                    {WHEN(f.retired_at)}
                    {f.replacedBy && <span className="anote">replaced by {f.replacedBy.topic}</span>}
                  </td>
                  <td className="r">
                    {!f.replacedBy && (
                      <button className="quiet" onClick={() => reinstate(f)} disabled={!!busy}>
                        Put it back
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}
