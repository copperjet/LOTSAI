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
 */

type Reason = Duplicate['reason'];

interface Candidate {
  topic: string;
  body: string;
  duplicates: Duplicate[];
  /** What to do about the duplicate. 'keep' saves it alongside, 'replace' retires the
   *  old row, 'skip' leaves it out. Defaulted by how sure the match is. */
  decision: 'keep' | 'replace' | 'skip';
  replaces: string[];
}

interface Fact {
  id: string; topic: string; body: string; source_note: string | null;
  added_at: string; retired_at?: string | null;
  app_user?: { full_name: string } | null;
}

interface Budget { facts: number; chars: number; maxFacts: number; maxChars: number }

type Tab = 'paste' | 'upload' | 'write';

const WHEN = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

/** A `same` match is a re-import and defaults to being left out; anything softer is a
 *  question, and the safe answer to a question is to keep what the school already has
 *  and let the administrator decide. */
function defaultDecision(duplicates: Duplicate[]): Candidate['decision'] {
  if (!duplicates.length) return 'keep';
  return duplicates[0].reason === 'same' ? 'skip' : 'keep';
}

export default function Knowledge() {
  const [tab, setTab] = useState<Tab>('paste');
  const [facts, setFacts] = useState<Fact[]>([]);
  const [retired, setRetired] = useState<Fact[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);

  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [own, setOwn] = useState({ topic: '', body: '', source: '' });
  const [ownDuplicates, setOwnDuplicates] = useState<Duplicate[]>([]);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/school-fact').then(r => r.json()).catch(() => null);
    if (!r) return;
    setFacts(r.facts ?? []);
    setRetired(r.retired ?? []);
    setBudget(r.budget ?? null);
  }, []);

  useEffect(() => { load(); }, [load]);

  function received(r: { candidates?: Candidate[]; note?: string; error?: string }, fallback: string) {
    if (r.error) { setProblem(r.error); return; }
    const got = (r.candidates ?? []).map(c => ({
      ...c,
      duplicates: c.duplicates ?? [],
      decision: defaultDecision(c.duplicates ?? []),
      replaces: [] as string[],
    }));
    setCandidates(list => [...list, ...got]);
    setSaid(r.note ?? fallback);
  }

  async function readText() {
    setProblem(null); setSaid(null);
    setBusy('Reading it. This takes a few seconds.');
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'read', text, source_note: source }),
    }).then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    setBusy(null);
    if (!r.error) setText('');
    received(r, 'Read.');
  }

  async function readFiles(files: FileList | null) {
    if (!files?.length) return;
    setProblem(null); setSaid(null);
    setBusy(`Reading ${files.length === 1 ? files[0].name : `${files.length} files`}.`);
    const form = new FormData();
    for (const file of Array.from(files)) form.append('file', file);
    const r = await fetch('/api/school-fact', { method: 'POST', body: form })
      .then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    setBusy(null);
    received(r, 'Read.');
  }

  /** The typed-by-hand path gets the same duplicate check as the read one, without a
   *  model call - otherwise the one door a person uses most is the one with no guard. */
  async function checkOwn() {
    if (!own.topic.trim() || own.body.trim().length < 10) { setOwnDuplicates([]); return; }
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'check', topic: own.topic, body: own.body }),
    }).then(r => r.json()).catch(() => null);
    setOwnDuplicates(r?.duplicates ?? []);
  }

  function addOwn() {
    if (!own.topic.trim() || !own.body.trim()) {
      setProblem('A fact needs a topic and a body.');
      return;
    }
    setProblem(null);
    setCandidates(list => [...list, {
      topic: own.topic.trim(), body: own.body.trim(),
      duplicates: ownDuplicates,
      decision: defaultDecision(ownDuplicates),
      replaces: [],
    }]);
    setSource(s => s || own.source);
    setOwn({ topic: '', body: '', source: own.source });
    setOwnDuplicates([]);
    setSaid('Added to the list below. Nothing is saved until you save it.');
  }

  function edit(i: number, patch: Partial<Candidate>) {
    setCandidates(list => list.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  }

  function decide(i: number, decision: Candidate['decision']) {
    setCandidates(list => list.map((c, n) => n === i ? {
      ...c, decision,
      replaces: decision === 'replace' && c.duplicates[0] ? [c.duplicates[0].id] : [],
    } : c));
  }

  const keeping = candidates.filter(c => c.decision !== 'skip');
  const replacing = candidates.filter(c => c.decision === 'replace').length;
  const skipping = candidates.length - keeping.length;

  async function save() {
    if (!keeping.length) return;
    setProblem(null); setSaid(null);
    setBusy('Saving.');
    const r = await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'commit',
        facts: keeping.map(c => ({
          topic: c.topic, body: c.body,
          source_note: source || 'Added by hand',
          replaces: c.replaces,
        })),
      }),
    }).then(r => r.json()).catch(() => ({ error: 'That could not be sent. Try again.' }));
    setBusy(null);

    if (r.error) { setProblem(r.message ?? r.error); return; }
    setCandidates([]);
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
      topic: fact.topic, body: fact.body,
      duplicates: [{ id: fact.id, topic: fact.topic, body: fact.body, reason: 'topic' as Reason, score: 1 }],
      decision: 'replace',
      replaces: [fact.id],
    }]);
    setSource(fact.source_note ?? '');
    setSaid('Loaded below. Change it and save - the old wording is retired, not overwritten.');
    document.querySelector('#review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function retire(fact: Fact) {
    if (!confirm(`Withdraw "${fact.topic}"? LOTS AI stops answering from it immediately. The record of it stays.`)) return;
    setBusy('Withdrawing it.');
    await fetch('/api/school-fact', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retire', id: fact.id }),
    }).catch(() => null);
    setBusy(null);
    setSaid(`"${fact.topic}" is withdrawn. It is in the withdrawn list at the bottom.`);
    load();
  }

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
            <button className="abtn" onClick={readText} disabled={!!busy || text.trim().length < 120}>
              Read it
            </button>
            <span className="anote">
              {text.trim().length < 120
                ? `${text.trim().length} of 120 characters minimum.`
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
            accept=".pdf,.doc,.docx,image/png,image/jpeg,image/webp"
            onChange={e => { readFiles(e.target.files); e.target.value = ''; }} />
          <p><b>Drop the handbook here</b>, or <button className="quiet" onClick={() => picker.current?.click()}>choose a file</button>.</p>
          <p className="anote">
            Up to five at a time. PDFs, Word documents, or a photograph of a page - a photograph is
            read by the vision model, so give it good light.
          </p>
          <label className="afield kwide" style={{ marginTop: 10 }}>
            <span>Where it came from</span>
            <input value={source} onChange={e => setSource(e.target.value)}
              placeholder="Staff handbook 2026" />
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

      {candidates.length > 0 && (
        <>
          <h2 id="review">Check these before they are saved</h2>
          {candidates.map((c, i) => (
            <div key={i} className={`kcand${c.decision === 'skip' ? ' off' : ''}`}>
              <div className="kfields">
                <label className="afield">
                  <span>Topic</span>
                  <input value={c.topic} onChange={e => edit(i, { topic: e.target.value })} />
                </label>
                <label className="afield kgrow">
                  <span>What the school says</span>
                  <textarea rows={3} value={c.body} onChange={e => edit(i, { body: e.target.value })} />
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
                        <input type="radio" name={`decision-${i}`} checked={c.decision === value}
                          onChange={() => decide(i, value)} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!c.duplicates.length && (
                <div className="arow">
                  <button className="quiet" onClick={() => decide(i, c.decision === 'skip' ? 'keep' : 'skip')}>
                    {c.decision === 'skip' ? 'Put it back' : 'Leave this one out'}
                  </button>
                </div>
              )}
            </div>
          ))}

          <div className="arow">
            <button className="abtn" onClick={save} disabled={!!busy || !keeping.length}>
              Save {keeping.length} fact{keeping.length === 1 ? '' : 's'}
            </button>
            <span className="anote">
              {replacing > 0 && `${replacing} replacing something already saved. `}
              {skipping > 0 && `${skipping} left out. `}
              Saved facts are answered from immediately.
            </span>
            <button className="quiet" onClick={() => { setCandidates([]); setSaid(null); }}>Discard the list</button>
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

      {!facts.length ? (
        <p className="anote">
          Nothing yet. Until something is here, LOTS AI answers a policy question by saying the
          records do not hold it - which is right, and useless.
        </p>
      ) : (
        <table className="atable">
          <thead>
            <tr><th>Topic</th><th>What it says</th><th>Where from</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {facts.map(f => (
              <tr key={f.id}>
                <td><b>{f.topic}</b></td>
                <td className="wrap">{f.body}</td>
                <td className="anote">{f.source_note ?? '—'}</td>
                <td>{WHEN(f.added_at)}<span className="anote">{f.app_user?.full_name ?? ''}</span></td>
                <td className="r">
                  <button className="quiet" onClick={() => editExisting(f)}>Edit</button>{' '}
                  <button className="quiet" onClick={() => retire(f)}>Withdraw</button>
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
            to be able to see what it was telling them at the time.
          </p>
          <table className="atable">
            <thead><tr><th>Topic</th><th>What it said</th><th>Withdrawn</th></tr></thead>
            <tbody>
              {retired.map(f => (
                <tr key={f.id} className="off">
                  <td><b>{f.topic}</b></td>
                  <td className="wrap">{f.body}</td>
                  <td>{WHEN(f.retired_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}
