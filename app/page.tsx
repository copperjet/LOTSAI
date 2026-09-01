'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CREST } from '@/lib/crest';
import { MARK } from '@/lib/mark';
import { friendly } from '@/lib/friendly';
import Ambience from './Ambience';

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
/**
 * A turn is data, not a rendered node.
 *
 * It used to be a React element, built at the moment the workflow finished and pushed
 * into an array. That had two costs. A turn could never be saved - an element is not
 * JSON, so a thread could not outlive the tab. And a turn could never change: the
 * opening sentence was rendered once with the agenda as it stood at sign-in, so
 * "3 lessons are still unevaluated" stayed on the screen after all three had been
 * evaluated. Everything else on the page updated; that paragraph could not.
 *
 * Now a turn says what kind it is and carries the payload the card needs, and
 * `renderTurn` draws it. The opening reads live state and re-renders with it.
 */
type TurnKind =
  | 'opening' | 'taskMenu' | 'said' | 'bound' | 'boundary' | 'notRecords'
  | 'calendar' | 'planPicker' | 'packPicker' | 'worksheetPicker' | 'uploadCard' | 'pasteCard'
  | 'plannerCard' | 'plannerExists' | 'plannerUncoded' | 'plannerFirst' | 'plannerMatch'
  | 'plannerApproved' | 'packCard' | 'packUncoded' | 'packFirst' | 'packMatch'
  | 'worksheetCard' | 'worksheetFirst' | 'worksheetMatch' | 'approved'
  | 'homeworkPicker' | 'homeworkCard' | 'homeworkFirst' | 'homeworkMatch'
  | 'evaluatePrompt' | 'evaluated' | 'queuedOffline'
  | 'bank' | 'reviewCard' | 'registry' | 'coverage';

/** A turn holding something that cannot be written to the database - a File the
 *  browser is still holding - is drawn but never saved with its thread. */
const EPHEMERAL: TurnKind[] = ['uploadCard'];

type Turn =
  | { who: 'user'; text: string }
  | { who: 'ai'; kind: TurnKind; data?: Record<string, unknown> };

type Coverage = { name: string; planned: number; taught: number; landed: number };
type Gap = {
  id: string; kind: string; year_group: string | null; subject: string | null;
  semester: number | null; detail: string; files: string[]; resolved_file: string | null;
};
type PlannerExisting = {
  plannerId: string; status: string; lessons: number; mine: boolean; author: string | null;
};
interface PlannerResult { plannerId: string; lessons: Lesson[]; gate: Gate; status?: string }
interface ReviewItem { id: string; class_name: string; teacher_name: string; gate?: Gate }


/**
 * What to call a thread in the rail.
 *
 * The teacher's own first words, or failing that the work that was started in it. Never
 * asked for: naming a conversation before having it is a chore, and a thread called
 * "CP4A Science - Week 2 planner" is easier to find again than one called "Untitled".
 */
const TURN_TITLES: Partial<Record<TurnKind, string>> = {
  taskMenu: 'New task', planPicker: 'Plan a week', packPicker: 'Study pack',
  worksheetPicker: 'Worksheet', uploadCard: 'From a file', pasteCard: 'From pasted notes',
  homeworkPicker: 'Homework', homeworkCard: 'Homework',
  plannerCard: 'Weekly planner', packCard: 'Study pack', worksheetCard: 'Worksheet',
  evaluatePrompt: 'Lesson evaluation', evaluated: 'Lesson evaluation',
  bank: 'Shared bank', reviewCard: 'Planner review', registry: 'Curriculum sign-off',
  coverage: 'Coverage', calendar: 'The term ahead',
};

function threadTitle(turns: Turn[]): string {
  const said = turns.find(t => t.who === 'user') as { text: string } | undefined;
  if (said?.text?.trim()) return said.text.trim().slice(0, 60);
  for (const t of turns) {
    if (t.who === 'ai' && TURN_TITLES[t.kind]) return TURN_TITLES[t.kind]!;
  }
  return 'New task';
}

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

interface ClassWeek {
  weekNumber: number; weekCommencing: string;
  status: string | null; signedOff: boolean; topic: string | null;
}
interface ClassCal { id: string; name: string; subject_id: string; year_group: string; weeks: ClassWeek[] }
/**
 * Who reviews, and who reads the meters.
 *
 * /api/agenda has always given everybody who is not a teacher the reviewer's day -
 * the sign-off queue and the submitted planners - and /api/review has always accepted
 * all four roles. Only this screen disagreed: it tested for 'hod' alone, so a
 * principal or an administrator was handed a head of department's agenda and a
 * teacher's chips underneath it, offering to plan classes they do not teach.
 */
const REVIEWER_ROLES = ['hod', 'coordinator', 'principal', 'admin'];
const ADMIN_ROLES = ['admin', 'principal'];

/** app_user.role is a database value. The rail is not the place to print one. */
const ROLE_SAYS: Record<string, string> = {
  teacher: 'Teacher', hod: 'Head of Department', coordinator: 'Coordinator',
  principal: 'Principal', admin: 'Administrator',
};

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
  objectives?: Objective[];
  /** v2 packs are pages of blocks, not units of topics. */
  pages?: { title: string; blocks: number }[];
  layout?: 'a4-landscape' | 'slide-16x9';
  objectiveSources?: { registry: number; matched: number; file: number };
  /** Objectives that did not come from the registry, for the teacher to confirm. */
  fromFile?: { ref: string | null; text: string; source: 'matched' | 'file' }[];
  fromUpload?: { filename: string; resolved: number; unresolved: string[] };
}
/** Shorter than this is not material to build from - /api/ingest/text refuses it too. */
const MIN_PASTE = 120;

/** Asking at length is still asking. */
function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith('?')
    || /^(what|why|how|when|where|which|who|whose|is|are|do|does|did|can|could|should|would|tell me|explain)\b/i.test(t);
}

