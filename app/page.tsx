'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CREST } from '@/lib/crest';

/**
 * The chat shell (Addendum D section D5.1).
 *
 * The layout is the one every teacher already knows. The one thing changed is
 * that LOTS AI speaks first — it knows the timetable, so a blank prompt box is
 * never the price of entry. Typing works; it is just never required.
 *
 * Everything here is presentation. All grounding, model calls, metering and
 * gate logic live behind /api, server-side, where the API key is.
 */

type Kind = 'late' | 'due' | 'done';

interface AgendaItem {
  id: string; kind: Kind; lead: string; also?: string; act: string; q?: string; alt: string;
  intent: string; payload?: Record<string, unknown>; title: string; note: string; when: string;
}
interface Objective { ref: string | null; text: string }
interface Lesson {
  id: string; day_of_week: number; lesson_date: string; objectives: Objective[];
  methodology: string; resources: string; differentiation: string; is_recap: boolean;
}
interface TodayTask {
  id: string; label: string; note: string; done: boolean;
  intent?: string; payload?: Record<string, unknown>;
}
type EditField = 'methodology' | 'resources' | 'differentiation';
interface Check { id: string; status: 'pass' | 'warn' | 'block'; title: string; detail: string }
interface Gate { checks: Check[]; blocking: number; warnings: number; passed: number }
interface Turn { who: 'user' | 'ai'; text?: string; node?: React.ReactNode }

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

interface ClassWeek {
  weekNumber: number; weekCommencing: string;
  status: string | null; signedOff: boolean; topic: string | null;
}
interface ClassCal { id: string; name: string; subject_id: string; year_group: string; weeks: ClassWeek[] }
interface Person { email: string; full_name: string; role: string }

interface Hit { id: string; label: string; note: string; kind: string; payload: Record<string, unknown> }
interface SearchHits { planners: Hit[]; weeks: Hit[]; bank: Hit[] }

interface PackSpan { classId: string; weekFrom: number; weekTo: number }
interface PackMatch {
  id: string; title: string; objective_refs: string[]; week_from: number; week_to: number;
  reuse_count: number; app_user?: { full_name: string } | null;
}
interface PackResult {
  studyPackId: string | null; title: string;
  units: { label: string; topics: number }[]; refs: string[]; glossary: number;
  fromUpload?: { filename: string; resolved: number; unresolved: string[] };
}
interface UploadResult {
  uploadId: string; filename: string; textLength: number;
  refsFound: string[]; resolved: { ref: string; text: string; week_number: number }[];
  unresolved: string[]; note: string;
}
interface WorksheetResult {
  worksheetId: string | null; title: string; tasks: number; refs: string[];
}
interface WorksheetMatch {
  id: string; title: string; objective_refs: string[]; week_number: number;
  reuse_count: number; app_user?: { full_name: string } | null;
}

const WHEN = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * What LOTS AI says while it is working.
 *
 * Generation takes twenty seconds to a minute, which is long enough that one
 * frozen line reads as a hang. Each of these advances every six seconds and then
 * holds on the last, so the bubble is still saying something true at fifty
 * seconds without promising a finish time it cannot keep.
 */
const PHASES: Record<string, string[]> = {
  match:     ['On it. Let me see if someone has already done this one.'],
  plan:      ['Right, writing it now. This takes about a minute.',
              'Reading the week’s objectives.',
              'Splitting them across the periods.',
              'Nearly there.'],
  adapt:     ['Reading the plan your colleague had approved.',
              'Working out what your class needs that theirs did not.',
              'Writing only the difference.'],
  reuse:     ['Taking it across unchanged.'],
  pack:      ['Right, writing it now. This takes about a minute.',
              'Reading the objectives for those weeks.',
              'Writing the key ideas.',
              'Making the quizzes and the glossary.',
              'Nearly there.'],
  worksheet: ['Writing the tasks, in three levels.',
              'Reading the week’s objectives.',
              'Making a support version and an extension of each one.',
              'Nearly there.'],
  packPdf:   ['Laying it out for print.', 'Putting the answer key at the end.'],
  evaluate:  ['Writing that up for your planner.', 'Tagging the objectives.'],
  approve:   ['Filing it in the shared bank.', 'Sending the PDF to your Drive folder.'],
  ocr:       ['Reading the picture.',
              'Picking out the objective codes.',
              'Checking each one against the registry.'],
};

/** Advance a phase list every six seconds, holding on the last line. */
function useBusyPhases(phases: string[] | null) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    setAt(0);
    if (!phases || phases.length < 2) return;
    const h = setInterval(() => setAt(i => Math.min(i + 1, phases.length - 1)), 6000);
    return () => clearInterval(h);
  }, [phases]);
  return phases ? phases[Math.min(at, phases.length - 1)] : null;
}

