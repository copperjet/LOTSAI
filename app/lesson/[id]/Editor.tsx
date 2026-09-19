'use client';

/**
 * The lesson editor.
 *
 * Three panes: the slides down the left, the slide being worked on in the
 * middle, and everything about it that the class never sees down the right.
 *
 * THE CANVAS IS AN IFRAME of lib/lesson/render_html.ts, the same module that
 * renders the stored artefact and feeds the PowerPoint exporter. A React
 * re-implementation of twenty-one block types would have been easier to write
 * and would have meant a teacher approving a slide that looks one way and
 * exporting one that looks another. It also keeps the deck's stylesheet - which
 * is in millimetres and cqw and loads its own fonts - out of the application's.
 *
 * REORDERING IS BUTTONS AND KEYS, not drag and drop. There is no dnd-kit in this
 * project and adding one for this would be a dependency for an interaction that
 * is worse on a touchscreen, worse with a keyboard, and worse for anyone using a
 * screen reader. Alt+Up and Alt+Down move the selected slide.
 *
 * EVERY EDIT SAVES ITSELF. contentEditable, saved on blur or Ctrl+Enter,
 * reverted on Escape - the `Cell` pattern from app/page.tsx. Undo everywhere,
 * confirm nowhere (Addendum D section D5 rule 6); the one exception is deleting
 * a slide, which asks, because it is the only action here that destroys work.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendly } from '@/lib/friendly';
import {
  ARRANGE_LABEL, DIAGRAM_KINDS, PHASE_LABEL,
  type Arrangement, type LessonDeck, type Slide, type SlideBlock,
} from '@/lib/lesson/schema';
import { LESSON_PHASES } from '@/lib/lesson/schema';
import { hasReveal, renderSlideHtml } from '@/lib/lesson/render_html';
// From schema, not from lib/lesson/improve: that module imports the LLM client,
// sharp and pptxgenjs, none of which belong in a browser bundle.
import { IMPROVE_ACTIONS, IMPROVE_LABEL, type ImproveAction } from '@/lib/lesson/schema';
import type { GateResult, LessonCheck } from '@/lib/lesson/gate';
// Pure data - the palettes and their names - so it is safe in the browser.
import { THEMES } from '@/lib/studypack/themes';

interface Props {
  lessonId: string;
  deck: LessonDeck;
  gate: GateResult;
  approved: boolean;
  renderNote: string | null;
  driveLink: string | null;
  canEdit: boolean;
  assets: Record<string, string>;
  urls: { html: string; pdf: string; pptx: string };
}

type Busy = null | 'improve' | 'structure' | 'save' | 'export' | 'approve' | 'picture'
  | 'history' | 'rewrite';

interface Revision { n: number; instruction: string | null; created_at: string }

export default function Editor(props: Props) {
  const [deck, setDeck] = useState<LessonDeck>(props.deck);
  const [gate, setGate] = useState<GateResult>(props.gate);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  // Reveal is a presenting control: the answer goes up on the projected slide.
  // It resets whenever the slide changes, so moving on never shows the next
  // slide's answer before the class has tried it.
  const [revealed, setRevealed] = useState(false);
  const [barVisible, setBarVisible] = useState(true);
  const showRef = useRef<HTMLDivElement>(null);
  const [improveOpen, setImproveOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [approved, setApproved] = useState(props.approved);
  // Pictures arrive during editing, so the canvas's data URIs are state, seeded
  // from the server and added to as the teacher attaches or draws one.
  const [assets, setAssets] = useState<Record<string, string>>(props.assets);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);

  const slides = deck.slides ?? [];
  const slide: Slide | undefined = slides[at];
  const minutes = slides.reduce((n, s) => n + s.minutes, 0);
  const over = minutes > deck.meta.duration_minutes;
  const editable = props.canEdit && !approved;

  // Keep the selection inside the deck after a delete.
  useEffect(() => {
    if (at >= slides.length) setAt(Math.max(0, slides.length - 1));
  }, [slides.length, at]);

  const post = useCallback(async (path: string, body: unknown, method = 'POST') => {
    const r = await fetch(path, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message ?? friendly(j.error));
    return j;
  }, []);

  // ------------------------------------------------------------- structure

  const structural = useCallback(async (
    action: 'move' | 'duplicate' | 'delete' | 'insert',
    extra: Record<string, unknown> = {},
  ) => {
    if (!editable || !slide) return;
    setBusy('structure'); setProblem(null);
    try {
      const j = await post('/api/lesson/slides', {
        lessonId: props.lessonId, action, slideId: slide.id, ...extra,
      });
      setDeck(d => ({ ...d, slides: j.slides as Slide[] }));
      setGate(j.gate as GateResult);
      if (action === 'move') {
        setAt(Number(extra.to));
      } else if (action === 'duplicate') {
        setAt(at + 1);
      } else if (action === 'insert') {
        setAt(typeof extra.to === 'number' ? Number(extra.to) : at + 1);
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [editable, slide, at, post, props.lessonId]);

  const move = useCallback((delta: number) => {
    const to = at + delta;
    if (to < 0 || to >= slides.length) return;
    void structural('move', { to });
  }, [at, slides.length, structural]);

  // ------------------------------------------------------------ field edits

  /**
   * Save an edit to a slide - one at a time, against the latest version of it.
   *
   * The first version sent each edit as soon as it was made, built from the
   * slide as it stood when the teacher started typing. A teacher who changed a
   * question, then its answer, then the criteria - tabbing through at typing
   * speed - had three saves in flight at once, each carrying a copy of the block
   * from before the others landed, and the last one to arrive quietly put the
   * others back. The server has the same shape of race: two requests read the
   * deck, both write, the second wins.
   *
   * So edits queue, and an edit can be a function of the slide rather than a
   * value: it is worked out when its turn comes, from the slide as the previous
   * save left it. The slide id is captured when the edit is made, so switching
   * slides while a save is pending still saves to the slide that was edited.
   */
  const deckRef = useRef(deck);
  useEffect(() => { deckRef.current = deck; }, [deck]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const patch = useCallback((
    p: Record<string, unknown> | ((current: Slide) => Record<string, unknown>),
  ): Promise<boolean> => {
    if (!editable || !slide) return Promise.resolve(false);
    const slideId = slide.id;
    const run = async (): Promise<boolean> => {
      const current = deckRef.current.slides.find(x => x.id === slideId);
      if (!current) return false;
      setBusy('save'); setProblem(null);
      try {
        const body = typeof p === 'function' ? p(current) : p;
        const j = await post('/api/lesson/slide',
          { lessonId: props.lessonId, slideId, patch: body }, 'PATCH');
        const next = {
          ...deckRef.current,
          slides: deckRef.current.slides.map(x => (x.id === slideId ? (j.slide as Slide) : x)),
        };
        // Written through at once, not on the next render: the next queued edit
        // runs before React gets round to it.
        deckRef.current = next;
        setDeck(next);
        setGate(j.gate as GateResult);
        return true;
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(null);
      }
    };
    const result = queue.current.then(run, run);
    queue.current = result.catch(() => undefined);
    return result;
  }, [editable, slide, post, props.lessonId]);

  // --------------------------------------------------------------- improve

  const improve = useCallback(async (action: ImproveAction) => {
    if (!editable || !slide) return;
    setImproveOpen(false);
    setBusy('improve'); setProblem(null); setNote(null);
    try {
      const j = await post('/api/lesson/improve',
        { lessonId: props.lessonId, slideId: slide.id, action });
      setDeck(d => ({
        ...d,
        slides: d.slides.map(s => (s.id === slide.id ? (j.slide as Slide) : s)),
      }));
      setGate(j.gate as GateResult);
      setNote(j.note as string);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [editable, slide, post, props.lessonId]);

  // --------------------------------------------------------------- history

  /**
   * Every restore point, newest first. Each is the deck as it was *before* the
   * change named beside it - so restoring "Make it more visual" undoes exactly
   * that. Fetched when the panel opens rather than kept live: it is read rarely
   * and a teacher editing does not need it refreshed on every keystroke.
   */
  const openHistory = useCallback(async () => {
    setHistoryOpen(v => !v);
    if (historyOpen) return;
    setRevisions(null);
    try {
      const r = await fetch(`/api/lesson/revise?lessonId=${props.lessonId}`).then(r => r.json());
      setRevisions([...(r.revisions ?? [])].reverse() as Revision[]);
    } catch {
      setRevisions([]);
    }
  }, [historyOpen, props.lessonId]);

  const restore = useCallback(async (n: number) => {
    if (!editable) return;
    setBusy('history'); setProblem(null); setNote(null);
    try {
      const j = await post('/api/lesson/revise', { lessonId: props.lessonId, to: n }, 'PUT');
      setDeck(j.deck as LessonDeck);
      setGate(j.gate as GateResult);
      setHistoryOpen(false);
      setNote('Restored. The version you replaced is in the history too, so this can be undone.');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [editable, post, props.lessonId]);

  /** Undo = restore the newest restore point. */
  const undo = useCallback(async () => {
    const r = await fetch(`/api/lesson/revise?lessonId=${props.lessonId}`).then(r => r.json())
      .catch(() => ({ revisions: [] }));
    const list = (r.revisions ?? []) as Revision[];
    const last = list[list.length - 1];
    // Revision 1 is the deck as generated and is always there; with nothing
    // after it, there is nothing to undo.
    if (!last || list.length < 2) { setNote('There is nothing to undo yet.'); return; }
    await restore(last.n);
  }, [props.lessonId, restore]);

  // --------------------------------------------------------------- rewrite

  /** A teacher's own instruction, across this part of the lesson or all of it. */
  const rewrite = useCallback(async (instruction: string, scope: 'part' | 'all') => {
    if (!editable || !slide || !instruction.trim()) return;
    setBusy('rewrite'); setProblem(null); setNote(null);
    try {
      const j = await post('/api/lesson/revise', {
        lessonId: props.lessonId, instruction: instruction.trim(),
        ...(scope === 'part' ? { phase: slide.phase } : {}),
      });
      setDeck(j.deck as LessonDeck);
      setGate(j.gate as GateResult);
      setNote(`${j.changed} slide${j.changed === 1 ? '' : 's'} rewritten. Undo puts them back.`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [editable, slide, post, props.lessonId]);

  // --------------------------------------------------------------- picture

  /**
   * Put a picture on this slide - one the teacher has, or one drawn for them.
   * Multipart for a file, JSON for a drawing, one route for both.
   */
  const picture = useCallback(async (o: { file?: File; draw?: string; alt: string }) => {
    if (!editable || !slide) return;
    setBusy('picture'); setProblem(null); setNote(null);
    try {
      let r: Response;
      if (o.file) {
        const form = new FormData();
        form.append('lessonId', props.lessonId);
        form.append('slideId', slide.id);
        form.append('alt', o.alt);
        form.append('file', o.file);
        r = await fetch('/api/lesson/asset', { method: 'POST', body: form });
      } else {
        r = await fetch('/api/lesson/asset', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lessonId: props.lessonId, slideId: slide.id, draw: o.draw, alt: o.alt }),
        });
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message ?? friendly(j.error));
      setAssets(a => ({ ...a, [j.assetId as string]: j.dataUri as string }));
      setDeck(d => ({
        ...d,
        slides: d.slides.map(s => (s.id === slide.id ? (j.slide as Slide) : s)),
      }));
      setGate(j.gate as GateResult);
      setNote('The picture is on the slide.');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [editable, slide, props.lessonId]);

  // ----------------------------------------------------------------- theme

  const setTheme = useCallback(async (theme: string) => {
    if (!editable || theme === deck.theme) return;
    const before = deck.theme;
    // Shown at once and put back on failure: a colour change should feel instant.
    setDeck(d => ({ ...d, theme }));
    setBusy('structure'); setProblem(null);
    try {
      await post('/api/lesson/slides', { lessonId: props.lessonId, action: 'theme', theme });
    } catch (e) {
      setDeck(d => ({ ...d, theme: before }));
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [editable, deck.theme, post, props.lessonId]);

  // ---------------------------------------------------------------- export

  const exportPptx = useCallback(async () => {
    setBusy('export'); setProblem(null); setNote(null);
    try {
      const j = await post('/api/lesson/pptx', { lessonId: props.lessonId });
      setNote(j.renderNote ? String(j.renderNote) : 'The PowerPoint is ready.');
      window.location.href = props.urls.pptx;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [post, props.lessonId, props.urls.pptx]);

  const approve = useCallback(async () => {
    setBusy('approve'); setProblem(null); setNote(null);
    try {
      const j = await post('/api/lesson/approve', { lessonId: props.lessonId });
      setApproved(true);
      setGate(j.gate as GateResult);
      setNote(j.drive?.link
        ? 'Approved, and copied to the school Drive.'
        : 'Approved and in the shared bank.');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [post, props.lessonId]);

  // --------------------------------------------------------------- present

  /**
   * Present: the slide, alone, full screen.
   *
   * The first version kept the teacher panel open while presenting, so on a
   * projected laptop the class saw every answer and every misconception beside
   * the slide. Presenting now shows the slide and nothing else, and the teaching
   * guide goes to a second window the teacher can put on their own screen.
   */
  const startPresent = useCallback(() => {
    setRevealed(false);
    setPreview(true);
    requestAnimationFrame(() => {
      showRef.current?.requestFullscreen?.().catch(() => { /* still covers the window */ });
    });
  }, []);

  const endPresent = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setPreview(false);
  }, []);

  // Leaving full screen by the browser's own Esc ends the presentation too.
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement && preview) setPreview(false); };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [preview]);

  useEffect(() => { setRevealed(false); }, [at]);

  // The control strip gets out of the way: shown on movement, gone after two seconds.
  useEffect(() => {
    if (!preview) return;
    let t = window.setTimeout(() => setBarVisible(false), 2000);
    const wake = () => {
      setBarVisible(true);
      window.clearTimeout(t);
      t = window.setTimeout(() => setBarVisible(false), 2000);
    };
    window.addEventListener('mousemove', wake);
    return () => { window.clearTimeout(t); window.removeEventListener('mousemove', wake); };
  }, [preview]);

  const go = useCallback((delta: number) => {
    setAt(i => Math.min(slides.length - 1, Math.max(0, i + delta)));
  }, [slides.length]);

  /**
   * The presenter-notes window follows this one.
   *
   * A BroadcastChannel rather than a server round trip: the two windows are the
   * same teacher on the same machine, and a slide change has to reach the notes
   * as fast as it reaches the projector. The slide itself travels with the
   * message, so notes stay right even after an edit made mid-lesson.
   */
  const channel = useRef<BroadcastChannel | null>(null);
  const announce = useCallback(() => {
    const s = deckRef.current.slides[at];
    if (!s || !channel.current) return;
    channel.current.postMessage({
      type: 'slide', at, total: deckRef.current.slides.length, revealed,
      slide: s,
      objectives: s.objective_indexes.map(i => deckRef.current.objectives[i]).filter(Boolean),
    });
  }, [at, revealed]);
  // The channel lives as long as the page; the handler reads the latest announce
  // through a ref, so a notes window that says hello gets the slide as it is now.
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`lesson-${props.lessonId}`);
    channel.current = ch;
    ch.onmessage = e => {
      const m = e.data as { type?: string; delta?: number };
      if (m?.type === 'go' && typeof m.delta === 'number') goRef.current(m.delta);
      if (m?.type === 'reveal') setRevealed(v => !v);
      if (m?.type === 'hello') announceRef.current();
    };
    announceRef.current();
    return () => { ch.close(); channel.current = null; };
  }, [props.lessonId]);
  useEffect(() => { announce(); }, [announce, deck]);

  const openNotes = useCallback(() => {
    window.open(`/lesson/${props.lessonId}/notes`, `lesson-notes-${props.lessonId}`,
      'popup,width=560,height=820');
  }, [props.lessonId]);

  // ------------------------------------------------------------- keyboard

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target?.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');

      if (preview) {
        if (e.key === 'Escape') { endPresent(); e.preventDefault(); }
        if (['ArrowRight', ' ', 'PageDown', 'Enter'].includes(e.key)) { go(1); e.preventDefault(); }
        if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { go(-1); e.preventDefault(); }
        if (e.key === 'r' || e.key === 'R') { setRevealed(v => !v); e.preventDefault(); }
        return;
      }
      if (typing) return;

      // Ctrl+Z inside a field is the browser's own undo of the typing; outside
      // one it is the lesson's.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && editable) {
        void undo(); e.preventDefault(); return;
      }
      if (e.altKey && e.key === 'ArrowUp') { move(-1); e.preventDefault(); return; }
      if (e.altKey && e.key === 'ArrowDown') { move(1); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { setAt(i => Math.max(0, i - 1)); e.preventDefault(); }
      if (e.key === 'ArrowDown') { setAt(i => Math.min(slides.length - 1, i + 1)); e.preventDefault(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, slides.length, move, editable, undo, go, endPresent]);

  // ---------------------------------------------------------------- render

  const canvas = useMemo(() => {
    if (!slide) return '';
    return renderSlideHtml(deck, slide, at, slides.length, { assets, revealed: preview && revealed });
  }, [deck, slide, at, slides.length, assets, preview, revealed]);

  if (!slide) {
    return (
      <main className="led empty">
        <p className="lnone">This lesson has no slides.</p>
      </main>
    );
  }

  return (
    <div className={`led ${preview ? 'presenting' : ''}`}>
      {preview && (
        <div className={`lshow ${barVisible ? '' : 'quiet'}`} ref={showRef}
             role="dialog" aria-label={`Presenting slide ${at + 1} of ${slides.length}`}>
          <div className="lshowstage">
            <iframe title={`Slide ${at + 1}: ${slide.title}`} srcDoc={canvas} sandbox="" />
            {/* Over the iframe so a click on the slide moves on - the sandboxed
                frame would otherwise swallow it. */}
            <button type="button" className="lshowhit" aria-label="Next slide" onClick={() => go(1)} />
          </div>
          <div className="lshowbar">
            <button type="button" onClick={() => go(-1)} disabled={at === 0}>Back</button>
            <span>{at + 1} / {slides.length}</span>
            {hasReveal(slide) && (
              <button type="button" onClick={() => setRevealed(v => !v)} aria-pressed={revealed}>
                {revealed ? 'Hide the answer (R)' : 'Show the answer (R)'}
              </button>
            )}
            <button type="button" onClick={() => go(1)} disabled={at >= slides.length - 1}>Next</button>
            <button type="button" onClick={openNotes}>Presenter notes</button>
            <button type="button" onClick={endPresent}>Exit (Esc)</button>
          </div>
        </div>
      )}
      <header className="lbar">
        <a className="lback" href="/">Back to LOTS AI</a>
        <div className="lwho">
          <strong>{deck.title}</strong>
          <span>
            {deck.meta.yearGroup} {deck.meta.subjectName}
            {deck.meta.className ? ` · ${deck.meta.className}` : ''}
            {' · '}
            <span className={`ltime ${over ? 'over' : ''}`}>
              {minutes} of {deck.meta.duration_minutes} min
            </span>
            {' · '}{slides.length} slides
          </span>
        </div>
        <div className="lacts">
          {approved && <span className="lbadge">Approved</span>}
          {editable && (
            <>
              <button type="button" className="lbtn" onClick={undo} disabled={busy === 'history'}
                      title="Undo the last change (Ctrl+Z)">Undo</button>
              <button type="button" className="lbtn" onClick={openHistory} aria-expanded={historyOpen}>
                History
              </button>
            </>
          )}
          <button type="button" className="lbtn" onClick={startPresent}>Present</button>
          <button type="button" className="lbtn" onClick={openNotes}
                  title="Your teaching notes in a window of their own - put it on your screen, not the projector">
            Presenter notes
          </button>
          <a className="lbtn" href={props.urls.html} target="_blank" rel="noreferrer">Open the deck</a>
          <button type="button" className="lbtn primary" onClick={exportPptx} disabled={busy === 'export'}>
            {busy === 'export' ? 'Building…' : 'Download PowerPoint'}
          </button>
          {editable && !approved && (
            <button
              type="button" className="lbtn" onClick={approve}
              disabled={busy === 'approve' || gate.blocking > 0}
              title={gate.blocking ? 'Fix what is blocking before this can be approved' : ''}
            >
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          )}
        </div>
      </header>

      {historyOpen && (
        <div className="lhistory" role="dialog" aria-label="History">
          <p className="lfieldlabel">Restore the lesson as it was before...</p>
          {revisions === null && <p className="lhint">Reading the history...</p>}
          {revisions?.length === 0 && <p className="lhint">No history yet.</p>}
          <ol>
            {revisions?.map(r => (
              <li key={r.n}>
                <span>
                  <strong>{r.instruction ?? 'The lesson as it was generated'}</strong>
                  <small>{new Date(r.created_at).toLocaleString()}</small>
                </span>
                <button type="button" className="lmini" disabled={busy === 'history'}
                        onClick={() => restore(r.n)}>Restore</button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {problem && <p className="lproblem" onClick={() => setProblem(null)}>{problem}</p>}
      {note && <p className="lnote-bar" onClick={() => setNote(null)}>{note}</p>}
      {props.renderNote && <p className="lnote-bar">{props.renderNote}</p>}
      {!editable && !approved && (
        <p className="lnote-bar">This is somebody else’s lesson. You can read it and export it.</p>
      )}
      {approved && (
        <p className="lnote-bar">
          This lesson is approved and in the shared bank, so it cannot be changed.
          {props.driveLink && <> <a href={props.driveLink} target="_blank" rel="noreferrer">Open it in Drive</a>.</>}
        </p>
      )}

      <div className="lpanes">
        {/* ---------------------------------------------------- the rail */}
        <nav className="lrail" aria-label="Slides">
          <ol>
            {slides.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`lsrow ${i === at ? 'on' : ''}`}
                  onClick={() => setAt(i)}
                  aria-current={i === at ? 'true' : undefined}
                >
                  <span className="lsnum">{i + 1}</span>
                  <span className="lsbody">
                    <span className="lsphase">{PHASE_LABEL[s.phase]}</span>
                    <span className="lstitle">{s.title}</span>
                  </span>
                  <span className="lsmeta">
                    <span className={`lsdot ${s.audience === 'student_facing' ? 'student' : ''}`}
                      title={s.audience === 'student_facing' ? 'The class works on this slide' : 'You explain on this slide'} />
                    <span className="lsmin">{s.minutes}m</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {editable && (
            <div className="lrailfoot">
              <div className="lmoves">
                <button type="button" className="lmini" onClick={() => move(-1)}
                  disabled={at === 0 || busy === 'structure'} aria-label="Move this slide earlier">&#9650;</button>
                <button type="button" className="lmini" onClick={() => move(1)}
                  disabled={at >= slides.length - 1 || busy === 'structure'} aria-label="Move this slide later">&#9660;</button>
                <button type="button" className="lmini" onClick={() => structural('duplicate')}
                  disabled={busy === 'structure'} aria-label="Duplicate this slide">Copy</button>
                <button
                  type="button" className="lmini bad"
                  onClick={() => {
                    // The one action here that destroys work, so the one that asks.
                    if (window.confirm(`Delete slide ${at + 1}, "${slide.title}"?`)) {
                      void structural('delete');
                    }
                  }}
                  disabled={slides.length <= 1 || busy === 'structure'}
                  aria-label="Delete this slide"
                >Delete</button>
              </div>
              {adding ? (
                <div className="laddphase">
                  <p className="lfieldlabel">What is the new slide for?</p>
                  {LESSON_PHASES.map(p => (
                    <button
                      key={p} type="button" className="lchip"
                      onClick={() => { setAdding(false); void structural('insert', { phase: p, to: at + 1 }); }}
                    >{PHASE_LABEL[p]}</button>
                  ))}
                  <button type="button" className="lmini" onClick={() => setAdding(false)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="lmini wide" onClick={() => setAdding(true)}>
                  + Add a slide
                </button>
              )}
              <p className="lhint">Alt + &#9650; / &#9660; moves the selected slide.</p>
            </div>
          )}
        </nav>

        {/* -------------------------------------------------- the canvas */}
        <main className="lcanvas">
          {editable && (
            <div className="lthemes" role="radiogroup" aria-label="How the lesson looks">
              {THEMES.map(t => (
                <button
                  key={t.id} type="button" role="radio"
                  aria-checked={deck.theme === t.id}
                  className={`ltheme ${deck.theme === t.id ? 'on' : ''}`}
                  onClick={() => setTheme(t.id)}
                  title={`${t.name} - ${t.cover} cover, ${t.head} headings, ${t.card} cards`}
                  disabled={busy === 'structure'}
                >
                  <span className="lswatch" aria-hidden="true">
                    {t.slots.map((sl, i) => <span key={i} style={{ background: sl.c1 }} />)}
                  </span>
                  <span className="lthemename">{t.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="lstage">
            <iframe
              title={`Slide ${at + 1}: ${slide.title}`}
              srcDoc={canvas}
              // The deck's stylesheet is its own; the iframe is what keeps it
              // from meeting the application's.
              sandbox=""
            />
          </div>
        </main>

        {/* ----------------------------------------------- the inspector */}
        {/* Never while presenting: this panel holds the answers. */}
        {!preview && (
          <aside className="linsp" aria-label="This slide">
            <p className="lfieldlabel">
              {PHASE_LABEL[slide.phase]} &middot; {slide.minutes} min &middot;{' '}
              {slide.audience === 'student_facing' ? 'the class works' : 'you explain'}
            </p>

            <Field
              label="Why this slide exists"
              value={slide.purpose}
              editable={editable}
              multiline
              onSave={v => patch({ purpose: v })}
              placeholder="A slide that cannot say why it exists should not be in the lesson."
            />
            <Field
              label="Title"
              value={slide.title}
              editable={editable}
              onSave={v => patch({ title: v })}
            />

            {editable && (
              <div className="lrow">
                <label className="lfieldlabel" htmlFor="lmin">Minutes</label>
                <input
                  id="lmin" className="lnum" type="number" min={0} max={90}
                  // Keyed by slide: uncontrolled, so without it the box kept the
                  // previous slide's minutes after switching.
                  key={`min-${slide.id}`}
                  defaultValue={slide.minutes}
                  onBlur={e => {
                    const v = Number(e.currentTarget.value);
                    if (Number.isFinite(v) && v !== slide.minutes) void patch({ minutes: v });
                  }}
                />
              </div>
            )}

            {!!slide.objective_indexes.length && (
              <div className="lfield">
                <p className="lfieldlabel">Objectives</p>
                <ul className="lobj">
                  {slide.objective_indexes.map(i => {
                    const o = deck.objectives[i];
                    if (!o) return null;
                    return (
                      <li key={i}>
                        {o.ref && <span className="loref">{o.ref}</span>}{o.text}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {editable && slide.blocks.length > 0 && (
              <div className="lfield">
                <p className="lfieldlabel">Layout</p>
                <div className="limprovemenu" role="radiogroup" aria-label="Layout">
                  {arrangementsFor(slide).map(a => (
                    <button key={a} type="button" role="radio"
                            aria-checked={(slide.arrange ?? 'auto') === a}
                            className={`lchip ${(slide.arrange ?? 'auto') === a ? 'on' : ''}`}
                            onClick={() => patch({ arrange: a })} disabled={busy === 'save'}>
                      {ARRANGE_LABEL[a]}
                    </button>
                  ))}
                  {slide.blocks.length === 2 && (
                    <button type="button" className="lchip" disabled={busy === 'save'}
                            onClick={() => patch(current => ({ blocks: [...current.blocks].reverse() }))}>
                      Swap the two
                    </button>
                  )}
                </div>
              </div>
            )}

            {slide.blocks.length > 0 && (
              <>
                <p className="lsection">On the slide</p>
                {slide.blocks.map((b, i) => (
                  <BlockEditor
                    key={`${slide.id}-${i}-${b.type}`}
                    block={b}
                    editable={editable}
                    onSave={update => patch(current => ({
                      blocks: current.blocks.map((x, j) => (j === i ? update(x) : x)),
                    }))}
                  />
                ))}
              </>
            )}

            {editable && (
              <div className="limprove">
                <button
                  type="button" className="lbtn wide"
                  onClick={() => setImproveOpen(v => !v)}
                  disabled={busy === 'improve'}
                  aria-expanded={improveOpen}
                >
                  {busy === 'improve' ? 'Rewriting this slide…' : 'Improve this slide'}
                </button>
                {improveOpen && (
                  <div className="limprovemenu">
                    {IMPROVE_ACTIONS.map(a => (
                      <button key={a} type="button" className="lchip" onClick={() => improve(a)}>
                        {IMPROVE_LABEL[a]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {editable && (
              <RewritePanel busy={busy === 'rewrite'} phase={PHASE_LABEL[slide.phase]}
                            count={slides.filter(x => x.phase === slide.phase).length}
                            onRewrite={rewrite} />
            )}

            {editable && (
              <PicturePanel busy={busy === 'picture'} onAdd={picture}
                            hasVisual={slide.blocks.some(b =>
                              b.type === 'diagram' || b.type === 'chart' || b.type === 'image')} />
            )}

            <p className="lsection">The teaching guide</p>
            <p className="lhint">None of this appears on the slide. It goes in the notes pane of
              the PowerPoint.</p>

            <Field label="Teaching intention" value={slide.teacher.intention} editable={editable}
              multiline onSave={v => patch({ teacher: { intention: v } })} />
            <Field label="You might say" value={slide.teacher.say} editable={editable}
              multiline onSave={v => patch({ teacher: { say: v } })} />
            <Field label="Listen for" value={slide.teacher.expect ?? ''} editable={editable}
              multiline onSave={v => patch({ teacher: { expect: v } })} />
            <Field
              label="Watch for" value={slide.teacher.misconceptions.join('\n')} editable={editable}
              multiline
              onSave={v => patch({ teacher: { misconceptions: v.split('\n').map(x => x.trim()).filter(Boolean) } })}
              placeholder="One misconception per line."
            />
            <Field label="If they have it" value={slide.teacher.follow_up ?? ''} editable={editable}
              multiline onSave={v => patch({ teacher: { follow_up: v } })} />
            <Field label="Short of time" value={slide.teacher.timing_note ?? ''} editable={editable}
              multiline onSave={v => patch({ teacher: { timing_note: v } })} />

            <p className="lsection">The quality check</p>
            <Gate gate={gate} onPick={id => {
              const i = slides.findIndex(s => s.id === id);
              if (i >= 0) setAt(i);
            }} />
          </aside>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- pieces

/**
 * One editable field.
 *
 * contentEditable saved on blur or Ctrl+Enter and reverted on Escape - the same
 * contract as `Cell` in app/page.tsx, and for the same reason: a save button is
 * a thing to forget to press. React seeds the text and the DOM owns it
 * afterwards, so a re-render while somebody is typing does not take their
 * cursor.
 */
function Field(props: {
  label: string;
  value: string;
  editable: boolean;
  multiline?: boolean;
  placeholder?: string;
  onSave: (value: string) => Promise<boolean> | void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stored = useRef(props.value);
  const [mark, setMark] = useState<'' | 'ok' | 'bad'>('');

  useEffect(() => {
    stored.current = props.value;
    const el = box.current;
    if (el && document.activeElement !== el) el.textContent = props.value;
  }, [props.value]);

  if (!props.editable) {
    if (!props.value) return null;
    return (
      <div className="lfield">
        <p className="lfieldlabel">{props.label}</p>
        <p className="lreadonly">{props.value}</p>
      </div>
    );
  }

  const save = async () => {
    const next = (box.current?.textContent ?? '').trim();
    if (next === stored.current) return;
    const ok = await props.onSave(next);
    setMark(ok === false ? 'bad' : 'ok');
    if (ok !== false) stored.current = next;
    window.setTimeout(() => setMark(''), 2000);
  };

  return (
    <div className="lfield">
      <p className="lfieldlabel">
        {props.label}
        {mark && <span className={`lmark ${mark}`}>{mark === 'ok' ? 'saved' : 'not saved'}</span>}
      </p>
      <div
        ref={box}
        className={`lcell ${props.multiline ? 'multi' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={props.label}
        aria-multiline={props.multiline ? 'true' : 'false'}
        data-placeholder={props.placeholder ?? ''}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            if (box.current) box.current.textContent = stored.current;
            box.current?.blur();
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            box.current?.blur();
          }
          if (e.key === 'Enter' && !props.multiline && !e.shiftKey) {
            e.preventDefault();
            box.current?.blur();
          }
        }}
      />
    </div>
  );
}

/** The arrangements worth offering for what is on this slide. */
function arrangementsFor(slide: Slide): Arrangement[] {
  return slide.blocks.length >= 2 ? ['auto', 'side', 'stacked'] : ['auto', 'focus'];
}

/**
 * The words on the slide, editable.
 *
 * Generic over the twenty-one block shapes rather than a form per block: it
 * walks the block and offers every piece of text, every list, every number and
 * every yes/no it finds, labelled in plain words. A form per block type would be
 * twenty-one forms to keep in step with lib/lesson/schema.ts; this is one walker
 * that cannot fall behind it.
 *
 * Fields marked "you only" never appear on the slide - they are the answers and
 * the misconceptions, and they go to the notes pane. The server repairs whatever
 * comes back (lib/lesson/repair.ts, repairBlock), so a teacher who clears a list
 * or types a letter into a number box gets a sensible slide, not a broken one.
 */
function BlockEditor({ block, editable, onSave }: {
  block: SlideBlock;
  editable: boolean;
  /** Takes an update, not a value: it is applied to the block as it is when the
   *  save runs, so an earlier edit still in flight is never overwritten. */
  onSave: (update: (current: SlideBlock) => SlideBlock) => Promise<boolean>;
}) {
  const save = (path: (string | number)[], value: unknown) => onSave(current => {
    const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    let at: Record<string | number, unknown> = next;
    for (const k of path.slice(0, -1)) {
      if (at[k] == null || typeof at[k] !== 'object') return current;   // shape changed under us
      at = at[k] as Record<string | number, unknown>;
    }
    at[path[path.length - 1]] = value;
    return next as unknown as SlideBlock;
  });

  // Only the fields this diagram's shape draws: a flowchart has no number line,
  // and offering "From / To / Step" beside it invites edits that change nothing.
  const only = block.type === 'diagram' ? DIAGRAM_FIELDS[block.kind] ?? null : null;

  return (
    <div className="lblock">
      <p className="lblocktype">{BLOCK_NAME[block.type] ?? block.type}</p>
      <Fields value={block as unknown as Record<string, unknown>} path={[]}
              editable={editable} save={save} kind={block.type} only={only} />
    </div>
  );
}

const DIAGRAM_BASE = ['kind', 'title', 'caption'];
const DIAGRAM_FIELDS: Record<string, string[]> = {
  number_line: [...DIAGRAM_BASE, 'from', 'to', 'step', 'marks'],
  bar_model: [...DIAGRAM_BASE, 'parts'],
  grid: [...DIAGRAM_BASE, 'headers', 'nodes'],
  venn: [...DIAGRAM_BASE, 'parts', 'nodes'],
  flow: [...DIAGRAM_BASE, 'nodes'], cycle: [...DIAGRAM_BASE, 'nodes'],
  timeline: [...DIAGRAM_BASE, 'nodes'], tree: [...DIAGRAM_BASE, 'nodes'],
  labelled: [...DIAGRAM_BASE, 'nodes'],
};

/**
 * The order a teacher reads a block in.
 *
 * Not the order the keys arrive in: Postgres stores `content` as jsonb, which
 * re-sorts object keys (shortest first), so a diagram came back as To, From,
 * Shape, Step. Anything not listed keeps its place after the listed ones.
 */
const KEY_ORDER = [
  'kind', 'structure', 'heading', 'title', 'term', 'setup', 'context', 'question', 'prompt',
  'instruction', 'text', 'meaning', 'example', 'task', 'items', 'steps', 'options',
  'statements', 'categories', 'work', 'lines', 'language', 'columns', 'points', 'headers', 'rows',
  'cells', 'nodes', 'label', 'note', 'from', 'to', 'step', 'marks', 'at', 'parts', 'series', 'value',
  'unit', 'questions', 'prompts', 'support', 'extension', 'success_criteria', 'minutes',
  'share_back', 'caption', 'attribution', 'alt', 'reveal', 'answer', 'correct', 'is_true',
  'category', 'wrong_line', 'error', 'correction', 'why_wrong', 'why', 'explain', 'misconception',
];
function ordered(entries: [string, unknown][]): [string, unknown][] {
  const rank = (k: string) => { const i = KEY_ORDER.indexOf(k); return i < 0 ? KEY_ORDER.length : i; };
  return [...entries].sort((a, b) => rank(a[0]) - rank(b[0]));
}

const BLOCK_NAME: Partial<Record<SlideBlock['type'], string>> = {
  statement: 'Statement', bullets: 'Points', definition: 'Definition', steps: 'Steps',
  worked_example: 'Worked example', compare: 'Comparison', table: 'Table', code: 'Code',
  diagram: 'Diagram', chart: 'Chart', image: 'Picture', question: 'Question',
  mcq: 'Multiple choice', true_false: 'True or false', predict: 'Predict',
  sort: 'Sort into groups', error_spot: 'Spot the mistake', scenario: 'Scenario',
  discuss: 'Discussion', task: 'Task', exit_ticket: 'Exit ticket',
};

/** Plain labels for the keys a block can carry. */
const KEY_LABEL: Record<string, string> = {
  text: 'Text', attribution: 'Source or note', heading: 'Heading', items: 'Points',
  term: 'Term', meaning: 'Meaning', example: 'Example', steps: 'Steps', prompt: 'Prompt',
  answer: 'Answer', reveal: 'Hold the answer back until they have tried',
  columns: 'Column', points: 'Points', headers: 'Column headings', rows: 'Row', cells: 'Cells',
  note: 'Note', language: 'Language', lines: 'Code', caption: 'Caption', title: 'Title',
  nodes: 'Item', label: 'Label', parts: 'Part', value: 'Value', unit: 'Unit', marks: 'Marks',
  series: 'Bar', alt: 'What it shows (read aloud)', question: 'Question', options: 'Options',
  correct: 'Correct option (1 is the first)', why_wrong: 'Why each option tempts, in order',
  explain: 'Explanation', statements: 'Statement', is_true: 'This is true', why: 'Why',
  setup: 'Set-up', misconception: 'Misconception', instruction: 'Instruction',
  categories: 'Groups', category: 'Group (1 is the first)', work: 'The work, as a learner wrote it',
  wrong_line: 'Wrong line (1 is the first)', error: 'The mistake', correction: 'The correction',
  context: 'Situation', task: 'Task', prompts: 'Prompts', minutes: 'Minutes',
  share_back: 'Ask when the room comes back', support: 'If they cannot start',
  extension: 'If they finish early', success_criteria: 'What a good answer does',
  from: 'From', to: 'To', step: 'Step', at: 'At', kind: 'Shape', structure: 'How they talk',
  questions: 'Question',
};

/** Never on the slide: answers and what makes the wrong ones tempting. */
const TEACHER_ONLY = new Set([
  'answer', 'misconception', 'why_wrong', 'explain', 'why', 'correction', 'error',
  'correct', 'is_true', 'wrong_line', 'category',
]);
/** Stored from zero, shown from one - "option 1" is what a teacher means. */
const ONE_BASED = new Set(['correct', 'wrong_line', 'category']);
const SKIP = new Set(['type', 'asset_id']);
const CHOICES: Record<string, readonly string[]> = {
  structure: ['think_pair_share', 'pairs', 'groups', 'whole_class'],
};

function Fields({ value, path, editable, save, kind, only = null }: {
  value: Record<string, unknown>;
  path: (string | number)[];
  editable: boolean;
  kind: string;
  save: (path: (string | number)[], value: unknown) => Promise<boolean>;
  /** Top-level keys to show, when not all of them apply. */
  only?: string[] | null;
}) {
  return (
    <>
      {ordered(Object.entries(value)).map(([k, v]) => {
        if (SKIP.has(k)) return null;
        if (only && !only.includes(k)) return null;
        const p = [...path, k];
        const id = p.join('.');
        const label = `${KEY_LABEL[k] ?? k}${TEACHER_ONLY.has(k) ? ' - you only' : ''}`;

        // A choice from a fixed set: the diagram's shape, the chart's kind, how a
        // discussion runs. Changing a diagram's shape redraws it for nothing.
        if (k === 'kind' || CHOICES[k]) {
          const options = CHOICES[k]
            ?? (kind === 'chart' ? ['bar', 'line'] : kind === 'diagram' ? [...DIAGRAM_KINDS] : []);
          if (!options.length) return null;
          return (
            <label key={id} className="lfield">
              <span className="lfieldlabel">{label}</span>
              <select className="lnum" style={{ width: '100%' }} value={String(v)} disabled={!editable}
                      onChange={e => { void save(p, e.target.value); }}>
                {options.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
          );
        }

        if (typeof v === 'boolean') {
          return (
            <label key={id} className="lcheckrow">
              <input type="checkbox" checked={v} disabled={!editable}
                     onChange={e => { void save(p, e.target.checked); }} />
              <span>{label}</span>
            </label>
          );
        }

        if (typeof v === 'number' || (v === null && ['from', 'to', 'step', 'marks'].includes(k))) {
          const shown = typeof v === 'number' && ONE_BASED.has(k) ? v + 1 : v;
          return (
            <label key={id} className="lrow">
              <span className="lfieldlabel">{label}</span>
              <input className="lnum" type="number" disabled={!editable}
                     defaultValue={shown ?? ''} key={`${id}-${String(v)}`}
                     onBlur={e => {
                       const raw = e.currentTarget.value.trim();
                       const n = raw === '' ? null : Number(raw);
                       if (n !== null && !Number.isFinite(n)) return;
                       const stored = n !== null && ONE_BASED.has(k) ? n - 1 : n;
                       if (stored !== v) void save(p, stored);
                     }} />
            </label>
          );
        }

        if (typeof v === 'string' || v === null) {
          return (
            <Field key={id} label={label} value={v ?? ''} editable={editable}
                   multiline={String(v ?? '').length > 50 || ['text', 'meaning', 'context', 'setup', 'explain'].includes(k)}
                   onSave={next => save(p, next || (v === null ? null : ''))} />
          );
        }

        if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
          return (
            <Field key={id} label={`${label} - one per line`} value={(v as string[]).join('\n')}
                   editable={editable} multiline
                   onSave={next => save(p, next.split('\n').map(x => x.trim()).filter(Boolean))} />
          );
        }

        // A list of records: questions, columns, statements, rows, nodes...
        if (Array.isArray(v)) {
          const items = v as Record<string, unknown>[];
          const blank = (item: Record<string, unknown>) => Object.fromEntries(
            Object.entries(item).map(([ik, iv]) => [ik,
              typeof iv === 'string' ? '' : Array.isArray(iv) ? [] : typeof iv === 'number' ? 0
                : typeof iv === 'boolean' ? false : iv]));
          return (
            <div key={id} className="lrecords">
              {items.map((item, i) => (
                <div key={`${id}.${i}`} className="lrecord">
                  <p className="lfieldlabel">
                    {KEY_LABEL[k] ?? k} {i + 1}
                    {editable && items.length > 1 && (
                      <button type="button" className="lmini tiny"
                              onClick={() => { void save(p, items.filter((_, j) => j !== i)); }}>
                        Remove
                      </button>
                    )}
                  </p>
                  {typeof item === 'object' && item !== null
                    ? <Fields value={item} path={[...p, i]} editable={editable} save={save} kind={kind} />
                    : null}
                </div>
              ))}
              {editable && items.length > 0 && typeof items[0] === 'object' && (
                <button type="button" className="lmini"
                        onClick={() => { void save(p, [...items, blank(items[items.length - 1])]); }}>
                  + Another {(KEY_LABEL[k] ?? k).toLowerCase()}
                </button>
              )}
            </div>
          );
        }

        if (v && typeof v === 'object') {
          return <Fields key={id} value={v as Record<string, unknown>} path={p}
                         editable={editable} save={save} kind={kind} />;
        }
        return null;
      })}
    </>
  );
}

/**
 * Rewrite a whole part of the lesson - "make the practice harder", "use a
 * market-stall example throughout" - in the teacher's own words. One model call
 * per six slides, so the part is offered first and the whole lesson second.
 */
function RewritePanel({ busy, phase, count, onRewrite }: {
  busy: boolean; phase: string; count: number;
  onRewrite: (instruction: string, scope: 'part' | 'all') => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!open) {
    return (
      <button type="button" className="lbtn wide" onClick={() => setOpen(true)} disabled={busy}>
        Rewrite a whole part of the lesson
      </button>
    );
  }
  return (
    <div className="lpicture">
      <p className="lfieldlabel">What should change?</p>
      <textarea className="lcell multi" style={{ width: '100%', minHeight: 60 }} value={text}
                aria-label="What should change"
                onChange={e => setText(e.target.value)}
                placeholder="Use a market-stall example throughout, and make the practice harder." />
      <div className="lmoves" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="lmini" disabled={!text.trim() || busy}
                onClick={() => onRewrite(text, 'part')}>
          {busy ? 'Rewriting…' : `The ${phase.toLowerCase()} slides (${count})`}
        </button>
        <button type="button" className="lmini" disabled={!text.trim() || busy}
                onClick={() => onRewrite(text, 'all')}>
          The whole lesson
        </button>
        <button type="button" className="lmini" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * A picture for this slide.
 *
 * A photograph of the apparatus the class will actually use, or a screenshot of
 * the program they will actually open, is the one visual a diagram cannot stand
 * in for - and the one the model has no way to know about. Drawing one is
 * offered second, because it costs money per picture and is the one part of a
 * deck that cannot be checked by reading it.
 *
 * The description is required either way: it is the alt text, and a slide is
 * sometimes read aloud.
 */
function PicturePanel({ busy, hasVisual, onAdd }: {
  busy: boolean;
  hasVisual: boolean;
  onAdd: (o: { file?: File; draw?: string; alt: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [draw, setDraw] = useState('');

  if (!open) {
    return (
      <button type="button" className="lbtn wide" onClick={() => setOpen(true)} disabled={busy}>
        {hasVisual ? 'Replace the picture' : 'Add a picture'}
      </button>
    );
  }

  const ready = !!alt.trim() && (!!file || !!draw.trim());
  return (
    <div className="lpicture">
      <p className="lfieldlabel">{hasVisual ? 'Replace the picture' : 'Add a picture'}</p>
      <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose a picture"
             onChange={e => { setFile(e.target.files?.[0] ?? null); if (e.target.files?.[0]) setDraw(''); }} />
      {!file && (
        <input className="lnum" style={{ width: '100%' }} value={draw}
               onChange={e => setDraw(e.target.value)} aria-label="Or describe a picture to draw"
               placeholder="Or describe one to draw: a leaf cross-section" />
      )}
      <input className="lnum" style={{ width: '100%' }} value={alt}
             onChange={e => setAlt(e.target.value)} aria-label="What the picture shows"
             placeholder="What it shows, for someone who cannot see it" />
      <div className="lmoves">
        <button type="button" className="lmini" disabled={!ready || busy}
                onClick={() => onAdd({ file: file ?? undefined, draw: file ? undefined : draw.trim(), alt: alt.trim() })}>
          {busy ? (file ? 'Adding\u2026' : 'Drawing\u2026') : file ? 'Use this picture' : 'Draw it'}
        </button>
        <button type="button" className="lmini" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

/** The gate, as the teacher reads it. Blocking first: it is what stops approval. */
function Gate({ gate, onPick }: { gate: GateResult; onPick: (slideId: string) => void }) {
  const order: Record<string, number> = { block: 0, warn: 1, pass: 2 };
  const checks = [...gate.checks].sort((a, b) => order[a.status] - order[b.status]);
  const [all, setAll] = useState(false);
  const shown = all ? checks : checks.filter(c => c.status !== 'pass');

  return (
    <div className="lgate">
      <p className="lgatesum">
        {gate.passed} passed
        {gate.warnings ? `, ${gate.warnings} to look at` : ''}
        {gate.blocking ? `, ${gate.blocking} blocking` : ''}
      </p>
      {!shown.length && <p className="lhint">Everything passed.</p>}
      {shown.map(c => <Check key={c.id} check={c} onPick={onPick} />)}
      <button type="button" className="lmini" onClick={() => setAll(v => !v)}>
        {all ? 'Only what needs attention' : `Show all ${checks.length} checks`}
      </button>
    </div>
  );
}

function Check({ check, onPick }: { check: LessonCheck; onPick: (slideId: string) => void }) {
  return (
    <div className={`lcheck ${check.status}`}>
      <p className="lchecktitle">{check.title}</p>
      <p className="lcheckdetail">{check.detail}</p>
      {!!check.slides?.length && (
        <p className="lcheckslides">
          {check.slides.map(id => (
            <button key={id} type="button" className="lchip tiny" onClick={() => onPick(id)}>
              {id}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}