interface UploadResult {
  uploadId: string; filename: string; textLength: number;
  files?: { filename: string; kind: string; textLength: number }[];
  refsFound: string[]; resolved: { ref: string; text: string; week_number: number }[];
  unresolved: string[]; note: string;
}
interface WorksheetResult {
  worksheetId: string | null; title: string; tasks: number; refs: string[];
  objectives?: Objective[];
}
interface WorksheetMatch {
  id: string; title: string; objective_refs: string[]; week_number: number;
  reuse_count: number; app_user?: { full_name: string } | null;
}
interface HomeworkResult {
  homeworkId: string | null; title: string;
  sections: number; questions: number; marks: number; minutes: number; refs: string[];
  objectives?: Objective[];
}
/** Homework and worksheets are matched the same way, so they share a match shape. */
type HomeworkMatch = WorksheetMatch;

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
  homework:  ['Setting the homework now. This takes about a minute.',
              'Reading the week’s objectives.',
              'Building the sections, easiest first.',
              'Marking it up and writing the answer key.',
              'Nearly there.'],
  packPdf:   ['Laying it out for print.', 'Putting the answer key at the end.'],
  evaluate:  ['Writing that up for your planner.', 'Tagging the objectives.'],
  approve:   ['Filing it in the shared bank.', 'Sending the PDF to your Drive folder.'],
  ask:       ['Let me have a look.'],
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
  const [mini, setMini] = useState(false);
  const [palette, setPalette] = useState(false);
  const [busy, setBusyPhases] = useState<string[] | null>(null);
  const saying = useBusyPhases(busy);
  /** One line, for the short waits that never get as far as a second phase. */
  const setBusy = (line: string | null) => setBusyPhases(line ? [line] : null);
  const [online, setOnline] = useState(true);
  const [draft, setDraft] = useState('');
  const [dropping, setDropping] = useState(false);
  const [openFolds, setOpenFolds] = useState<Record<string, boolean>>({});
  /** The thread being written into, and the ones to go back to. Null until there is
   *  something worth saving - an empty thread is not a thread. */
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<{ id: string; title: string }[]>([]);
  /** What loadAgenda last saw, for the callers that want the list back. State is not
   *  readable from inside the callback that set it. */
  const agendaRef = useRef<AgendaItem[]>([]);
  /** Set once the server says it cannot store threads - before migration 0015 is
   *  applied. Without it every turn posts a thread that cannot be created. */
  const noThreads = useRef(false);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const say = (kind: TurnKind, data?: Record<string, unknown>) =>
    setTurns(t => [...t, { who: 'ai', kind, data }]);
  const said = (text: string) => setTurns(t => [...t, { who: 'user', text }]);

  const loadAgenda = useCallback(async () => {
    const res = await fetch('/api/agenda').catch(() => null);
    // The session ended while the tab was open, or thirty days passed. Back to
    // the door rather than an empty screen that never explains itself.
    if (res?.status === 401) { window.location.href = '/signin'; return []; }
    // Anything else that failed leaves the agenda as it was. It must not throw:
    // the opening turn is pushed after this resolves, so a rejection here is a page
    // with a rail and no conversation on it at all.
    if (!res?.ok) return agendaRef.current;
    const r = await res.json().catch(() => null);
    if (!r) return agendaRef.current;
    setAgenda(r.items ?? []); setUser(r.user);
    setToday(r.today ?? []); setTodayDate(r.date ?? '');
    agendaRef.current = (r.items ?? []) as AgendaItem[];
    return agendaRef.current;
  }, []);

  useEffect(() => { loadAgenda().then(() => setTurns([{ who: 'ai', kind: 'opening' }])); }, [loadAgenda]);

  const loadThreads = useCallback(async () => {
    const r = await fetch('/api/threads').then(r => r.json()).catch(() => ({ threads: [] }));
    setThreads(r.threads ?? []);
  }, []);
  useEffect(() => { loadThreads(); }, [loadThreads]);

  /**
   * Save the thread, shortly after it stops changing.
   *
   * The whole conversation is written each time rather than the new turn appended: the
   * tab is the only writer, a thread is tens of rows, and a replace cannot lose a turn
   * to a race. The thread row itself is created here rather than by New task, so
   * opening the app and reading the agenda does not leave an empty thread behind - a
   * thread starts existing when something is said in it.
   *
   * The opening turn is not saved. It is a live view of the agenda (renderTurn), and a
   * saved copy of it would be exactly the frozen sentence this refactor exists to
   * remove.
   */
  useEffect(() => {
    const savable = turns.filter(t => t.who === 'user' || (t.kind !== 'opening' && !EPHEMERAL.includes(t.kind)));
    if (!savable.length) return;

    if (noThreads.current) return;

    const timer = setTimeout(async () => {
      let id = threadId;
      if (!id) {
        const made = await fetch('/api/threads', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: threadTitle(savable) }),
        }).then(r => r.json()).catch(() => ({ id: null }));
        id = made.id;
        if (!id) { noThreads.current = true; return; }   // pre-0015: draw it, do not save it
        setThreadId(id);
      }
      await fetch(`/api/threads/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: threadTitle(savable),
          turns: savable.map(t => t.who === 'user'
            ? { who: 'user', data: { text: t.text } }
            : { who: 'ai', kind: t.kind, data: t.data ?? {} }),
        }),
      }).catch(() => null);
      loadThreads();
    }, 900);
    return () => clearTimeout(timer);
  }, [turns, threadId, loadThreads]);

  /** Open a saved thread where it was left. Its cards work: they act on ids the turn
   *  carries, not on anything the workflow held in memory. */
  async function openThread(id: string) {
    const r = await fetch(`/api/threads/${id}`).then(r => r.json()).catch(() => null);
    if (!r || r.error) return;
    pending.current = null;                    // whatever was half-said belonged to the last thread
    setThreadId(id);
    setTurns([{ who: 'ai', kind: 'opening' }, ...(r.turns as Turn[])]);
  }
  useEffect(() => {
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
  /**
   * Drawn from `agenda` at render time, not from a snapshot taken when it was pushed.
   * loadAgenda() runs after every evaluation, submission and approval, so the sentence
   * and its Overdue pill follow the work rather than outliving it.
   */
  function opening() {
    const items = agenda;
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


  // ---------- drawing a turn --------------------------------------------
  /**
   * Every kind of thing LOTS AI can say, drawn from the turn's own payload.
   *
   * This is the other half of turns-as-data: the workflows above decide what happened
   * and record it, and this decides what that looks like. Keeping it inside App is
   * deliberate - a card's buttons call the same doOpen / openPack / doGenerate the
   * workflow would, so a card restored from a saved thread behaves exactly like one
   * that has just been made.
   */
  function renderTurn(t: Extract<Turn, { who: 'ai' }>): React.ReactNode {
    const d = (t.data ?? {}) as Record<string, unknown>;
    const text = String(d.text ?? '');

    switch (t.kind) {
      case 'opening':
        return opening();

      case 'taskMenu':
        return <TaskMenu role={user?.role ?? 'teacher'} onPick={startTask} actions={{
          plan: doPlanPicker, worksheet: doWorksheet, pack: doStudyPack, homework: doHomework,
          evaluate: doEvaluate, upload: () => doPackFromUpload(),
          review: doReview, registry: doRegistry, coverage: doCoverage, bank: doBank,
        }} />;

      case 'said':
        return <p className="said">{text}</p>;

      case 'bound':
        return <div className="bound"><p style={{ fontSize: 14 }}>{text}</p></div>;

      case 'boundary':
        return (
          <div className="bound">
            <div className="eyebrow" style={{ marginBottom: 7 }}>Not something I do</div>
            <p style={{ fontSize: 14 }}>
              That is open-ended work, and a general assistant will do it better than I will.
              Use <b>ChatGPT</b> or <b>Claude</b> for it.
            </p>
          </div>
        );

      case 'notRecords':
        return (
          <div className="c pad">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Not from the school&rsquo;s records</div>
            <p style={{ fontSize: 14.5, margin: 0 }}>{text}</p>
          </div>
        );

      case 'calendar': {
        const ahead = d.ahead as { week_number: number; week_commencing: string; week_type: string }[];
        const classes = d.classes as ClassCal[];
        return (<>
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
                  {classes.map(k => {
                    const wk = k.weeks.find(x => x.weekNumber === w.week_number);
                    const label = wk?.status ? `${k.name} - ${SAYS[wk.status] ?? wk.status}`
                                : !wk?.signedOff ? `${k.name} - not signed off yet`
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

      case 'planPicker':
        return <PlanPicker classes={d.classes as ClassCal[]} today={d.today as string}
                           onPick={(classId, weekNumber) => doMatch({ classId, weekNumber })} />;

      case 'packPicker':
        return <StudyPackPicker classes={d.classes as ClassCal[]} today={d.today as string}
                                onPick={(classId, weekFrom, weekTo) => doPackMatch({ classId, weekFrom, weekTo })}
                                onUpload={doPackFromUpload} />;

      case 'worksheetPicker':
        return <WorksheetPicker classes={d.classes as ClassCal[]}
                                onPick={(classId, weekNumber) => doWorksheetMatch(classId, weekNumber)} />;

      case 'uploadCard':
        return <UploadCard classes={d.classes as ClassCal[]} onBuild={doBuildFromUpload}
                           initial={d.initial as File[] | undefined} />;

      case 'pasteCard':
        return <PasteCard classes={d.classes as ClassCal[]} text={d.text as string} onBuild={doBuildFromUpload} />;

      case 'plannerCard': {
        const r = d.r as PlannerResult;
        return <PlannerCard r={r} mode={d.mode as string} onSubmit={() => doSubmit(r.plannerId)}
                            openFolds={openFolds} setOpenFolds={setOpenFolds} />;
      }

      case 'plannerExists': {
        const p = d.p as { classId: string; weekNumber: number }, e = d.e as PlannerExisting;
        return (<>
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

      case 'plannerUncoded': {
        const p = d.p as { classId: string; weekNumber: number };
        return (<>
          <p className="said">
            Week {p.weekNumber} is in the curriculum, but this overview gives its objectives in prose with
            no syllabus references. I will not invent codes, so I cannot match it against anyone else&rsquo;s
            work - I can still write the plan.
          </p>
          <div className="acts">
            <button className="btn primary" onClick={() => doGenerate(p, 'create')}>Write it anyway</button>
          </div>
        </>);
      }

      case 'plannerFirst': {
        const p = d.p as { classId: string; weekNumber: number };
        return (<>
          <p className="said">
            Nobody has planned <b>{(d.refs as string[]).join(' and ')}</b> for this year group yet. You are first -
            what you write becomes the starting point for the other streams.
          </p>
          <div className="acts">
            <button className="btn primary" onClick={() => doGenerate(p, 'create')}>Write it</button>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>about a minute</span>
          </div>
        </>);
      }

      case 'plannerMatch': {
        const p = d.p as { classId: string; weekNumber: number };
        const a = d.a as { id: string; author_name: string; week_number: number;
                           objective_refs: string[]; landed_rate: number | null; reuse_count: number };
        return (<>
          <p className="said">
            Week {p.weekNumber} is <b>{(d.refs as string[]).join(' and ')}</b>. Before generating anything I
            checked the shared bank - somebody has already done this week.
          </p>
          <div className="match">
            <div className="flag">◆ {String(d.why ?? '')}</div>
            <h3 style={{ fontSize: 18 }}>{a.author_name} - week {a.week_number}</h3>
            <div className="row" style={{ marginTop: 10 }}>
              {a.objective_refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
              {a.landed_rate != null && <span className="pill ok">{a.landed_rate}% of objectives landed</span>}
              <span className="pill grey">reused {a.reuse_count}×</span>
            </div>
            <div className="acts" style={{ marginTop: 15 }}>
              <button className="btn primary" onClick={() => doGenerate(p, 'adapt', a.id)}>Adapt it for this class</button>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                quicker - it only changes what differs
              </span>
            </div>
            <div className="acts" style={{ marginTop: 10 }}>
              <button className="quiet" onClick={() => doGenerate(p, 'reuse', a.id)}>Use it unchanged</button>
              <button className="quiet" onClick={() => doGenerate(p, 'create')}>Start fresh instead</button>
            </div>
          </div>
        </>);
      }

      case 'plannerApproved':
        return (<>
          <p className="said">Approved, and added to the bank where the rest of the year group can find it.</p>
          <div className="acts">
            <button className="btn" onClick={() => openPlannerPdf(d.plannerId as string)}>Open the PDF</button>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>on the school&rsquo;s own template</span>
          </div>
        </>);

      case 'packCard': {
        const r = d.r as PackResult;
        return <PackCard r={r} onOpen={() => openPack(r.studyPackId)}
                         onPdf={() => openPackPdf(r.studyPackId)}
                         onApprove={() => doApprovePack(r.studyPackId)} />;
      }

      case 'packUncoded': {
        const p = d.p as PackSpan;
        return (<>
          <p className="said">
            Weeks {p.weekFrom}-{p.weekTo} are stated in prose with no syllabus references. I will not invent
            codes, so I cannot match this against anyone else&rsquo;s pack - I can still build one.
          </p>
          <div className="acts">
            <button className="btn primary" onClick={() => doPackGenerate(p)}>Build it anyway</button>
          </div>
        </>);
      }

      case 'packFirst': {
        const p = d.p as PackSpan, refs = d.refs as string[];
        return (<>
          <p className="said">
            Weeks {p.weekFrom}-{p.weekTo} cover {refs.length} objective{refs.length === 1 ? '' : 's'}.
            Nobody has built a study pack for them yet - you are first.
          </p>
          <ObjectiveList objectives={d.objectives as Objective[] | undefined} refs={refs} />
          <div className="acts" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => doPackGenerate(p)}>Build it</button>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>about a minute</span>
          </div>
        </>);
      }

      case 'packMatch': {
        const p = d.p as PackSpan, refs = d.refs as string[], best = d.best as PackMatch;
        return (<>
          <p className="said">
            Weeks {p.weekFrom}-{p.weekTo} cover {refs.length} objective{refs.length === 1 ? '' : 's'}.
            Somebody has already built an approved pack for the same objectives.
          </p>
          <ObjectiveList objectives={d.objectives as Objective[] | undefined} refs={refs} />
          <div className="match">
            <h3 style={{ fontSize: 18 }}>{best.title}</h3>
            <div className="row" style={{ marginTop: 10 }}>
              {best.objective_refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
              <span className="pill grey">reused {best.reuse_count}×</span>
              {best.app_user?.full_name && <span className="pill grey">by {best.app_user.full_name}</span>}
            </div>
            <div className="acts" style={{ marginTop: 15 }}>
              <button className="btn primary" onClick={() => openPack(best.id, true)}>Open it, unchanged</button>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>ready now</span>
            </div>
            <div className="acts" style={{ marginTop: 10 }}>
              <button className="quiet" onClick={() => doPackGenerate(p)}>Build a new one instead</button>
            </div>
          </div>
        </>);
      }

      case 'homeworkPicker':
        return <WorksheetPicker classes={d.classes as ClassCal[]}
                                asks="Which class, and which week&rsquo;s objectives should the homework cover?"
                                onPick={(classId, weekNumber) => doHomeworkMatch(classId, weekNumber)} />;

      case 'homeworkCard': {
        const r = d.r as HomeworkResult;
        return <HomeworkCard r={r} onOpen={() => openHomework(r.homeworkId)}
                             onApprove={() => doApproveHomework(r.homeworkId)} />;
      }

      case 'homeworkFirst': {
        const classId = d.classId as string, weekNumber = d.weekNumber as number, refs = d.refs as string[];
        return (<>
          <p className="said">
            Week {weekNumber} covers {refs.length} objective{refs.length === 1 ? '' : 's'}. Nobody has
            set homework on them yet - you are first.
          </p>
          <ObjectiveList objectives={d.objectives as Objective[] | undefined} refs={refs} />
          <div className="acts" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => doHomeworkGenerate(classId, weekNumber)}>Set it</button>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>about a minute</span>
          </div>
        </>);
      }

      case 'homeworkMatch': {
        const classId = d.classId as string, weekNumber = d.weekNumber as number;
        const refs = d.refs as string[], best = d.best as HomeworkMatch;
        return (<>
          <p className="said">
            Week {weekNumber} covers {refs.length} objective{refs.length === 1 ? '' : 's'}. Somebody has
            already had homework approved for the same objectives.
          </p>
          <ObjectiveList objectives={d.objectives as Objective[] | undefined} refs={refs} />
          <div className="match">
            <h3 style={{ fontSize: 18 }}>{best.title}</h3>
            <div className="row" style={{ marginTop: 10 }}>
              {best.objective_refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
              <span className="pill grey">reused {best.reuse_count}×</span>
              {best.app_user?.full_name && <span className="pill grey">by {best.app_user.full_name}</span>}
            </div>
            <div className="acts" style={{ marginTop: 15 }}>
              <button className="btn primary" onClick={() => openHomework(best.id, true)}>Open it, unchanged</button>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>ready now</span>
            </div>
            <div className="acts" style={{ marginTop: 10 }}>
              <button className="quiet" onClick={() => doHomeworkGenerate(classId, weekNumber)}>Set a new one instead</button>
            </div>
          </div>
        </>);
      }

      case 'worksheetCard': {
        const r = d.r as WorksheetResult;
        return <WorksheetCard r={r} onOpen={() => openWorksheet(r.worksheetId)}
                              onApprove={() => doApproveWorksheet(r.worksheetId)} />;
      }

      case 'worksheetFirst': {
        const classId = d.classId as string, weekNumber = d.weekNumber as number, refs = d.refs as string[];
        return (<>
          <p className="said">
            Week {weekNumber} covers {refs.length} objective{refs.length === 1 ? '' : 's'}. Nobody has an
            approved worksheet for them yet - you are first.
          </p>
          <ObjectiveList objectives={d.objectives as Objective[] | undefined} refs={refs} />
          <div className="acts" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => doWorksheetGenerate(classId, weekNumber)}>Build it</button>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>about a minute</span>
          </div>
        </>);
      }

      case 'worksheetMatch': {
        const classId = d.classId as string, weekNumber = d.weekNumber as number;
        const refs = d.refs as string[], best = d.best as WorksheetMatch;
        return (<>
          <p className="said">
            Week {weekNumber} covers {refs.length} objective{refs.length === 1 ? '' : 's'}. Somebody has
            already had an approved worksheet for the same objectives.
          </p>
          <ObjectiveList objectives={d.objectives as Objective[] | undefined} refs={refs} />
          <div className="match">
            <h3 style={{ fontSize: 18 }}>{best.title}</h3>
            <div className="row" style={{ marginTop: 10 }}>
              {best.objective_refs.map(ref => <span key={ref} className="pill ref">{ref}</span>)}
              <span className="pill grey">reused {best.reuse_count}×</span>
              {best.app_user?.full_name && <span className="pill grey">by {best.app_user.full_name}</span>}
            </div>
            <div className="acts" style={{ marginTop: 15 }}>
              <button className="btn primary" onClick={() => openWorksheet(best.id, true)}>Open it, unchanged</button>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>ready now</span>
            </div>
            <div className="acts" style={{ marginTop: 10 }}>
              <button className="quiet" onClick={() => doWorksheetGenerate(classId, weekNumber)}>Build a new one instead</button>
            </div>
          </div>
        </>);
      }

      case 'approved': {
        const drive = (d.drive ?? {}) as { link?: string; mock?: boolean };
        return (<>
          <p className="said">
            Approved. It is in the shared bank now, and {String(d.what ?? 'the PDF')} has gone to the
            subject&rsquo;s Drive folder.
          </p>
          {drive.link && (
            <div className="acts">
              <a className="btn" href={drive.link} target="_blank" rel="noreferrer">Open it in Drive</a>
            </div>
          )}
          {drive.mock && <div className="row"><span className="pill grey">Demo</span></div>}
        </>);
      }

      case 'evaluatePrompt': {
        const lesson = d.lesson as { id: string; day_of_week: number; objectives: Objective[] };
        const refs = lesson.objectives.map(o => o.ref).filter(Boolean).join(', ');
        return (<>
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
      }

      case 'evaluated': {
        const r = d.r as { comment: string; landed: string[]; flagged: string[]; question: string | null };
        return (<>
          <p className="said">Recorded, and written into the Teacher&rsquo;s Comments box in the right register.</p>
          <div className="c pad">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Your planner now reads</div>
            <p style={{ fontSize: 13.5 }}>{r.comment}</p>
            <div className="row" style={{ marginTop: 11 }}>
              {r.landed.map(x => <span key={x} className="pill ok">{x} landed</span>)}
              {r.flagged.map(x => <span key={x} className="pill warn">{x} flagged</span>)}
            </div>
          </div>
          {r.question && <p className="said">{r.question}</p>}
        </>);
      }

      case 'queuedOffline':
        return <p className="said">
          Saved on this device. <b>{d.count as number} waiting to sync.</b> Capture never needs a
          connection - only generation does.
        </p>;

      case 'bank': {
        const bank = d.bank as Record<string, unknown>[];
        return (<>
          <p className="said">Everything approved for your year group, ranked by what happened in the classroom.</p>
          <div className="bgrid">
            {bank.map(b => (
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
          {!bank.length && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing approved yet. The first approved planner starts it.</p>}
        </>);
      }

      case 'reviewCard': {
        const it = d.it as ReviewItem;
        return <ReviewCard it={it} onDecide={(decision, comment) => decide(it.id, decision, comment)} />;
      }

      case 'registry':
        return <RegistryTurn r={d.r as Record<string, unknown>} onSignOff={signOff} />;

      case 'coverage':
        return (<>
          <p className="said">Computed from planners and evaluations. Nobody typed any of it.</p>
          <div className="c pad">
            {(d.coverage as Coverage[]).map(c => (
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

      default:
        return null;
    }
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
    // Asked before the planner check: "what is next on the calendar" is a
    // question about the term, not a request to start next week's planner.
    if (/calendar|term dates|which week|what week|when is week|what.{0,3}s next|whats next/.test(q)) return doCalendar();
    // Before the worksheet test, and before anything reaches lib/ask.ts: a request to
    // make teaching material is work, not a question, however it is phrased. "Put it on
    // a document" and "make it interactive" are the same request as the one that made
    // it - they used to land on the boundary card.
    if (/homework|home work|\bprep\b|assignment|take.?home/.test(q)) return doHomework();
    if (/worksheet|work sheet|task sheet|differentiat/.test(q)) return doWorksheet();
    if (/upload|photo|picture|image|scan|turn.*(pdf|file|document)|from a (pdf|file|document)/.test(q)) return doPackFromUpload();
    if (/study.?pack|revision|revise/.test(q)) return doStudyPack();
    if (/plan|planner|next week/.test(q) && plan) return doMatch(plan.payload as { classId: string; weekNumber: number });
    if (/how did|went|evaluat|period|lesson go/.test(q)) return doEvaluate();
    if (/find|resource|bank|search|shared/.test(q)) return doBank();
    if (/set homework/.test(q)) return doHomework();
    if (/review|approve|queue/.test(q)) return doReview();
    if (/registry|conflict|sign.?off/.test(q)) return doRegistry();
    if (/coverage/.test(q)) return doCoverage();
    // Long enough to be material rather than a question, and not phrased as one: a
    // teacher pasting the outcomes off a scheme of work wants a pack from them, not an
    // answer about them. Questions stay questions however long they run.
    if (text.trim().length >= MIN_PASTE && !isQuestion(text)) return doPackFromText(text.trim());
    // Nothing above started a workflow, which does not make this open-ended work.
    // The school's own calendar and registry answer a great many questions, and
    // refusing those was the router having no answer rather than the product
    // having a limit (lib/ask.ts).
    return doAsk(text);
  }

  /**
   * A question, rather than a request to do something.
   *
   * Three replies: an answer from the school's records, an answer that is not
   * from them and says so, and - for open-ended work - the boundary that was
   * always the right response to that.
   */
  async function doAsk(question: string) {
    setBusyPhases(PHASES.ask);
    const r = await fetch('/api/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    }).then(r => r.json()).catch(() => ({ error: 'offline' }));
    setBusy(null);

    if (r.error) {
      return say('bound', { text: 'I could not answer that just now. Try again in a moment.' });
    }
    if (r.kind === 'open_ended' || !r.answer) return boundary();
    if (r.kind === 'general') {
      return say('notRecords', { text: r.answer });
    }
    say('said', { text: r.answer });
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
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('plannerCard', { r, mode: r.mode });
  }

  function pickHit(h: Hit) {
    setPalette(false);
    if (h.kind === 'planner') return doOpen(h.payload.plannerId as string);
    if (h.kind === 'week') {
      const classId = h.payload.classId as string | null;
      if (!classId) return say('bound', { text: 'That week belongs to a subject you do not teach.' });
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
    if (!ahead.length) return say('said', { text: 'The 2026/27 calendar has no weeks left after today.' });

    say('calendar', { ahead, classes: cal.classes });
  }

  /**
   * The rail's New task: a clean thread, and everything LOTS AI can start.
   *
   * It used to clear the thread without saying so and then open a week picker, so the
   * button read as "start a weekly planner" - which is a quarter of what it does. The
   * planner is now one row of six, and the clearing is the point rather than a side
   * effect.
   */
  async function newTask() {
    await loadAgenda();
    pending.current = null;
    setThreadId(null);                         // the next thing said starts a new thread
    setTurns([{ who: 'ai', kind: 'opening' }, { who: 'ai', kind: 'taskMenu' }]);
  }

  /** Start a workflow from the task menu, naming it in the thread as a click would. */
  function startTask(label: string, run: () => void) {
    said(label);
    run();
  }

  /** The planner's own front door, when it is picked from the menu rather than the
   *  agenda: any class, any teaching week, not only the next one. */
  async function doPlanPicker() {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say('said', { text: 'You have no classes to plan for.' });
    say('planPicker', { classes: cal.classes, today: cal.today });
  }

  // ---------- planner ---------------------------------------------------
  async function doMatch(p: { classId: string; weekNumber: number }) {
    setBusyPhases(PHASES.match);
    const r = await fetch('/api/plan/match', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
    }).then(r => r.json());
    setBusy(null);

    if (r.blocked) return say('bound', { text: r.message });

    // Generation replaces the planner and deletes its lessons, taking any
    // evaluations with them. Where one already exists, opening it is the
    // default and replacing it has to be asked for by name.
    if (r.existing) {
      return say('plannerExists', { p, e: r.existing as PlannerExisting });
    }

    if (r.registry.uncoded) return say('plannerUncoded', { p });

    const best = r.matches?.[0];
    if (!best) return say('plannerFirst', { p, refs: r.registry.refs as string[] });

    say('plannerMatch', { p, refs: r.registry.refs as string[], why: best.why, a: best.artefact });
  }

  async function doGenerate(p: { classId: string; weekNumber: number }, mode: string, basisArtifactId?: string) {
    setBusyPhases(mode === 'reuse' ? PHASES.reuse : mode === 'adapt' ? PHASES.adapt : PHASES.plan);
    const r = await fetch('/api/plan/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...p, mode, basisArtifactId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('plannerCard', { r, mode });
  }

  async function doSubmit(plannerId: string) {
    const r = await fetch('/api/plan/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plannerId }),
    }).then(r => r.json());
    if (r.error) { say('bound', { text: r.message }); return false; }
    say('said', { text: 'Submitted. Your HOD sees the checks alongside it, so the review starts where it is weak.' });
    loadAgenda();
    return true;
  }

  // ---------- study packs -----------------------------------------------
  /** The front door: pick a class and a span of signed-off weeks. */
  async function doStudyPack() {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say('said', { text: 'You have no classes to build a pack for.' });
    say('packPicker', { classes: cal.classes, today: cal.today });
  }

  /** Search before generate. An approved pack for the same objectives is offered
   *  to open unchanged; otherwise the only path is to build one. */
  async function doPackMatch(p: PackSpan) {
    setBusyPhases(PHASES.match);
    const r = await fetch('/api/studypack/match', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
    }).then(r => r.json());
    setBusy(null);

    if (r.blocked) return say('bound', { text: r.message });

    if (r.uncoded) return say('packUncoded', { p });

    const refs = (r.refs ?? []) as string[];
    const objectives = (r.objectives ?? []) as Objective[];
    const best = r.matches?.[0] as PackMatch | undefined;
    if (!best) return say('packFirst', { p, refs, objectives });

    say('packMatch', { p, refs, objectives, best });
  }

  async function doPackGenerate(p: PackSpan) {
    setBusyPhases(PHASES.pack);
    const r = await fetch('/api/studypack/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('packCard', { r: r as PackResult });
  }

  /** Open a stored pack's HTML. `reuse` marks opening an approved pack from the
   *  bank unchanged, which is what the bank's reuse_count ranks by. */
  async function openPack(studyPackId: string | null, reuse = false) {
    if (!studyPackId) return;
    setBusy('Opening it.');
    const r = await fetch(`/api/studypack/generate?studyPackId=${studyPackId}${reuse ? '&reuse=1' : ''}`).then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say('bound', { text: 'The pack is saved. It is not quite ready to open - try again in a moment.' });
  }

  /** The printable companion — rendered on demand, since most packs stay on screen. */
  async function openPackPdf(studyPackId: string | null) {
    if (!studyPackId) return;
    setBusyPhases(PHASES.packPdf);
    const r = await fetch('/api/studypack/pdf', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studyPackId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.url) {
      window.open(r.url, '_blank');
      // The designed PDF is the pack's own page printed by a browser; when none can be
      // started the plain rendering stands in. It carries everything, but it looks
      // nothing like the pack on screen, and being told that is better than wondering.
      if (r.plain) say('said', { text: 'That is the plain version - the designed one could not be '
        + 'printed just now. Everything is in it. Opening the pack itself and printing from there '
        + 'gives you the designed one.' });
      return;
    }
    say('bound', { text: friendly('render_failed') });
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
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('approved', { what: 'the printable PDF', drive: r.drive ?? {} });
    loadAgenda();
  }

  /** The other door: a file the teacher already has. It is reconciled against the
   *  registry first — only the objectives the school's curriculum holds seed a pack. */
  async function doPackFromUpload(initial?: File[]) {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say('said', { text: 'You have no classes to check a file against.' });
    say('uploadCard', { classes: cal.classes, initial });
  }

  /**
   * Material pasted straight into the thread.
   *
   * A teacher with a paragraph of outcomes and no file had nowhere to put it: anything
   * the router did not recognise became a question for lib/ask.ts, so the notes came
   * back answered instead of built.
   */
  async function doPackFromText(text: string) {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say('said', { text: 'You have no classes to check this against.' });
    say('pasteCard', { classes: cal.classes, text });
  }

  /**
   * Files arriving from the clip, or dropped anywhere on the thread.
   *
   * The teacher's own turn names what they attached before anything is read, so
   * the file is in the conversation the moment they let go of it.
   */
  function attach(list: FileList | null) {
    const files = list ? [...list].slice(0, 5) : [];
    if (!files.length) return;
    said(files.length === 1 ? files[0].name : `${files.length} files`);
    return doPackFromUpload(files);
  }

  async function doBuildFromUpload(uploadId: string) {
    setBusyPhases(PHASES.pack);
    const r = await fetch('/api/studypack/from-upload', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('packCard', { r: r as PackResult });
  }

  // ---------- worksheets ------------------------------------------------
  /** Pick a class and a signed-off week, then generate a differentiated worksheet. */
  async function doWorksheet() {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say('said', { text: 'You have no classes to build a worksheet for.' });
    say('worksheetPicker', { classes: cal.classes });
  }

  /** Search before generate: offer an approved worksheet for the same objectives
   *  to reuse, otherwise build one. */
  async function doWorksheetMatch(classId: string, weekNumber: number) {
    setBusyPhases(PHASES.match);
    const r = await fetch('/api/worksheet/match', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classId, weekNumber }),
    }).then(r => r.json());
    setBusy(null);

    if (r.blocked) return say('bound', { text: r.message });

    const refs = (r.refs ?? []) as string[];
    const objectives = (r.objectives ?? []) as Objective[];
    const best = r.matches?.[0] as WorksheetMatch | undefined;
    if (!best) return say('worksheetFirst', { classId, weekNumber, refs, objectives });

    say('worksheetMatch', { classId, weekNumber, refs, objectives, best });
  }

  async function doWorksheetGenerate(classId: string, weekNumber: number) {
    setBusyPhases(PHASES.worksheet);
    const r = await fetch('/api/worksheet/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classId, weekNumber }),
    }).then(r => r.json());
    setBusy(null);
    if (r.blocked) return say('bound', { text: r.message });
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('worksheetCard', { r: r as WorksheetResult });
  }

  /** Open the worksheet's printable PDF. `reuse` marks opening an approved
   *  worksheet from the bank unchanged, which reuse_count ranks by. */
  async function openWorksheet(worksheetId: string | null, reuse = false) {
    if (!worksheetId) return;
    setBusy('Opening it.');
    const r = await fetch(`/api/worksheet/generate?worksheetId=${worksheetId}${reuse ? '&reuse=1' : ''}`).then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say('bound', { text: 'The worksheet is saved. Its printable version is not quite ready - try again in a moment.' });
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
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('approved', { what: 'the worksheet PDF', drive: r.drive ?? {} });
    loadAgenda();
  }

  // ---------- homework --------------------------------------------------
  /**
   * Homework, which used to have nowhere to go.
   *
   * "Can you create a homework for my CP4A Mathematics class" fell through the router
   * to lib/ask.ts, which answered it as prose in the chat as though a homework were a
   * fact from the school's records; the follow-up - "put it on a document, make it
   * interactive and colourful", which is precisely this product's job - got the
   * open-ended-work boundary. It now takes the same road every other artefact takes:
   * pick a class and a signed-off week, search the bank, then build.
   */
  async function doHomework() {
    const cal = await loadCalendar();
    if (!cal.classes.length) return say('said', { text: 'You have no classes to set homework for.' });
    say('homeworkPicker', { classes: cal.classes });
  }

  async function doHomeworkMatch(classId: string, weekNumber: number) {
    setBusyPhases(PHASES.match);
    const r = await fetch('/api/homework/match', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classId, weekNumber }),
    }).then(r => r.json());
    setBusy(null);

    if (r.blocked) return say('bound', { text: r.message });

    const refs = (r.refs ?? []) as string[];
    const objectives = (r.objectives ?? []) as Objective[];
    const best = r.matches?.[0] as HomeworkMatch | undefined;
    if (!best) return say('homeworkFirst', { classId, weekNumber, refs, objectives });

    say('homeworkMatch', { classId, weekNumber, refs, objectives, best });
  }

  async function doHomeworkGenerate(classId: string, weekNumber: number) {
    setBusyPhases(PHASES.homework);
    const r = await fetch('/api/homework/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classId, weekNumber }),
    }).then(r => r.json());
    setBusy(null);
    if (r.blocked) return say('bound', { text: r.message });
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('homeworkCard', { r: r as HomeworkResult });
  }

  /** Open the homework document. `reuse` marks opening approved homework from the
   *  bank unchanged, which reuse_count ranks by. */
  async function openHomework(homeworkId: string | null, reuse = false) {
    if (!homeworkId) return;
    setBusy('Opening it.');
    const r = await fetch(`/api/homework/generate?homeworkId=${homeworkId}${reuse ? '&reuse=1' : ''}`)
      .then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say('bound', { text: 'The homework is saved. It is not quite ready to open - try again in a moment.' });
  }

  async function doApproveHomework(homeworkId: string | null) {
    if (!homeworkId) return;
    setBusyPhases(PHASES.approve);
    const r = await fetch('/api/homework/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ homeworkId }),
    }).then(r => r.json());
    setBusy(null);
    if (r.error) return say('bound', { text: r.message ?? friendly(r.error) });
    say('approved', { what: 'the homework PDF', drive: r.drive ?? {} });
    loadAgenda();
  }

  // ---------- evaluation ------------------------------------------------
  async function doEvaluate() {
    setBusy('Let me see which lessons still need a note.');
    const r = await fetch('/api/evaluate').then(r => r.json());
    setBusy(null);
    const lesson = r.outstanding?.[0];
    if (!lesson) return say('said', { text: 'Every lesson so far has a note against it. Nothing to do.' });

    say('evaluatePrompt', { lesson });
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
      return say('queuedOffline', { count: queued.length });
    }

    setBusyPhases(PHASES.evaluate);
    const r = await fetch('/api/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lessonEntryId, raw }),
    }).then(r => r.json());
    setBusy(null);

    say('evaluated', { r });
    await loadAgenda();
    // Straight on to the next one. Waiting for another "Evaluate them" click is what
    // made a backlog feel like it was not going down: the count in the rail dropped and
    // the teacher was left looking at a finished turn.
    if (!r.question) await doEvaluate();
  }

  // ---------- the rest --------------------------------------------------
  async function doBank() {
    setBusy('Having a look in the shared bank.');
    const r = await fetch('/api/review?view=bank').then(r => r.json());
    setBusy(null);
    say('bank', { bank: (r.bank ?? []) as Record<string, unknown>[] });
  }

  async function doReview() {
    const r = await fetch('/api/review').then(r => r.json());
    if (!r.queue?.length) return say('said', { text: 'The queue is clear.' });
    say('reviewCard', { it: r.queue[0] });
  }

  async function decide(plannerId: string, decision: string, comment: string) {
    await fetch('/api/plan/submit', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plannerId, decision, comment }),
    }).then(r => r.json()).catch(() => null);
    if (decision === 'approved') say('plannerApproved', { plannerId });
    else say('said', { text: 'Returned to the teacher, with your comment attached to it.' });
    loadAgenda();
  }

  /** Open the approved planner's stored PDF. Rendered on approval; this fetches
   *  a fresh signed URL for it. */
  async function openPlannerPdf(plannerId: string) {
    setBusy('Opening it.');
    const r = await fetch(`/api/pdf/run?plannerId=${plannerId}`).then(r => r.json());
    setBusy(null);
    if (r.url) { window.open(r.url, '_blank'); return; }
    say('bound', { text: 'The printable version is not ready yet. It is made when the plan is approved.' });
  }

  async function doRegistry() {
    const r = await fetch('/api/review?view=registry').then(r => r.json());
    say('registry', { r });
  }

  /** One subject or twenty, in a single request: the queue after an import is
   *  twenty subjects long, and twenty confirmations of the same act is not review. */
  async function signOff(subjects: { yearGroup: string; subjectId: string }[]) {
    if (!subjects.length) return;
    await fetch('/api/review', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'sign_off', subjects }),
    });
    const what = subjects.length === 1
      ? `${subjects[0].yearGroup} ${subjects[0].subjectId} signed off. Planning is open for it now.`
      : `${subjects.length} subjects signed off. Planning is open for them now.`;
    say('said', { text: what });
    loadAgenda();
  }

  async function doCoverage() {
    const r = await fetch('/api/review?view=coverage').then(r => r.json());
    say('coverage', { coverage: (r.coverage ?? []) as Coverage[] });
  }

  function boundary() {
    say('boundary');
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
    const reviewer = REVIEWER_ROLES.includes(user?.role ?? 'teacher');
    const pool = reviewer
      ? ['Show me what needs reviewing', 'Curriculum sign-off', 'Coverage']
      : ['Plan next week', 'Set homework', 'Make a worksheet', 'Make a study pack', 'How did today go?'];
    const first = lead?.act ?? pool[0];
    const max = reviewer ? 3 : 5;
    return [first, ...pool.filter(p => p !== first)].slice(0, max);
  })();

  return (
    <div className="app">
      <Ambience />
      <nav className={`rail ${mini ? 'mini' : ''}`}>
        <div className="top">
          <img src={CREST} alt="Lusaka Oaktree School" />
          <div className="wordmark"><b>LOTS AI</b></div>
          <div className="tacts">
            <button className="railtog" onClick={() => setPalette(true)} title="Search (Ctrl+K)"
                    aria-label="Search planners, curriculum weeks and the shared bank">⌕</button>
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
          {threads.length > 0 && <>
            <div className="rgroup">Recent</div>
            {threads.map(t => (
              <button key={t.id} className={`ritem${t.id === threadId ? ' here' : ''}`}
                      onClick={() => openThread(t.id)} title={t.title}>
                {t.title}
              </button>
            ))}
          </>}
        </div>
        <div className="foot">
          <div className="conn">
            <span className={`sw ${online ? 'on' : ''}`}><i /></span>
            <span>{online ? 'Online' : 'Offline - capture still works'}</span>
          </div>
          {/* The one way in. /admin answers notFound() to everybody else, so this is
              shown to the roles that can actually open it and to nobody else. */}
          {user && ADMIN_ROLES.includes(user.role) && (
            <a className="adminlink" href="/admin">Administration</a>
          )}
          {user && <div className="acct">
            <span className="av">{user.name.split(' ').map(s => s[0]).join('')}</span>
            <span className="nm"><b>{user.name}</b><span>{ROLE_SAYS[user.role] ?? user.role}</span></span>
            <form method="post" action="/api/signout"><button className="signout" type="submit"
              title="Sign out">Sign out</button></form>
          </div>}
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
        </div>

        <TodayBox tasks={today} date={todayDate} onPick={runTask} />

        <div className={`thread${dropping ? ' dropping' : ''}`} ref={thread}
             onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
             onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false); }}
             onDrop={e => { e.preventDefault(); setDropping(false); attach(e.dataTransfer.files); }}>
          <div className="col">
            {turns.map((t, i) => t.who === 'user'
              ? <div key={i} className="turn user"><div className="bub">{t.text}</div></div>
              : <div key={i} className="turn"><img className="crest" src={MARK} alt="" /><div className="body">{renderTurn(t)}</div></div>)}
            {saying && <div className="turn"><img className="crest" src={MARK} alt="" />
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
              <input ref={picker} type="file" className="sr"
                     accept=".pdf,.docx,image/png,image/jpeg,image/webp" multiple
                     onChange={e => { attach(e.target.files); e.target.value = ''; }} />
              <button className="clip" onClick={() => picker.current?.click()}
                      title="Attach a file or a photo of a page"
                      aria-label="Attach a file or a photo of a page">&#128206;</button>
              <textarea ref={input} rows={1} value={draft}
                placeholder={pending.current ? 'Say how the lesson went…' : 'Ask, or just pick one above'}
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
    ? [['Your planners', '▤', hits.planners], ['Curriculum weeks', '▦', hits.weeks], ['Shared bank', '◈', hits.bank]]
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
              <small>{blocked ? 'Not signed off yet'
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
 * Objectives, in the curriculum's own words.
 *
 * Every card that offers to build something used to print the codes alone -
 * "4Rg.04 4Rs.01 4Rs.04" - because that is all the match routes sent. A code is an
 * index into the curriculum, not a statement of what the week teaches, and a teacher
 * deciding whether to generate is deciding about the objectives, not their numbers.
 *
 * Threads outlive the tab, so a turn saved before the routes carried the text still
 * has only `refs`. That case falls back to the old pill row rather than rendering
 * nothing.
 */
function ObjectiveList({ objectives, refs }: { objectives?: Objective[]; refs?: string[] }) {
  const list = objectives ?? [];
  if (!list.length) {
    return (
      <div className="row" style={{ gap: 5, marginTop: 8 }}>
        {(refs ?? []).map(ref => <span key={ref} className="pill ref">{ref}</span>)}
      </div>
    );
  }

  const SHOWN = 5;
  const row = (o: Objective, i: number) => (
    <li key={`${o.ref ?? ''}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 6 }}>
      {o.ref && <span className="pill ref" style={{ flex: 'none' }}>{o.ref}</span>}
      <span style={{ fontSize: 13.5 }}>{o.text}</span>
    </li>
  );

  return (
    <div style={{ marginTop: 8 }}>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {list.slice(0, SHOWN).map(row)}
      </ul>
      {list.length > SHOWN && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
            {list.length - SHOWN} more
          </summary>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {list.slice(SHOWN).map((o, i) => row(o, i + SHOWN))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * The curriculum sign-off card.
 *
 * Sign-off is one decision per subject, and after an import there are twenty of them
 * waiting. Twenty buttons meant twenty round trips and twenty confirmations of the
 * same act, so the subjects are ticked and signed off together - the reviewer still
 * decides each one, they just say so once. Every subject is logged separately, which
 * is what makes "who opened planning for CP1 English" answerable afterwards.
 *
 * It lives out here rather than inside the page component because it holds the
 * selection: a component declared inside a render is a new component on every render,
 * and its state is thrown away with it.
 */
function RegistryTurn({ r, onSignOff }: {
  r: Record<string, unknown>;
  onSignOff: (subjects: { yearGroup: string; subjectId: string }[]) => void;
}) {
  const gaps: Gap[] = (r.gaps as Gap[]) ?? [];
  const conflicts = gaps.filter(g => g.kind === 'conflict');
  const unreadable = gaps.filter(g => g.kind === 'unreadable');
  const unplaced = gaps.filter(g => g.kind === 'unclassified');
  const blocked = (r.blocked ?? []) as { year_group: string; subject_id: string; weeks: number; uncoded: number; source: string }[];

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [done, setDone] = useState(false);

  const key = (b: { year_group: string; subject_id: string }) => `${b.year_group}|${b.subject_id}`;
  const toggle = (k: string) => setPicked(p => {
    const next = new Set(p);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const all = () => setPicked(picked.size === blocked.length ? new Set() : new Set(blocked.map(key)));
  const send = (subjects: { yearGroup: string; subjectId: string }[]) => {
    setDone(true);
    onSignOff(subjects);
  };

  return (<>
    <p className="said">
      {blocked.length
        ? <>{blocked.length} imported subject{blocked.length === 1 ? '' : 's'} cannot be planned yet. I will not guess which file is current, and I will not invent a syllabus code.</>
        : <>Everything imported is signed off.</>}
    </p>

    {blocked.length > 0 && (
      <div className="c pad">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <label className="row" style={{ gap: 8, cursor: 'pointer', fontWeight: 600 }}>
            <input type="checkbox" checked={picked.size === blocked.length && blocked.length > 0}
                   onChange={all} aria-label="Select every subject" />
            {picked.size ? `${picked.size} selected` : 'Select all'}
          </label>
          <button className="btn primary" disabled={!picked.size || done}
                  onClick={() => send(blocked.filter(b => picked.has(key(b)))
                    .map(b => ({ yearGroup: b.year_group, subjectId: b.subject_id })))}>
            Sign off {picked.size || ''} subject{picked.size === 1 ? '' : 's'}
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
          Each one is recorded against your name separately.
        </p>
      </div>
    )}

    {blocked.map(b => (
      <div key={key(b)} className="c pad">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.has(key(b))} onChange={() => toggle(key(b))}
                   aria-label={`Select ${b.year_group} ${b.subject_id}`} />
            <b>{b.year_group} {b.subject_id}</b>
          </label>
          <button className="btn" disabled={done}
                  onClick={() => send([{ yearGroup: b.year_group, subjectId: b.subject_id }])}>
            Sign it off
          </button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
          {b.weeks} weeks imported, {b.uncoded} of them with no syllabus references.
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
              {g.files.map(f => <li key={f}>{f}</li>)}
            </ul>
          </details>
        ))}
      </div>
    )}

    {(unreadable.length > 0 || unplaced.length > 0) && (
      <details className="c pad">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          {unreadable.length} could not be read · {unplaced.length} not yet placed
        </summary>
      </details>
    )}
  </>);
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
          Or turn a file or a photo into one.
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
  const parts = r.pages?.length
    ? r.pages.map(p => ({ label: p.title, count: p.blocks, noun: 'section' }))
    : r.units.map(u => ({ label: u.label, count: u.topics, noun: 'topic' }));
  const fromFile = r.fromFile ?? [];

  return (
    <>
      <p className="said">
        Built. <b>{r.title}</b> - {fromFile.length
          ? <>the objectives below came from your file rather than the curriculum, and the pages,
            questions and glossary are written for the age group.</>
          : <>objectives are copied from the curriculum, and the pages, questions and glossary are
            written for the age group.</>}
      </p>
      <div className="c pad">
        <div className="eyebrow" style={{ marginBottom: 6 }}>What is in it</div>
        <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 13.5 }}>
          {parts.map((u, i) => (
            <li key={i}>{u.label} - {u.count} {u.noun}{u.count === 1 ? '' : 's'}</li>
          ))}
        </ul>
        <ObjectiveList objectives={r.objectives} refs={r.refs} />
        <div className="row" style={{ gap: 5, marginTop: 8 }}>
          <span className="pill grey">{r.glossary} glossary term{r.glossary === 1 ? '' : 's'}</span>
        </div>
      </div>

      {fromFile.length > 0 && (
        <div className="c pad" style={{ marginTop: 10 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Read from your file - please confirm before sharing
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {fromFile.map((o, i) => (
              <li key={i}>
                {o.ref ? <span className="pill ref">{o.ref}</span> : <span className="pill warn">no code</span>}{' '}
                {o.text}
                {o.source === 'matched' && <span style={{ color: 'var(--muted)' }}> (matched to the curriculum by wording)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

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
function WorksheetPicker({ classes, onPick, asks }: {
  classes: ClassCal[]; onPick: (classId: string, weekNumber: number) => void;
  /** Homework and a worksheet are picked identically - a class, then a signed-off
   *  week - so they share this, and only the question changes. */
  asks?: string;
}) {
  const [chosen, setChosen] = useState(classes[0]?.id ?? '');
  const k = classes.find(c => c.id === chosen) ?? classes[0];
  const weeks = k ? k.weeks.filter(w => w.signedOff).sort((a, b) => a.weekNumber - b.weekNumber) : [];

  if (!k) return null;

  return (
    <>
      <p className="said">{asks ?? 'Which class, and which week’s objectives should the worksheet cover?'}</p>
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
function HomeworkCard({ r, onOpen, onApprove }: {
  r: HomeworkResult; onOpen: () => void; onApprove: () => void;
}) {
  return (
    <>
      <p className="said">
        Set. <b>{r.title}</b> - {r.sections} section{r.sections === 1 ? '' : 's'}, {r.questions} question
        {r.questions === 1 ? '' : 's'}, {r.marks} mark{r.marks === 1 ? '' : 's'}, about {r.minutes} minutes.
        There is room to write on every question and an answer key at the back. Objectives are copied
        from the curriculum.
      </p>
      <div className="c pad">
        <ObjectiveList objectives={r.objectives} refs={r.refs} />
      </div>
      <div className="acts" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={onApprove}>Approve &amp; send to Drive</button>
        <button className="btn" onClick={onOpen}>Open the homework</button>
      </div>
    </>
  );
}

function WorksheetCard({ r, onOpen, onApprove }: {
  r: WorksheetResult; onOpen: () => void; onApprove: () => void;
}) {
  return (
    <>
      <p className="said">
        Built. <b>{r.title}</b> - {r.tasks} task{r.tasks === 1 ? '' : 's'}, each in three tiers
        (support, core, extension) with an answer key. Objectives are copied from the curriculum.
      </p>
      <div className="c pad">
        <ObjectiveList objectives={r.objectives} refs={r.refs} />
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
function UploadCard({ classes, onBuild, initial }: {
  classes: ClassCal[]; onBuild: (uploadId: string) => void;
  /** Files the teacher already attached, from the clip or a drop on the thread. */
  initial?: File[];
}) {
  const [chosen, setChosen] = useState(classes[0]?.id ?? '');
  const k = classes.find(c => c.id === chosen) ?? classes[0];
  const [files, setFiles] = useState<File[]>(initial ?? []);
  const [over, setOver] = useState(false);
  const [state, setState] = useState<'idle' | 'reading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [err, setErr] = useState('');

  // A photograph is worth showing back before it is sent: it is the only way a
  // teacher can tell they have taken the right page, the right way up.
  const [thumbs, setThumbs] = useState<{ name: string; url: string | null }[]>([]);
  useEffect(() => {
    const made = files.map(f => ({
      name: f.name,
      url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
    }));
    setThumbs(made);
    return () => made.forEach(t => { if (t.url) URL.revokeObjectURL(t.url); });
  }, [files]);

  function take(list: FileList | null) {
    setFiles(list ? [...list].slice(0, 5) : []);
    setState('idle'); setResult(null); setErr('');
  }

  async function reconcile() {
    if (!files.length || !k) return;
    setState('reading'); setErr(''); setResult(null);
    const fd = new FormData();
    // One field, repeated: several photographs of one worksheet are one document.
    for (const f of files) fd.append('file', f);
    fd.append('subjectId', k.subject_id); fd.append('yearGroup', k.year_group);
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
        {files.length
          ? <>Which subject {files.length === 1 ? 'is this' : 'are these'} for?</>
          : <>Which subject is this for?</>}
        {' '}I check every objective code in it against that subject&rsquo;s curriculum. If it names
        none, I read the outcomes it states instead and show you which are not the school&rsquo;s.
      </p>
      <div className="row" style={{ marginTop: 10, gap: 7 }}>
        {classes.map(c => (
          <button key={c.id} className={`chip ${c.id === k.id ? 'key' : ''}`} onClick={() => setChosen(c.id)}>
            {c.name}
          </button>
        ))}
      </div>

      <div className={`drop${over ? ' over' : ''}`}
           onDragOver={e => { e.preventDefault(); setOver(true); }}
           onDragLeave={() => setOver(false)}
           onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}>
        <label className="dropbtn">
          <input type="file" accept=".pdf,.docx,image/png,image/jpeg,image/webp" multiple
                 onChange={e => take(e.target.files)} />
          <span>Choose files</span>
        </label>
        <span className="drophint">or drop them here. Up to 5 - .pdf, .docx, or photographs of the pages.</span>

        {thumbs.length > 0 && (
          <div className="strip">
            {thumbs.map((t, i) => (
              <figure key={`${t.name}-${i}`} className="shot">
                {t.url
                  ? <img src={t.url} alt="" />
                  : <span className="doc" aria-hidden>{t.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'DOC'}</span>}
                <figcaption>{t.name}</figcaption>
                {state === 'reading' && <span className="shotwait" aria-hidden />}
                {state === 'done' && result?.files?.[i] && (
                  <figcaption className="read">Read</figcaption>
                )}
              </figure>
            ))}
          </div>
        )}

        <div className="acts" style={{ marginTop: 10 }}>
          <button className="btn" disabled={!files.length || state === 'reading'} onClick={reconcile}>
            {state === 'reading'
              ? (files.some(f => f.type.startsWith('image/')) ? 'Reading the pages…' : 'Reading and checking…')
              : 'Check against the curriculum'}
          </button>
          {files.some(f => f.type.startsWith('image/')) && (
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>photographs take a little longer</span>
          )}
        </div>
        {state === 'error' && <small className="cerr" style={{ display: 'block', marginTop: 8 }}>{err}</small>}
      </div>

      {state === 'done' && result && (
        <SourceResult result={result} onBuild={onBuild} noun="file" />
      )}
    </>
  );
}

/**
 * The third door: material that was never a file.
 *
 * Notes typed or pasted straight into the thread - a topic list, the outcomes off a
 * scheme of work, a paragraph from an email. It is reconciled and stored exactly as an
 * upload is (/api/ingest/text), so everything past this point - the pack, its PDF, the
 * approval that sends it to Drive - is the one path, not a weaker copy of it.
 *
 * The text stays editable here. A paste usually carries something the teacher did not
 * mean to send, and fixing it before the pack is written is cheaper than after.
 */
function PasteCard({ classes, text: initial, onBuild }: {
  classes: ClassCal[]; text: string; onBuild: (uploadId: string) => void;
}) {
  const [chosen, setChosen] = useState(classes[0]?.id ?? '');
  const k = classes.find(c => c.id === chosen) ?? classes[0];
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'idle' | 'reading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [err, setErr] = useState('');

  async function reconcile() {
    if (!k || text.trim().length < MIN_PASTE) return;
    setState('reading'); setErr(''); setResult(null);
    try {
      const r = await fetch('/api/ingest/text', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // The first line names the material, so the pack's footer says what it was
        // built from rather than "Pasted text".
        body: JSON.stringify({
          text, subjectId: k.subject_id, yearGroup: k.year_group,
          title: text.trim().split('\n')[0].slice(0, 60),
        }),
      }).then(r => r.json());
      if (r.error) { setState('error'); setErr(r.message ?? r.error); return; }
      setResult(r as UploadResult); setState('done');
    } catch { setState('error'); setErr('That could not be sent. Nothing was saved - try again.'); }
  }

  if (!k) return null;

  return (
    <>
      <p className="said">
        Which subject is this for? I check every objective code in it against that
        subject&rsquo;s curriculum. If it names none, I read the outcomes it states instead and
        show you which are not the school&rsquo;s.
      </p>
      <div className="row" style={{ marginTop: 10, gap: 7 }}>
        {classes.map(c => (
          <button key={c.id} className={`chip ${c.id === k.id ? 'key' : ''}`} onClick={() => setChosen(c.id)}>
            {c.name}
          </button>
        ))}
      </div>

      <div className="c pad" style={{ marginTop: 11 }}>
        <textarea className="paste" rows={8} value={text} onChange={e => setText(e.target.value)}
                  aria-label="The text the pack will be built from" />
        <div className="acts" style={{ marginTop: 10 }}>
          <button className="btn" disabled={state === 'reading' || text.trim().length < MIN_PASTE}
                  onClick={reconcile}>
            {state === 'reading' ? 'Reading and checking…' : 'Check against the curriculum'}
          </button>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {text.trim().length < MIN_PASTE
              ? `${MIN_PASTE - text.trim().length} more characters needed`
              : `${text.trim().length} characters`}
          </span>
        </div>
        {state === 'error' && <small className="cerr" style={{ display: 'block', marginTop: 8 }}>{err}</small>}
      </div>

      {state === 'done' && result && (
        <SourceResult result={result} onBuild={onBuild} noun="text" />
      )}
    </>
  );
}

/**
 * What reconciliation found, and the button that builds from it.
 *
 * Identical whether the material was a file or text a teacher pasted: the same resolved
 * and unresolved codes, the same rule that no resolved code is not a refusal - the
 * objectives are then read from the material itself and flagged for confirmation, never
 * silently adopted.
 */
function SourceResult({ result, onBuild, noun }: {
  result: UploadResult; onBuild: (uploadId: string) => void; noun: 'file' | 'text';
}) {
  return (
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
          <div className="eyebrow" style={{ margin: '11px 0 5px' }}>Not in the curriculum - never used</div>
          <div className="row" style={{ gap: 5 }}>
            {result.unresolved.map(ref => <span key={ref} className="pill warn">{ref}</span>)}
          </div>
        </>
      )}
      <div className="acts" style={{ marginTop: 13 }}>
        <button className="btn primary" disabled={!result.textLength}
                onClick={() => onBuild(result.uploadId)}>
          {result.resolved.length
            ? `Build from ${result.resolved.length} resolved objective${result.resolved.length === 1 ? '' : 's'}`
            : result.textLength
              ? `Build from the outcomes stated in the ${noun}`
              : `Nothing could be read from this ${noun}`}
        </button>
      </div>
    </div>
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


/**
 * Everything LOTS AI can start, on one card.
 *
 * The rail's New task used to clear the thread and open a week picker, so the button
 * read as "start a weekly planner" - a quarter of what the product does, and the only
 * quarter a new teacher ever found. The rest was reachable only by typing the right
 * word into the composer, which is exactly the "you never have to write a prompt"
 * promise the dock makes, broken.
 *
 * A row is drawn only if this role has somewhere for it to go, so the same card serves
 * a teacher and a head of department without either seeing the other's work.
 */
const TASKS: { id: string; label: string; note: string; roles: string[] }[] = [
  { id: 'plan', label: 'Plan a week', note: 'Any class, any signed-off week', roles: ['teacher'] },
  { id: 'worksheet', label: 'Make a worksheet', note: 'Support, core and extension of every task', roles: ['teacher'] },
  { id: 'homework', label: 'Set homework', note: 'A timed paper with an answer key', roles: ['teacher'] },
  { id: 'pack', label: 'Make a study pack', note: 'A span of weeks, to revise from', roles: ['teacher'] },
  { id: 'evaluate', label: 'Evaluate lessons taught', note: 'About thirty seconds each', roles: ['teacher'] },
  { id: 'upload', label: 'Build from a file', note: 'A photo or a document you already have', roles: ['teacher'] },
  // Every role /api/review accepts as a reviewer is offered the reviewer's work.
  // An administrator used to open this card to an empty list: the agenda had given
  // them twenty subjects to sign off and this menu offered them nothing to do.
  { id: 'review', label: 'Review submitted planners', note: 'The checks are already done', roles: ['hod', 'coordinator', 'principal', 'admin'] },
  { id: 'registry', label: 'Sign off the curriculum', note: 'Nobody can plan an unsigned week', roles: ['hod', 'coordinator', 'principal', 'admin'] },
  { id: 'coverage', label: 'See coverage', note: 'Computed, never typed', roles: ['hod', 'coordinator', 'principal', 'admin'] },
  { id: 'bank', label: 'Open the shared bank', note: 'What your colleagues have had approved', roles: ['teacher', 'hod', 'coordinator', 'principal', 'admin'] },
];

function TaskMenu({ role, actions, onPick }: {
  role: string;
  actions: Record<string, (() => void) | undefined>;
  onPick: (label: string, run: () => void) => void;
}) {
  const rows = TASKS.filter(t => t.roles.includes(role) && actions[t.id]);
  return (<>
    <p className="said">A clean start. What would you like to do?</p>
    <div className="acts" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 7 }}>
      {rows.map(t => (
        <button key={t.id} className="owed due" onClick={() => onPick(t.label, actions[t.id]!)}>
          <div className="t"><b>{t.label}</b><small>{t.note}</small></div>
        </button>
      ))}
    </div>
  </>);
}

function PlannerCard({ r, mode, onSubmit, openFolds, setOpenFolds }: {
  r: PlannerResult;
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
         : mode === 'reuse' ? <>Taken from the bank unchanged, and credited to whoever wrote it.</>
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
            label={`Checks - ${gate.passed} passed${gate.warnings ? `, ${gate.warnings} to look at` : ''}${gate.blocking ? `, ${gate.blocking} to fix first` : ''}`}>
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
  it: ReviewItem;
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
      <p className="said"><b>{it.class_name}</b>, submitted by {it.teacher_name}. The routine checks already passed - these are the ones worth your time.</p>
      <div className="gate">
        <header><h4>What the checks found</h4>
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