const SAYS: Record<string, string> = {
  draft: 'drafted, not submitted', submitted: 'submitted for review',
  reviewed: 'reviewed', approved: 'approved', returned: 'returned by your HOD',
};

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);
  const [today, setToday] = useState<TodayTask[]>([]);
  const [todayDate, setTodayDate] = useState('');
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [me, setMe] = useState('');
  const [mini, setMini] = useState(false);
  const [palette, setPalette] = useState(false);
  const [spend, setSpend] = useState(0);
  const [busy, setBusyPhases] = useState<string[] | null>(null);
  const saying = useBusyPhases(busy);
  /** One line, for the short waits that never get as far as a second phase. */
  const setBusy = (line: string | null) => setBusyPhases(line ? [line] : null);
  const [online, setOnline] = useState(true);
  const [draft, setDraft] = useState('');
  const [openFolds, setOpenFolds] = useState<Record<string, boolean>>({});
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const say = (node: React.ReactNode) => setTurns(t => [...t, { who: 'ai', node }]);
  const said = (text: string) => setTurns(t => [...t, { who: 'user', text }]);

  const meter = (usage?: { cost: number } | null) => { if (usage) setSpend(s => s + usage.cost); };

  const loadAgenda = useCallback(async () => {
    const r = await fetch('/api/agenda').then(r => r.json());
    setAgenda(r.items); setUser(r.user);
    setToday(r.today ?? []); setTodayDate(r.date ?? '');
    return r.items as AgendaItem[];
  }, []);

  useEffect(() => { loadAgenda().then(items => setTurns([{ who: 'ai', node: opening(items) }])); }, [loadAgenda]);
  useEffect(() => {
    fetch('/api/whoami').then(r => r.json())
      .then(r => { setPeople(r.people ?? []); setMe(r.current ?? ''); })
      .catch(() => {});
    try { setMini(localStorage.getItem('lots_rail') === 'mini'); } catch { /* private mode */ }
  }, []);

  // Ctrl+B for the rail, / for search — the two every assistant already has.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLElement
        && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleRail(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      else if (e.key === '/' && !typing) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The teacher's own message should already be there by the time they look; the
  // reply is something arriving, so it slides. Smooth-scrolling both makes a turn
  // you just sent feel like it is being fetched from somewhere.
  useEffect(() => {
    const mine = turns[turns.length - 1]?.who === 'user';
    thread.current?.scrollTo({
      top: thread.current.scrollHeight, behavior: mine ? 'auto' : 'smooth',
    });
  }, [turns, busy]);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    setOnline(navigator.onLine);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // ---------- the opening sentence -------------------------------------
  function opening(items: AgendaItem[]) {
    const [first, second] = items;
    if (!first) return <p className="lead">Nothing is outstanding.</p>;
    const pressing = second && second.kind !== 'done' ? second : null;
    const rest = items.slice(pressing ? 2 : 1);
    const alt = pressing ?? (items.length > 1 ? items[items.length - 1] : null);

    // A question suits work that is merely due. It does not suit work already late.
    const sentence = first.kind === 'due' && !pressing
      ? <>{first.lead}.<br />{first.q ?? 'Shall I start?'}</>
      : pressing ? <>{first.lead}, and {pressing.also ?? pressing.lead}.</> : <>{first.lead}.</>;

    return (
      <>
        {first.kind === 'late' && <div><span className="pill bad">Overdue</span></div>}
        <p className="lead">{sentence}</p>
        <div className="acts">
          <button className="btn primary" onClick={() => run(first)}>{first.act}</button>
          {alt && <button className="quiet" onClick={() => run(alt)}>{alt.alt}</button>}
        </div>
        {rest.length > 0 && (
          <Fold id="more" label={`${rest.length} other thing${rest.length === 1 ? '' : 's'}`}
                open={openFolds} setOpen={setOpenFolds}>
            {rest.map(i => (
              <button key={i.id} className={`owed ${i.kind}`} onClick={() => run(i)}>
                <div className="t"><b>{i.title}</b><small>{i.note}</small></div>
                <span className="when">{i.when}</span>
              </button>
            ))}
          </Fold>
        )}
      </>
    );
  }

  // ---------- intents ---------------------------------------------------
  function run(item: AgendaItem) {
    said(item.act);
    return dispatch(item.intent, item.payload);
  }

  /** A today row starts exactly the workflow its agenda button would. */
  function runTask(task: TodayTask) {
    if (!task.intent) return;
    said(task.label);
    return dispatch(task.intent, task.payload);
  }

  function dispatch(intent: string, payload?: Record<string, unknown>) {
    if (intent === 'plan') return doMatch(payload as unknown as { classId: string; weekNumber: number });
    if (intent === 'evaluate') return doEvaluate();
    if (intent === 'bank') return doBank();
    if (intent === 'review') return doReview();
    if (intent === 'registry') return doRegistry();
    return doCoverage();
  }

  function route(text: string) {
    said(text);
    const q = text.toLowerCase();
    const plan = agenda.find(i => i.intent === 'plan');
    if (/cost|spend|price|budget/.test(q)) return doSpend();
    // Asked before the planner check: "what is next on the calendar" is a
    // question about the term, not a request to start next week's planner.
    if (/calendar|term dates|which week|what week|when is week|what.{0,3}s next|whats next/.test(q)) return doCalendar();
    if (/worksheet|work sheet|task sheet|differentiat/.test(q)) return doWorksheet();
    if (/upload|turn.*(pdf|file|document)|from a (pdf|file|document)/.test(q)) return doPackFromUpload();
    if (/study.?pack|revision|revise/.test(q)) return doStudyPack();
    if (/plan|planner|next week/.test(q) && plan) return doMatch(plan.payload as { classId: string; weekNumber: number });
    if (/how did|went|evaluat|period|lesson go/.test(q)) return doEvaluate();
    if (/find|resource|bank|search|shared/.test(q)) return doBank();
    if (/review|approve|queue/.test(q)) return doReview();
    if (/registry|conflict|sign.?off/.test(q)) return doRegistry();
    if (/coverage/.test(q)) return doCoverage();
    return boundary();
  }

  function toggleRail() {
    setMini(m => {
      const next = !m;
      try { localStorage.setItem('lots_rail', next ? 'mini' : 'full'); } catch { /* private mode */ }
      return next;
    });
  }

  /** Open a planner that already exists. No model call, nothing overwritten. */
  async function doOpen(plannerId: string) {
    setBusy('Getting it up for you.');
    const r = await fetch(`/api/plan/open?plannerId=${plannerId}`).then(r => r.json());
    setBusy(null);
    if (r.error) return say(<div className="bound"><p>{r.error}</p></div>);
    say(<PlannerCard r={r} mode={r.mode} onSubmit={() => doSubmit(r.plannerId)}
                     openFolds={openFolds} setOpenFolds={setOpenFolds} />);
  }

  function pickHit(h: Hit) {
    setPalette(false);
    if (h.kind === 'planner') return doOpen(h.payload.plannerId as string);
    if (h.kind === 'week') {
      const classId = h.payload.classId as string | null;
      if (!classId) return say(<div className="bound"><p style={{ fontSize: 14 }}>
        That week belongs to a subject you do not teach.
      </p></div>);
      return doMatch({ classId, weekNumber: h.payload.weekNumber as number });
    }
    return doBank();
  }

  // ---------- calendar and the plan picker ------------------------------

  async function loadCalendar() {
    setBusy('Looking at the term.');
    const r = await fetch('/api/calendar').then(r => r.json());
    setBusy(null);
    return r as {
      today: string; classes: ClassCal[];
      weeks: { week_number: number; week_commencing: string; week_type: string }[];
    };
  }

  /** What the term does next, and what is already against each week. */
  async function doCalendar() {
    const cal = await loadCalendar();
    const ahead = cal.weeks.filter(w => w.week_commencing >= cal.today).slice(0, 4);
    if (!ahead.length) return say(<p className="said">The 2026/27 calendar has no weeks left after today.</p>);

    say(<>
      <p className="said">Here is what the calendar does next. Pick a week to plan it.</p>
      {ahead.map(w => (
        <div key={w.week_number} className="c" style={{ padding: '12px 15px', marginTop: 10 }}>
          <div className="row" style={{ alignItems: 'center', gap: 9 }}>
            <b style={{ fontSize: 15 }}>Week {w.week_number}</b>
            <span className="pill grey">w/c {WHEN(w.week_commencing)}</span>
            {w.week_type !== 'teaching' && <span className="pill">{w.week_type}</span>}
          </div>
          {w.week_type === 'teaching' && (
            <div className="acts" style={{ marginTop: 10 }}>
              {cal.classes.map(k => {
                const wk = k.weeks.find(x => x.weekNumber === w.week_number);
                const label = wk?.status ? `${k.name} - ${SAYS[wk.status] ?? wk.status}`
                            : !wk?.signedOff ? `${k.name} - registry not signed off`
                            : `Plan ${k.name}`;
                return (
                  <button key={k.id} className="btn" disabled={!wk?.signedOff}
                          onClick={() => doMatch({ classId: k.id, weekNumber: w.week_number })}>
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </>);
  }

  /** The rail's New task: any class, any teaching week — not only the next one. */
  async function newTask() {
    const items = await loadAgenda();
    const cal = await loadCalendar();
    setTurns([{ who: 'ai', node: opening(items) }]);
    if (!cal.classes.length) return;
    say(<PlanPicker classes={cal.classes} today={cal.today}
                    onPick={(classId, weekNumber) => doMatch({ classId, weekNumber })} />);
  }

  // ---------- planner ---------------------------------------------------
  async function doMatch(p: { classId: string; weekNumber: number }) {
    setBusyPhases(PHASES.match);
    const r = await fetch('/api/plan/match', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
    }).then(r => r.json());
    setBusy(null);

    if (r.blocked) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.message}</p></div>);

    // Generation replaces the planner and deletes its lessons, taking any
    // evaluations with them. Where one already exists, opening it is the
    // default and replacing it has to be asked for by name.
    if (r.existing) {
      const e = r.existing as { plannerId: string; status: string; lessons: number; mine: boolean; author: string | null };
      return say(<>
        <p className="said">
          Week {p.weekNumber} already has a planner{e.mine ? '' : <> by <b>{e.author}</b></>} -
          {' '}{SAYS[e.status] ?? e.status}, {e.lessons} lesson{e.lessons === 1 ? '' : 's'}.
        </p>
        <div className="acts">
          <button className="btn primary" onClick={() => doOpen(e.plannerId)}>Open it</button>
          {e.mine && e.status === 'draft' && (
            <button className="btn" onClick={() => doGenerate(p, 'create')}>
              Replace this draft
            </button>
          )}
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Replacing writes a new plan over this one, and the notes against its lessons go with it.
          </span>
        </div>
      </>);
    }

    if (r.registry.uncoded) {
      return say(<>
        <p className="said">
          Week {p.weekNumber} is in the registry, but this overview states its objectives in prose with
          no syllabus references. I will not invent codes, so I cannot match it against anyone else&rsquo;s
          work - I can still write the plan.
        </p>
        <div className="acts">
          <button className="btn primary" onClick={() => doGenerate(p, 'create')}>Write it anyway</button>
        </div>
      </>);
    }

    const best = r.matches?.[0];
    if (!best) {
      return say(<>
        <p className="said">
          Nobody has planned <b>{r.registry.refs.join(' and ')}</b> for this year group yet. You are first -
          what you write becomes the starting point for the other streams.
        </p>
        <div className="acts">
          <button className="btn primary" onClick={() => doGenerate(p, 'create')}>Write it</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>about ${r.costs.create.toFixed(3)}</span>
        </div>
      </>);
    }

    const a = best.artefact;
    say(<>
      <p className="said">
        Week {p.weekNumber} is <b>{r.registry.refs.join(' and ')}</b>. Before generating anything I
        checked the shared bank - somebody has already done this week.
      </p>
      <div className="match">
        <div className="flag">◆ {best.why}</div>
        <h3 style={{ fontSize: 18 }}>{a.author_name} - week {a.week_number}</h3>
        <div className="row" style={{ marginTop: 10 }}>
          {a.objective_refs.map((ref: string) => <span key={ref} className="pill ref">{ref}</span>)}
          {a.landed_rate != null && <span className="pill ok">{a.landed_rate}% of objectives landed</span>}
          <span className="pill grey">reused {a.reuse_count}×</span>
        </div>
        <div className="acts" style={{ marginTop: 15 }}>
          <button className="btn primary" onClick={() => doGenerate(p, 'adapt', a.id)}>Adapt it for this class</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            about ${r.costs.adapt.toFixed(3)} - it only writes the difference
          </span>
        </div>
        <div className="acts" style={{ marginTop: 10 }}>
          <button className="quiet" onClick={() => doGenerate(p, 'reuse', a.id)}>Use it unchanged, free</button>
          <button className="quiet" onClick={() => doGenerate(p, 'create')}>Start fresh instead</button>
        </div>
      </div>
    </>);
  }

  async function doGenerate(p: { classId: string; weekNumber: number }, mode: string, basisArtifactId?: string) {
    setBusyPhases(mode === 'reuse' ? PHASES.reuse : mode === 'adapt' ? PHASES.adapt : PHASES.plan);
    const r = await fetch('/api/plan/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...p, mode, basisArtifactId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say(<div className="bound"><p>{r.error}</p></div>);
    meter(r.usage);
    say(<PlannerCard r={r} mode={mode} onSubmit={() => doSubmit(r.plannerId)}
                     openFolds={openFolds} setOpenFolds={setOpenFolds} />);
  }

  async function doSubmit(plannerId: string) {
    const r = await fetch('/api/plan/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plannerId }),
    }).then(r => r.json());
    if (r.error) { say(<div className="bound"><p>{r.message}</p></div>); return false; }
    say(<p className="said">Submitted. Your HOD sees it with the gate results attached, so the review starts where it is weak.</p>);
    loadAgenda();
    return true;
  }

  // ---------- study packs -----------------------------------------------
  /** The front door: pick a class and a span of signed-off weeks. */
  async function doStudyPack() {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say(<p className="said">You have no classes to build a pack for.</p>);
    say(<StudyPackPicker classes={cal.classes} today={cal.today}
                         onPick={(classId, weekFrom, weekTo) => doPackMatch({ classId, weekFrom, weekTo })}
                         onUpload={doPackFromUpload} />);
  }

  /** Search before generate. An approved pack for the same objectives is offered
   *  to open unchanged; otherwise the only path is to build one. */
  async function doPackMatch(p: PackSpan) {
    setBusyPhases(PHASES.match);
    const r = await fetch('/api/studypack/match', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
    }).then(r => r.json());
    setBusy(null);

    if (r.blocked) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.message}</p></div>);

    if (r.uncoded) {
      return say(<>
        <p className="said">
          Weeks {p.weekFrom}-{p.weekTo} are stated in prose with no syllabus references. I will not invent
          codes, so I cannot match this against anyone else&rsquo;s pack - I can still build one.
        </p>
        <div className="acts">
          <button className="btn primary" onClick={() => doPackGenerate(p)}>Build it anyway</button>
        </div>
      </>);
    }

    const refs = (r.refs ?? []) as string[];
    const objectives = `${refs.length} objective${refs.length === 1 ? '' : 's'}`;

    const best = r.matches?.[0] as PackMatch | undefined;
    if (!best) {
      return say(<>
        <p className="said">
          Weeks {p.weekFrom}-{p.weekTo} cover {objectives}. Nobody has built a study pack for them yet -
          you are first.
        </p>
        <div className="row" style={{ gap: 5, marginTop: 8 }}>
          {refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
        </div>
        <div className="acts" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={() => doPackGenerate(p)}>Build it</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>about ${r.costs.create.toFixed(3)}</span>
        </div>
      </>);
    }

    say(<>
      <p className="said">
        Weeks {p.weekFrom}-{p.weekTo} cover {objectives}. Somebody has already built an approved pack for
        the same objectives.
      </p>
      <div className="match">
        <h3 style={{ fontSize: 18 }}>{best.title}</h3>
        <div className="row" style={{ marginTop: 10 }}>
          {best.objective_refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
          <span className="pill grey">reused {best.reuse_count}×</span>
          {best.app_user?.full_name && <span className="pill grey">by {best.app_user.full_name}</span>}
        </div>
        <div className="acts" style={{ marginTop: 15 }}>
          <button className="btn primary" onClick={() => openPack(best.id, true)}>Open it, unchanged</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>free - no AI call</span>
        </div>
        <div className="acts" style={{ marginTop: 10 }}>
          <button className="quiet" onClick={() => doPackGenerate(p)}>Build a new one instead</button>
        </div>
      </div>
    </>);
  }

  async function doPackGenerate(p: PackSpan) {
    setBusyPhases(PHASES.pack);
    const r = await fetch('/api/studypack/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say(<div className="bound"><p>{r.error}</p></div>);
    meter(r.usage);
    say(<PackCard r={r as PackResult} onOpen={() => openPack(r.studyPackId)}
                  onPdf={() => openPackPdf(r.studyPackId)}
                  onApprove={() => doApprovePack(r.studyPackId)} />);
  }

  /** Open a stored pack's HTML. `reuse` marks opening an approved pack from the
   *  bank unchanged, which is what the bank's reuse_count ranks by. */
  async function openPack(studyPackId: string | null, reuse = false) {
    if (!studyPackId) return;
    setBusy('Opening it.');
    const r = await fetch(`/api/studypack/generate?studyPackId=${studyPackId}${reuse ? '&reuse=1' : ''}`).then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say(<div className="bound"><p style={{ fontSize: 14 }}>
      The pack is saved, but its interactive HTML has not rendered yet. Try again in a moment.
    </p></div>);
  }

  /** The printable companion — rendered on demand, since most packs stay on screen. */
  async function openPackPdf(studyPackId: string | null) {
    if (!studyPackId) return;
    setBusyPhases(PHASES.packPdf);
    const r = await fetch('/api/studypack/pdf', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studyPackId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say(<div className="bound"><p style={{ fontSize: 14 }}>
      The printable PDF could not be rendered. {r.error ? `(${r.error})` : ''} Try again in a moment.
    </p></div>);
  }

  /** Teacher approves the pack they built: it enters the shared bank and its
   *  printable PDF is delivered to the subject's Drive folder. */
  async function doApprovePack(studyPackId: string | null) {
    if (!studyPackId) return;
    setBusyPhases(PHASES.approve);
    const r = await fetch('/api/studypack/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studyPackId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.message ?? r.error}</p></div>);
    const d = r.drive ?? {};
    say(<>
      <p className="said">
        Approved. It is in the shared bank now, and the printable PDF has gone to the subject&rsquo;s
        Drive folder.
      </p>
      {d.link && (
        <div className="acts">
          <a className="btn" href={d.link} target="_blank" rel="noreferrer">Open it in Drive</a>
        </div>
      )}
      {d.mock && <div className="row"><span className="pill grey">Demo</span></div>}
    </>);
    loadAgenda();
  }

  /** The other door: a file the teacher already has. It is reconciled against the
   *  registry first — only the objectives the school's curriculum holds seed a pack. */
  async function doPackFromUpload() {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say(<p className="said">You have no classes to reconcile a file against.</p>);
    say(<UploadCard classes={cal.classes} onBuild={doBuildFromUpload} />);
  }

  async function doBuildFromUpload(uploadId: string) {
    setBusyPhases(PHASES.pack);
    const r = await fetch('/api/studypack/from-upload', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.message ?? r.error}</p></div>);
    meter(r.usage);
    say(<PackCard r={r as PackResult} onOpen={() => openPack(r.studyPackId)}
                  onPdf={() => openPackPdf(r.studyPackId)}
                  onApprove={() => doApprovePack(r.studyPackId)} />);
  }

  // ---------- worksheets ------------------------------------------------
  /** Pick a class and a signed-off week, then generate a differentiated worksheet. */
  async function doWorksheet() {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say(<p className="said">You have no classes to build a worksheet for.</p>);
    say(<WorksheetPicker classes={cal.classes}
                         onPick={(classId, weekNumber) => doWorksheetMatch(classId, weekNumber)} />);
  }

  /** Search before generate: offer an approved worksheet for the same objectives
   *  to reuse, otherwise build one. */
  async function doWorksheetMatch(classId: string, weekNumber: number) {
    setBusyPhases(PHASES.match);
    const r = await fetch('/api/worksheet/match', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classId, weekNumber }),
    }).then(r => r.json());
    setBusy(null);

    if (r.blocked) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.message}</p></div>);

    const refs = (r.refs ?? []) as string[];
    const best = r.matches?.[0] as WorksheetMatch | undefined;
    if (!best) {
      return say(<>
        <p className="said">
          Week {weekNumber} covers {refs.length} objective{refs.length === 1 ? '' : 's'}. Nobody has an
          approved worksheet for them yet - you are first.
        </p>
        <div className="row" style={{ gap: 5, marginTop: 8 }}>
          {refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
        </div>
        <div className="acts" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={() => doWorksheetGenerate(classId, weekNumber)}>Build it</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>about ${r.costs.create.toFixed(3)}</span>
        </div>
      </>);
    }

    say(<>
      <p className="said">
        Week {weekNumber} covers {refs.length} objective{refs.length === 1 ? '' : 's'}. Somebody has
        already had an approved worksheet for the same objectives.
      </p>
      <div className="match">
        <h3 style={{ fontSize: 18 }}>{best.title}</h3>
        <div className="row" style={{ marginTop: 10 }}>
          {best.objective_refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
          <span className="pill grey">reused {best.reuse_count}×</span>
          {best.app_user?.full_name && <span className="pill grey">by {best.app_user.full_name}</span>}
        </div>
        <div className="acts" style={{ marginTop: 15 }}>
          <button className="btn primary" onClick={() => openWorksheet(best.id, true)}>Open it, unchanged</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>free - no AI call</span>
        </div>
        <div className="acts" style={{ marginTop: 10 }}>
          <button className="quiet" onClick={() => doWorksheetGenerate(classId, weekNumber)}>Build a new one instead</button>
        </div>
      </div>
    </>);
  }

  async function doWorksheetGenerate(classId: string, weekNumber: number) {
    setBusyPhases(PHASES.worksheet);
    const r = await fetch('/api/worksheet/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classId, weekNumber }),
    }).then(r => r.json());
    setBusy(null);
    if (r.blocked) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.message}</p></div>);
    if (r.error) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.error}</p></div>);
    meter(r.usage);
    say(<WorksheetCard r={r as WorksheetResult}
                       onOpen={() => openWorksheet(r.worksheetId)}
                       onApprove={() => doApproveWorksheet(r.worksheetId)} />);
  }

  /** Open the worksheet's printable PDF. `reuse` marks opening an approved
   *  worksheet from the bank unchanged, which reuse_count ranks by. */
  async function openWorksheet(worksheetId: string | null, reuse = false) {
    if (!worksheetId) return;
    setBusy('Opening it.');
    const r = await fetch(`/api/worksheet/generate?worksheetId=${worksheetId}${reuse ? '&reuse=1' : ''}`).then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say(<div className="bound"><p style={{ fontSize: 14 }}>
      The worksheet is saved, but its PDF has not rendered yet. Try again in a moment.
    </p></div>);
  }

  /** Teacher approves the worksheet: it enters the shared bank and its PDF is
   *  delivered to the subject's Drive folder. */
  async function doApproveWorksheet(worksheetId: string | null) {
    if (!worksheetId) return;
    setBusyPhases(PHASES.approve);
    const r = await fetch('/api/worksheet/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worksheetId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say(<div className="bound"><p style={{ fontSize: 14 }}>{r.message ?? r.error}</p></div>);
    const d = r.drive ?? {};
    say(<>
      <p className="said">
        Approved. It is in the shared bank now, and the worksheet PDF has gone to the subject&rsquo;s
        Drive folder.
      </p>
      {d.link && (
        <div className="acts">
          <a className="btn" href={d.link} target="_blank" rel="noreferrer">Open it in Drive</a>
        </div>
      )}
      {d.mock && <div className="row"><span className="pill grey">Demo</span></div>}
    </>);
    loadAgenda();
  }

  // ---------- evaluation ------------------------------------------------
  async function doEvaluate() {
    setBusy('Let me see which lessons still need a note.');
    const r = await fetch('/api/evaluate').then(r => r.json());
    setBusy(null);
    const lesson = r.outstanding?.[0];
    if (!lesson) return say(<p className="said">Every lesson so far has a note against it. Nothing to do.</p>);

    const refs = (lesson.objectives as Objective[]).map(o => o.ref).filter(Boolean).join(', ');
    say(<>
      <p className="lead">
        {DAYS[lesson.day_of_week]} - {refs || lesson.objectives[0]?.text?.slice(0, 60)}.<br />How did it go?
      </p>
      <div className="acts">
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {online ? 'Say it however you like, in the box below. Twenty seconds is plenty.'
                  : 'You are offline - this will save on this device and sync later.'}
        </span>
      </div>
    </>);
    input.current?.focus();
    pending.current = lesson.id;
  }

  const pending = useRef<string | null>(null);

  async function recordEvaluation(raw: string) {
    const lessonEntryId = pending.current;
    if (!lessonEntryId) return route(raw);
    pending.current = null;

    // Capture is offline-first (Addendum D section D7). The note is kept with the
    // time it was spoken, and sent when there is a connection.
    if (!online) {
      const queued = JSON.parse(localStorage.getItem('lots.pending') ?? '[]');
      queued.push({ lessonEntryId, raw, capturedAt: new Date().toISOString() });
      localStorage.setItem('lots.pending', JSON.stringify(queued));
      return say(<p className="said">Saved on this device. <b>{queued.length} waiting to sync.</b> Capture never needs a connection - only generation does.</p>);
    }

    setBusyPhases(PHASES.evaluate);
    const r = await fetch('/api/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lessonEntryId, raw }),
    }).then(r => r.json());
    setBusy(null);
    meter(r.usage);

    say(<>
      <p className="said">Recorded, and written into the Teacher&rsquo;s Comments box in the right register.</p>
      <div className="c pad">
        <div className="eyebrow" style={{ marginBottom: 6 }}>Your planner now reads</div>
        <p style={{ fontSize: 13.5 }}>{r.comment}</p>
        <div className="row" style={{ marginTop: 11 }}>
          {r.landed.map((x: string) => <span key={x} className="pill ok">{x} landed</span>)}
          {r.flagged.map((x: string) => <span key={x} className="pill warn">{x} flagged</span>)}
        </div>
      </div>
      {r.question && <p className="said">{r.question}</p>}
    </>);
    loadAgenda();
  }

  // ---------- the rest --------------------------------------------------
  async function doBank() {
    setBusy('Having a look in the shared bank.');
    const r = await fetch('/api/review?view=bank').then(r => r.json());
    setBusy(null);
    say(<>
      <p className="said">Everything approved for your year group, ranked by what happened in the classroom.</p>
      <div className="bgrid">
        {(r.bank ?? []).map((b: Record<string, unknown>) => (
          <div key={b.id as string} className="c bcard">
            <h4>{b.author_name as string} - week {b.week_number as number}</h4>
            <div className="row" style={{ gap: 5 }}>
              {((b.objective_refs as string[]) ?? []).map(x => <span key={x} className="pill ref">{x}</span>)}
            </div>
            {b.landed_rate != null ? (
              <div>
                <div className="kv"><span>Objectives landed</span><b className="num">{b.landed_rate as number}%</b></div>
                <div className="bar-t"><i style={{ width: `${b.landed_rate}%` }} /></div>
              </div>
            ) : <div className="kv"><span>Objectives landed</span><span>not taught yet</span></div>}
            <div className="kv"><span>Reused by colleagues</span><b className="num">{b.reuse_count as number}×</b></div>
          </div>
        ))}
      </div>
      {!r.bank?.length && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing approved yet. The first approved planner starts it.</p>}
    </>);
  }

  async function doReview() {
    const r = await fetch('/api/review').then(r => r.json());
    if (!r.queue?.length) return say(<p className="said">The queue is clear.</p>);
    const it = r.queue[0];
    say(<ReviewCard it={it} onDecide={(decision, comment) => decide(it.id, decision, comment)} />);
  }

  async function decide(plannerId: string, decision: string, comment: string) {
    await fetch('/api/plan/submit', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plannerId, decision, comment }),
    }).then(r => r.json()).catch(() => null);
    if (decision === 'approved') {
      say(<>
        <p className="said">Approved, and added to the bank where the rest of the year group can find it.</p>
        <div className="acts">
          <button className="btn" onClick={() => openPlannerPdf(plannerId)}>Open the PDF</button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>rendered on the school template</span>
        </div>
      </>);
    } else {
      say(<p className="said">Returned to the teacher, with your comment attached to it.</p>);
    }
    loadAgenda();
  }

  /** Open the approved planner's stored PDF. Rendered on approval; this fetches
   *  a fresh signed URL for it. */
  async function openPlannerPdf(plannerId: string) {
    setBusy('Opening it.');
    const r = await fetch(`/api/pdf/run?plannerId=${plannerId}`).then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say(<div className="bound"><p style={{ fontSize: 14 }}>
      The PDF has not rendered yet. It renders on approval - try again in a moment.
    </p></div>);
  }

  async function doRegistry() {
    const r = await fetch('/api/review?view=registry').then(r => r.json());
    type Gap = { id: string; kind: string; year_group: string | null; subject: string | null;
                 semester: number | null; detail: string; files: string[]; resolved_file: string | null };
    const gaps: Gap[] = r.gaps ?? [];
    const conflicts = gaps.filter(g => g.kind === 'conflict');
    const unreadable = gaps.filter(g => g.kind === 'unreadable');
    const unplaced = gaps.filter(g => g.kind === 'unclassified');

    say(<>
      <p className="said">
        {r.blocked?.length
          ? <>{r.blocked.length} imported subject{r.blocked.length === 1 ? '' : 's'} cannot be planned yet. I will not guess which file is current, and I will not invent a syllabus code.</>
          : <>Everything imported is signed off.</>}
      </p>

      {(r.blocked ?? []).map((b: { year_group: string; subject_id: string; weeks: number; uncoded: number; source: string }) => (
        <div key={`${b.year_group}-${b.subject_id}`} className="c pad">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{b.year_group} {b.subject_id}</b>
            <button className="btn" onClick={() => signOff(b.year_group, b.subject_id)}>Sign it off</button>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
            {b.weeks} weeks imported, {b.uncoded} of them with no syllabus references.
            {b.source && <> Source: <code>{b.source}</code></>}
          </p>
        </div>
      ))}

      {/* Before generation is even possible: files that never became weeks.
          A conflict needs a decision; the rest need a look. Detail folds away. */}
      {conflicts.length > 0 && (
        <div className="c pad">
          <b>{conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} need a decision</b>
          {conflicts.map(g => (
            <details key={g.id} style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
                {g.year_group} {g.subject} {g.semester ? `· S${g.semester}` : ''}
              </summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--muted)' }}>
                {g.files.map(f => <li key={f}><code>{f}</code></li>)}
              </ul>
            </details>
          ))}
        </div>
      )}

      {(unreadable.length > 0 || unplaced.length > 0) && (
        <details className="c pad">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            {unreadable.length} unreadable · {unplaced.length} unplaced file{unplaced.length === 1 ? '' : 's'}
          </summary>
        </details>
      )}
    </>);
  }

  async function signOff(yearGroup: string, subjectId: string) {
    await fetch('/api/review', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'sign_off', yearGroup, subjectId }),
    });
    say(<p className="said">{yearGroup} {subjectId} signed off. Planning is open for it now.</p>);
    loadAgenda();
  }

  async function doCoverage() {
    const r = await fetch('/api/review?view=coverage').then(r => r.json());
    say(<>
      <p className="said">Computed from planners and evaluations. Nobody typed any of it.</p>
      <div className="c pad">
        {(r.coverage ?? []).map((c: { name: string; planned: number; taught: number; landed: number }) => (
          <div key={c.name} style={{ marginBottom: 13 }}>
            <div className="kv" style={{ color: 'var(--ink)', fontWeight: 600 }}>
              <span>{c.name}</span>
              <span className="num">{c.planned ? Math.round(100 * c.taught / c.planned) : 0}% planned · {c.planned ? Math.round(100 * c.landed / c.planned) : 0}% landed</span>
            </div>
            <div className="bar-t"><i style={{ width: `${c.planned ? (100 * c.landed / c.planned) : 0}%` }} /></div>
          </div>
        ))}
      </div>
    </>);
  }

  function doSpend() {
    say(<p className="said">Every call is metered - workflow, model, tokens, cached tokens, cost. This session so far: <b>${spend.toFixed(4)}</b>.</p>);
  }

  function boundary() {
    say(
      <div className="bound">
        <div className="eyebrow" style={{ marginBottom: 7 }}>Not something I do</div>
        <p style={{ fontSize: 14 }}>
          That is open-ended work, and a general assistant will do it better than I will.
          Use <b>ChatGPT</b> or <b>Claude</b> for it.
        </p>
      </div>,
    );
  }

  // ---------- composer --------------------------------------------------
  function send() {
    const v = draft.trim();
    if (!v) return;
    setDraft('');
    if (pending.current) { said(v); recordEvaluation(v); }
    else route(v);
  }

  const chips = (() => {
    const lead = agenda[0];
    const pool = user?.role === 'hod'
      ? ['Show me what needs reviewing', 'Registry conflicts', 'Coverage']
      : ['Plan next week', 'Make a worksheet', 'Make a study pack', 'How did today go?'];
    const first = lead?.act ?? pool[0];
    const max = user?.role === 'hod' ? 3 : 4;
    return [first, ...pool.filter(p => p !== first)].slice(0, max);
  })();

  return (
    <div className="app">
      <nav className={`rail ${mini ? 'mini' : ''}`}>
        <div className="top">
          <img src={CREST} alt="LOTS AI" />
          <div className="wordmark"><b>LOTS AI</b><small>Lusaka Oaktree</small></div>
          <div className="tacts">
            <button className="railtog" onClick={() => setPalette(true)} title="Search (Ctrl+K)"
                    aria-label="Search planners, registry weeks and the shared bank">⌕</button>
            <button className="railtog" onClick={toggleRail} aria-expanded={!mini}
                    title={`${mini ? 'Expand' : 'Collapse'} the sidebar (Ctrl+B)`}>
              {mini ? '»' : '«'}
            </button>
          </div>
        </div>
        <button className="newbtn" onClick={newTask} title="New task">
          <span>✎</span> <span className="lbl">New task</span>
        </button>
        <div className="scroll">
          {agenda.map(i => (
            <button key={i.id} className="ritem" onClick={() => run(i)} title={i.title}>
              {i.title}<small>{i.note}</small>
            </button>
          ))}
        </div>
        <div className="foot">
          <div className="conn">
            <span className={`sw ${online ? 'on' : ''}`}><i /></span>
            <span>{online ? 'Online' : 'Offline - capture still works'}</span>
          </div>
          {user && <div className="acct"><span className="av">{user.name.split(' ').map(s => s[0]).join('')}</span>
            <span className="nm"><b>{user.name}</b><span>{user.role}</span></span></div>}
          {people.length > 1 && <>
            <label className="sr" htmlFor="whoami">Signed in as</label>
            <select id="whoami" className="railsel" value={me}
                    onChange={async e => {
                      const email = e.target.value;
                      setMe(email);
                      await fetch('/api/whoami', {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ email }),
                      });
                      // Everything on screen belongs to the person who just left.
                      const items = await loadAgenda();
                      setTurns([{ who: 'ai', node: opening(items) }]);
                    }}>
              {people.map(p => (
                <option key={p.email} value={p.email}>{p.full_name} - {p.role}</option>
              ))}
            </select>
          </>}
        </div>
      </nav>

      {palette && <SearchPalette
        agenda={agenda}
        onClose={() => setPalette(false)}
        onPick={pickHit}
        onAgenda={i => { setPalette(false); run(i); }} />}

      <div className="main">
        <div className="mtop">
          <h2>Semester 1 <span className="sub2">· 2026/27</span></h2>
          <button className="meter" onClick={doSpend}>
            <span className="dot" />AI spend <b className="num">${spend.toFixed(4)}</b>
          </button>
        </div>

        <TodayBox tasks={today} date={todayDate} onPick={runTask} />

        <div className="thread" ref={thread}>
          <div className="col">
            {turns.map((t, i) => t.who === 'user'
              ? <div key={i} className="turn user"><div className="bub">{t.text}</div></div>
              : <div key={i} className="turn"><img className="crest" src={CREST} alt="" /><div className="body">{t.node}</div></div>)}
            {saying && <div className="turn"><img className="crest" src={CREST} alt="" />
              <div className="body"><div className="typing">
                <p>{saying}</p>
                <span className="dots" aria-hidden><i /><i /><i /></span>
                <span className="sr" role="status">{saying}</span>
              </div></div></div>}
          </div>
        </div>

        <div className="dock">
          <div className="dockcol">
            <div className="chips">
              {chips.map((c, i) => (
                <button key={c} className={`chip ${i === 0 ? 'key' : ''}`} onClick={() => route(c)}>{c}</button>
              ))}
            </div>
            <div className="composer">
              <textarea ref={input} rows={1} value={draft}
                placeholder={pending.current ? 'Say how the lesson went…' : 'Ask, or just pick one above - you never have to write a prompt'}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="send" onClick={send} aria-label="Send">↑</button>
            </div>
            <p className="foot-note">For open-ended writing or research, use ChatGPT or Claude.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- pieces ------------------------------------------------------

function Fold({ id, label, children, open, setOpen }: {
  id: string; label: string; children: React.ReactNode;
  open: Record<string, boolean>; setOpen: (f: (o: Record<string, boolean>) => Record<string, boolean>) => void;
}) {
  return (
    <details className="d" open={!!open[id]}
             onToggle={e => setOpen(o => ({ ...o, [id]: (e.target as HTMLDetailsElement).open }))}>
      <summary><span className="cv">▶</span>{label}</summary>
      <div className="dbody">{children}</div>
    </details>
  );
}

/**
 * The day, in the corner (Addendum D section D5).
 *
 * Every row and every tick is derived in /api/agenda — a planner is ticked
 * because it is submitted, not because anybody ticked it. There is nothing to
 * check off by hand, which is the point: a list you maintain by hand is one more
 * thing owed, and this school already has enough of those.
 */
/**
 * Search, as a dialog you open and leave.
 *
 * Three things are worth finding — a planner you already have, a week in the
 * registry, and somebody's approved work — and the empty state offers what is
 * already outstanding rather than a blank box demanding a query
 * (Addendum D section D5.1).
 */
function SearchPalette({ agenda, onClose, onPick, onAgenda }: {
  agenda: AgendaItem[];
  onClose: () => void;
  onPick: (h: Hit) => void;
  onAgenda: (i: AgendaItem) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHits | null>(null);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => { box.current?.focus(); }, []);

  // Debounced, because every keystroke would otherwise be a round trip.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits(null); return; }
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(term)}`).then(r => r.json())
        .then(h => { setHits(h); setCursor(0); }).catch(() => setHits(null));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const groups: [string, string, Hit[]][] = hits
    ? [['Your planners', '▤', hits.planners], ['Registry weeks', '▦', hits.weeks], ['Shared bank', '◈', hits.bank]]
    : [];
  const flat = groups.flatMap(([, , g]) => g);

  const go = (n: number) => setCursor(c => Math.max(0, Math.min(flat.length - 1, c + n)));

  return (
    <div className="pal" role="dialog" aria-modal="true" aria-label="Search"
         onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palbox">
        <div className="paltop">
          <span aria-hidden>⌕</span>
          <input ref={box} value={q} placeholder="Search planners, weeks and the shared bank"
                 onChange={e => setQ(e.target.value)}
                 onKeyDown={e => {
                   if (e.key === 'Escape') onClose();
                   else if (e.key === 'ArrowDown') { e.preventDefault(); go(1); }
                   else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
                   else if (e.key === 'Enter' && flat[cursor]) onPick(flat[cursor]);
                 }} />
          <button className="palx" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="pallist">
          {!hits && (
            <>
              <div className="palgroup">Outstanding</div>
              {agenda.map(i => (
                <button key={i.id} className="palrow" onClick={() => onAgenda(i)}>
                  <i aria-hidden>▤</i>
                  <span className="pw"><b>{i.title}</b><small>{i.note}</small></span>
                </button>
              ))}
            </>
          )}

          {hits && !flat.length && <p className="palnone">Nothing matches “{q.trim()}”.</p>}

          {groups.filter(([, , g]) => g.length).map(([name, icon, g]) => (
            <div key={name}>
              <div className="palgroup">{name}</div>
              {g.map(h => (
                <button key={h.kind + h.id}
                        className={`palrow ${flat.indexOf(h) === cursor ? 'on' : ''}`}
                        onMouseEnter={() => setCursor(flat.indexOf(h))}
                        onClick={() => onPick(h)}>
                  <i aria-hidden>{icon}</i>
                  <span className="pw"><b>{h.label}</b><small>{h.note}</small></span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="palfoot"><span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span></div>
      </div>
    </div>
  );
}

/**
 * Pick a class, then a week. The agenda answers "what is due"; this answers
 * "I want a different one", which is the question the rail's New task used to
 * have no answer to.
 */
function PlanPicker({ classes, today, onPick }: {
  classes: ClassCal[]; today: string;
  onPick: (classId: string, weekNumber: number) => void;
}) {
  const [chosen, setChosen] = useState(classes[0]?.id ?? '');
  const k = classes.find(c => c.id === chosen) ?? classes[0];
  if (!k) return null;

  // Weeks already behind the school stay reachable — a late planner is still
  // owed — but the ones ahead come first.
  const weeks = [...k.weeks].sort((a, b) =>
    Number(b.weekCommencing >= today) - Number(a.weekCommencing >= today) || a.weekNumber - b.weekNumber);

  return (
    <>
      <p className="said">Which class, and which week?</p>
      <div className="row" style={{ marginTop: 10, gap: 7 }}>
        {classes.map(c => (
          <button key={c.id} className={`chip ${c.id === k.id ? 'key' : ''}`} onClick={() => setChosen(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="opts" style={{ marginTop: 13 }}>
        {weeks.map(w => {
          const blocked = !w.signedOff;
          return (
            <button key={w.weekNumber} className="opt" disabled={blocked}
                    style={blocked ? { opacity: .55, cursor: 'not-allowed' } : undefined}
                    onClick={() => onPick(k.id, w.weekNumber)}>
              <b>Week {w.weekNumber}</b>
              <small>w/c {WHEN(w.weekCommencing)}</small>
              <small>{blocked ? 'Registry not signed off'
                    : w.status ? (SAYS[w.status] ?? w.status)
                    : w.topic ? w.topic.slice(0, 48) : 'Not started'}</small>
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * Pick a class, then a span of weeks, for a study pack. A pack covers a run of
 * weeks rather than one, so this asks for a start and an end — over the same
 * signed-off teaching weeks the planner picker offers.
 */
function StudyPackPicker({ classes, today, onPick, onUpload }: {
  classes: ClassCal[]; today: string;
  onPick: (classId: string, weekFrom: number, weekTo: number) => void;
  onUpload: () => void;
}) {
  const [chosen, setChosen] = useState(classes[0]?.id ?? '');
  const k = classes.find(c => c.id === chosen) ?? classes[0];

  // Only signed-off teaching weeks can seed a pack (Addendum C §C7).
  const weeks = k ? k.weeks.filter(w => w.signedOff).sort((a, b) => a.weekNumber - b.weekNumber) : [];
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  // Reset the span whenever the class changes — its signed-off weeks differ.
  useEffect(() => { setFrom(null); setTo(null); }, [chosen]);

  if (!k) return null;

  const ready = from != null && to != null && to >= from;

  return (
    <>
      <p className="said">
        Which class, and which weeks should the pack cover?
        {' '}<button className="linkish" onClick={onUpload}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--muted)',
                       textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>
          Or turn a file into one.
        </button>
      </p>
      <div className="row" style={{ marginTop: 10, gap: 7 }}>
        {classes.map(c => (
          <button key={c.id} className={`chip ${c.id === k.id ? 'key' : ''}`} onClick={() => setChosen(c.id)}>
            {c.name}
          </button>
        ))}
      </div>

      {!weeks.length ? (
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }}>
          None of this class&rsquo;s weeks are signed off yet, so there is nothing to build from.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '13px 0 6px' }}>
            {from == null ? 'Pick the first week.' : 'Now pick the last week.'}
          </p>
          <div className="opts">
            {weeks.map(w => {
              const inSpan = from != null && to != null && w.weekNumber >= from && w.weekNumber <= to;
              const isFrom = w.weekNumber === from;
              const active = isFrom || inSpan;
              return (
                <button key={w.weekNumber} className={`opt ${active ? 'on' : ''}`}
                        style={active ? { borderColor: 'var(--brand, currentColor)' } : undefined}
                        onClick={() => {
                          // First click sets the start; second sets the end.
                          if (from == null || to != null) { setFrom(w.weekNumber); setTo(null); }
                          else if (w.weekNumber < from) { setTo(from); setFrom(w.weekNumber); }
                          else setTo(w.weekNumber);
                        }}>
                  <b>Week {w.weekNumber}</b>
                  <small>w/c {WHEN(w.weekCommencing)}</small>
                  <small>{w.topic ? w.topic.slice(0, 48) : 'Signed off'}</small>
                </button>
              );
            })}
          </div>
          <div className="acts" style={{ marginTop: 13 }}>
            <button className="btn primary" disabled={!ready}
                    onClick={() => ready && onPick(k.id, from!, to!)}>
              {ready ? `Find or build weeks ${from}-${to}` : 'Pick a start and end week'}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The generated pack, summarised. Objectives come from the registry; the pedagogy
 * is the model's. A pack enters the shared bank only once a reviewer approves it.
 */
function PackCard({ r, onOpen, onPdf, onApprove }: {
  r: PackResult; onOpen: () => void; onPdf: () => void; onApprove: () => void;
}) {
  return (
    <>
      <p className="said">
        Built. <b>{r.title}</b> - objectives are copied from the registry, the key ideas, quizzes and
        glossary are written for the age group.
      </p>
      <div className="c pad">
        <div className="eyebrow" style={{ marginBottom: 6 }}>What is in it</div>
        <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 13.5 }}>
          {r.units.map((u, i) => (
            <li key={i}>{u.label} - {u.topics} topic{u.topics === 1 ? '' : 's'}</li>
          ))}
        </ul>
        <div className="row" style={{ gap: 5 }}>
          {r.refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
          <span className="pill grey">{r.glossary} glossary term{r.glossary === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div className="acts" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={onApprove}>Approve &amp; send to Drive</button>
        <button className="btn" onClick={onOpen}>Open the study pack</button>
        <button className="btn" onClick={onPdf}>Download printable PDF</button>
      </div>
    </>
  );
}

/**
 * Pick a class, then one signed-off week, for a worksheet. A worksheet covers a
 * single week (its differentiation is the three tiers, not a span of weeks), so
 * this asks for one week rather than a range.
 */
function WorksheetPicker({ classes, onPick }: {
  classes: ClassCal[]; onPick: (classId: string, weekNumber: number) => void;
}) {
  const [chosen, setChosen] = useState(classes[0]?.id ?? '');
  const k = classes.find(c => c.id === chosen) ?? classes[0];
  const weeks = k ? k.weeks.filter(w => w.signedOff).sort((a, b) => a.weekNumber - b.weekNumber) : [];

  if (!k) return null;

  return (
    <>
      <p className="said">Which class, and which week&rsquo;s objectives should the worksheet cover?</p>
      <div className="row" style={{ marginTop: 10, gap: 7 }}>
        {classes.map(c => (
          <button key={c.id} className={`chip ${c.id === k.id ? 'key' : ''}`} onClick={() => setChosen(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {!weeks.length ? (
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }}>
          None of this class&rsquo;s weeks are signed off yet, so there is nothing to build from.
        </p>
      ) : (
        <div className="opts" style={{ marginTop: 13 }}>
          {weeks.map(w => (
            <button key={w.weekNumber} className="opt" onClick={() => onPick(k.id, w.weekNumber)}>
              <b>Week {w.weekNumber}</b>
              <small>w/c {WHEN(w.weekCommencing)}</small>
              <small>{w.topic ? w.topic.slice(0, 48) : 'Signed off'}</small>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The generated worksheet, summarised. Objectives come from the registry; the
 * tasks and their three tiers are the model's. Approving delivers the PDF to Drive.
 */
function WorksheetCard({ r, onOpen, onApprove }: {
  r: WorksheetResult; onOpen: () => void; onApprove: () => void;
}) {
  return (
    <>
      <p className="said">
        Built. <b>{r.title}</b> - {r.tasks} task{r.tasks === 1 ? '' : 's'}, each in three tiers
        (support, core, extension) with an answer key. Objectives are copied from the registry.
      </p>
      <div className="c pad">
        <div className="row" style={{ gap: 5 }}>
          {r.refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
        </div>
      </div>
      <div className="acts" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={onApprove}>Approve &amp; send to Drive</button>
        <button className="btn" onClick={onOpen}>Open the worksheet PDF</button>
      </div>
    </>
  );
}

/**
 * Turn a file into a study pack. The upload is reconciled against the registry
 * first — every objective code in it is matched against the school's own
 * curriculum, and only the ones that resolve seed the pack. A code the file names
 * but the curriculum does not hold is shown and never used (main spec §4).
 */
function UploadCard({ classes, onBuild }: {
  classes: ClassCal[]; onBuild: (uploadId: string) => void;
}) {
  const [chosen, setChosen] = useState(classes[0]?.id ?? '');
  const k = classes.find(c => c.id === chosen) ?? classes[0];
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<'idle' | 'reading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [err, setErr] = useState('');

  async function reconcile() {
    if (!file || !k) return;
    setState('reading'); setErr(''); setResult(null);
    const fd = new FormData();
    fd.append('file', file); fd.append('subjectId', k.subject_id); fd.append('yearGroup', k.year_group);
    try {
      const r = await fetch('/api/ingest/upload', { method: 'POST', body: fd }).then(r => r.json());
      if (r.error) { setState('error'); setErr(r.error); return; }
      setResult(r as UploadResult); setState('done');
    } catch { setState('error'); setErr('The upload failed. Nothing was saved - try again.'); }
  }

  if (!k) return null;

  return (
    <>
      <p className="said">
        Which subject is this file for? I match every objective code in it against that subject&rsquo;s
        registry, and build only from the ones the curriculum holds.
      </p>
      <div className="row" style={{ marginTop: 10, gap: 7 }}>
        {classes.map(c => (
          <button key={c.id} className={`chip ${c.id === k.id ? 'key' : ''}`} onClick={() => setChosen(c.id)}>
            {c.name}
          </button>
        ))}
      </div>

      <div className="c pad" style={{ marginTop: 12 }}>
        <input type="file" accept=".pdf,.docx"
               onChange={e => { setFile(e.target.files?.[0] ?? null); setState('idle'); setResult(null); }} />
        <div className="acts" style={{ marginTop: 10 }}>
          <button className="btn" disabled={!file || state === 'reading'} onClick={reconcile}>
            {state === 'reading' ? 'Reading and reconciling…' : 'Reconcile against the registry'}
          </button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>.pdf or .docx</span>
        </div>
        {state === 'error' && <small className="cerr" style={{ display: 'block', marginTop: 8 }}>{err}</small>}
      </div>

      {state === 'done' && result && (
        <div className="c pad" style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13.5, margin: '0 0 8px' }}>{result.note}</p>
          {result.resolved.length > 0 && (
            <>
              <div className="eyebrow" style={{ marginBottom: 5 }}>Resolved - these seed the pack</div>
              <div className="row" style={{ gap: 5 }}>
                {result.resolved.map(o => <span key={o.ref} className="pill ref">{o.ref}</span>)}
              </div>
            </>
          )}
          {result.unresolved.length > 0 && (
            <>
              <div className="eyebrow" style={{ margin: '11px 0 5px' }}>Not in the registry - never used</div>
              <div className="row" style={{ gap: 5 }}>
                {result.unresolved.map(ref => <span key={ref} className="pill warn">{ref}</span>)}
              </div>
            </>
          )}
          <div className="acts" style={{ marginTop: 13 }}>
            <button className="btn primary" disabled={!result.resolved.length}
                    onClick={() => onBuild(result.uploadId)}>
              {result.resolved.length
                ? `Build from ${result.resolved.length} resolved objective${result.resolved.length === 1 ? '' : 's'}`
                : 'Nothing resolved to build from'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function TodayBox({ tasks, date, onPick }: {
  tasks: TodayTask[]; date: string; onPick: (t: TodayTask) => void;
}) {
  const [open, setOpen] = useState(true);
  const [flashed, setFlashed] = useState<string[]>([]);
  const was = useRef<Record<string, boolean>>({});

  useEffect(() => {
    try { setOpen(localStorage.getItem('lots.today.collapsed') !== '1'); } catch { /* private window */ }
  }, []);

  // A task that has just ticked itself is worth a glance. The global
  // prefers-reduced-motion rule turns the animation off for anyone who asked.
  useEffect(() => {
    const flipped = tasks.filter(t => t.done && was.current[t.id] === false).map(t => t.id);
    was.current = Object.fromEntries(tasks.map(t => [t.id, t.done]));
    if (!flipped.length) return;
    setFlashed(flipped);
    const h = setTimeout(() => setFlashed([]), 1600);
    return () => clearTimeout(h);
  }, [tasks]);

  // A fully ticked list has nothing left to say, so it leaves the corner rather
  // than sitting there reading "4 of 4 done".
  //
  // It must not leave mid-tick, though. `was` is only written in the effect above,
  // so on the render where the last task flips it is still stale — which is how the
  // box knows to stay for this render, and `flashed` then holds it for the rest of
  // the 1600 ms animation. Reading it here rather than waiting for the effect is
  // what stops the box blinking out for a frame and back.
  const flipping = tasks.some(t => t.done && was.current[t.id] === false);
  if (!tasks.length || (tasks.every(t => t.done) && !flipping && !flashed.length)) return null;

  const done = tasks.filter(t => t.done).length;

  function toggle() {
    setOpen(o => {
      try { localStorage.setItem('lots.today.collapsed', o ? '1' : '0'); } catch { /* private window */ }
      return !o;
    });
  }

  const when = date
    ? new Date(date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    : '';

  return (
    <aside className="today" aria-label="Today">
      <button className="thead" onClick={toggle} aria-expanded={open}>
        <span className="tt"><b>Today</b>{when && <small>{when}</small>}</span>
        <span className={`tcount num ${done === tasks.length ? 'all' : ''}`}>{done}/{tasks.length}</span>
        <span className="cv" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <ul className="tlist">
          {tasks.map(t => {
            const inner = (
              <>
                <span className={`tick ${t.done ? 'on' : ''}`} aria-hidden>{t.done ? '✓' : ''}</span>
                <span className="tw"><b>{t.label}</b><small>{t.note}</small></span>
              </>
            );
            return (
              <li key={t.id} className={`${t.done ? 'done' : ''}${flashed.includes(t.id) ? ' flash' : ''}`}>
                {!t.done && t.intent
                  ? <button className="trow" onClick={() => onPick(t)}>{inner}</button>
                  : <div className="trow">{inner}</div>}
                <span className="sr">{t.done ? 'Done' : 'Not done'}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="tstrip">{done} of {tasks.length} done</p>
      )}
    </aside>
  );
}

/**
 * One editable field of one lesson.
 *
 * contentEditable rather than a textarea, so the table does not shift between
 * reading and writing. The typed text is never blocked on the network, saving is
 * on blur or Ctrl/Cmd+Enter, and there is no save button (Addendum D section D5
 * rule 6: undo everywhere, confirm nowhere). If a save fails the typed text stays
 * exactly where the teacher left it and the field says so (section D9 rule 3).
 */
function Cell({ lessonId, field, label, initial, editable, onGate }: {
  lessonId: string; field: EditField; label: string; initial: string;
  editable: boolean; onGate: (g: Gate) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stored = useRef(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [why, setWhy] = useState('');

  // The DOM owns the text while the teacher is typing; React only seeds it.
  useEffect(() => {
    if (box.current && document.activeElement !== box.current) box.current.textContent = initial;
    stored.current = initial;
  }, [initial]);

  async function save() {
    const value = (box.current?.textContent ?? '').trim();
    if (value === stored.current.trim()) { setState('idle'); return; }
    setState('saving');
    try {
      const res = await fetch('/api/plan/lesson', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lessonEntryId: lessonId, field, value }),
      });
      const r = await res.json();
      if (!res.ok || r.error) {
        setState('failed');
        setWhy(r.message ?? 'That change did not save. Your text is still here.');
        return;
      }
      stored.current = value;
      setWhy('');
      setState('saved');
      if (r.gate) onGate(r.gate as Gate);
      setTimeout(() => setState(st => (st === 'saved' ? 'idle' : st)), 1400);
    } catch {
      setState('failed');
      setWhy('No connection, so that change did not save. Your text is still here.');
    }
  }

  return (
    <div className="meth">
      <b>
        {label}
        {state === 'saving' && <span className="cmark">saving…</span>}
        {state === 'saved' && <span className="cmark ok">saved</span>}
        {state === 'failed' && <span className="cmark bad">not saved</span>}
      </b>
      <div
        ref={box}
        className={`cell${editable ? ' on' : ''}${state === 'failed' ? ' bad' : ''}`}
        contentEditable={editable}
        suppressContentEditableWarning
        role={editable ? 'textbox' : undefined}
        aria-multiline={editable ? true : undefined}
        aria-label={editable ? label : undefined}
        tabIndex={editable ? 0 : undefined}
        onBlur={editable ? save : undefined}
        onKeyDown={e => {
          if (!editable) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); box.current?.blur(); }
          if (e.key === 'Escape') {
            e.preventDefault();
            if (box.current) box.current.textContent = stored.current;
            setState('idle');
            box.current?.blur();
          }
        }}
      >
        {initial}
      </div>
      {state === 'failed' && <small className="cerr">{why}</small>}
    </div>
  );
}

function PlannerCard({ r, mode, onSubmit, openFolds, setOpenFolds }: {
  r: { plannerId: string; lessons: Lesson[]; gate: Gate; status?: string };
  mode: string; onSubmit: () => Promise<boolean>;
  openFolds: Record<string, boolean>;
  setOpenFolds: (f: (o: Record<string, boolean>) => Record<string, boolean>) => void;
}) {
  const { lessons } = r;
  const [gate, setGate] = useState<Gate>(r.gate);
  const [status, setStatus] = useState(r.status ?? 'draft');
  const [sending, setSending] = useState(false);
  const editable = status === 'draft' || status === 'returned';

  async function submit() {
    setSending(true);
    const ok = await onSubmit();
    setSending(false);
    if (ok) setStatus('submitted');
  }

  return (
    <>
      <p className="said">
        {mode === 'adapt' ? <>Adapted. The rest is exactly the plan your HOD already approved.</>
         : mode === 'reuse' ? <>Taken from the bank unchanged, and credited to its author. <b>No AI call.</b></>
         : <>Draft ready. Objective text is copied from the overview, never written by me.</>}
      </p>
      <div className="tblwrap">
        <table className="plan">
          <thead><tr>
            <th style={{ width: 80 }}>Day</th>
            <th style={{ width: '31%' }}>Unit / Objectives</th>
            <th>Methods &amp; Resources</th>
          </tr></thead>
          <tbody>
            {lessons.map((l, i) => (
              <tr key={l.id ?? i} className={l.is_recap ? 'diff' : ''}>
                <td className="day">{DAYS[l.day_of_week]}
                  <span>{new Date(l.lesson_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                  {l.is_recap && <span className="diff-tag">Recap</span>}
                </td>
                <td>{l.objectives.map((o, j) => (
                  <div key={j} className="obj">
                    {o.ref ? <span className="pill ref">{o.ref}</span> : <span className="pill warn">no syllabus ref</span>}
                    <p>{o.text}</p>
                  </div>
                ))}</td>
                <td>
                  <Cell lessonId={l.id} field="methodology" label="Methodology"
                        initial={l.methodology} editable={editable} onGate={setGate} />
                  <Cell lessonId={l.id} field="resources" label="Resources"
                        initial={l.resources} editable={editable} onGate={setGate} />
                  <Cell lessonId={l.id} field="differentiation" label="Differentiation"
                        initial={l.differentiation} editable={editable} onGate={setGate} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Fold id="gate" open={openFolds} setOpen={setOpenFolds}
            label={`Quality gate - ${gate.passed} passed${gate.warnings ? `, ${gate.warnings} to look at` : ''}${gate.blocking ? `, ${gate.blocking} blocking` : ''}`}>
        <ul className="gatelist">
          {gate.checks.map(c => (
            <li key={c.id} className={c.status === 'pass' ? 'p' : c.status === 'warn' ? 'w' : 'b'}>
              <span className="mk">{c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✕'}</span>
              <span><b>{c.title}</b><small>{c.detail}</small></span>
            </li>
          ))}
        </ul>
      </Fold>

      <div className="acts">
        <button className="btn primary" onClick={submit}
                disabled={gate.blocking > 0 || !editable || sending}>
          {!editable ? 'Submitted for review'
           : gate.blocking > 0 ? 'Fix the blocking items first'
           : sending ? 'Submitting…' : 'Submit for review'}
        </button>
      </div>
      {!editable && (
        <p style={{ fontSize: 12, color: 'var(--muted)' }}>
          This plan is with your HOD, so it is no longer editable.
        </p>
      )}
    </>
  );
}

/**
 * The review turn. The comment box is the HOD's own: required to return a
 * planner, because a plan sent back with no reason is only a delay.
 */
function ReviewCard({ it, onDecide }: {
  it: { id: string; class_name: string; teacher_name: string; gate?: Gate };
  onDecide: (decision: string, comment: string) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);

  async function go(decision: string) {
    setSent(true);
    await onDecide(decision, comment.trim());
  }

  return (
    <>
      <p className="said"><b>{it.class_name}</b>, submitted by {it.teacher_name}. Compliance already passed - these are the ones worth your time.</p>
      <div className="gate">
        <header><h4>What the gate found</h4>
          <span className="pill ok">{it.gate?.passed ?? 0} passed</span>
          {!!it.gate?.warnings && <span className="pill warn">{it.gate.warnings} to look at</span>}
        </header>
        <ul>{(it.gate?.checks ?? []).filter((c: Check) => c.status !== 'pass').map((c: Check) => (
          <li key={c.id} className="w"><span className="mk">!</span>
            <span><b>{c.title}</b><small>{c.detail}</small></span></li>
        ))}</ul>
      </div>
      <label className="cbox">
        <span className="eyebrow">Your comment to the teacher</span>
        <textarea rows={3} value={comment} disabled={sent}
                  onChange={e => setComment(e.target.value)}
                  placeholder="What should change, and why. Required if you send it back." />
      </label>
      <div className="acts">
        <button className="btn primary" disabled={sent} onClick={() => go('approved')}>Approve</button>
        <button className="quiet" disabled={sent || !comment.trim()} onClick={() => go('returned')}>
          Return with a comment
        </button>
        {!comment.trim() && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          A returned planner needs a reason attached.
        </span>}
      </div>
    </>
  );
}
