'use client';

/**
 * The teaching guide for the slide on the projector, and nothing else.
 *
 * Big type, one slide at a time, answers first - this is read at a glance by a
 * teacher standing at the front of a room, not studied. It follows the
 * presenting window and can drive it: Next and Back here move the projector.
 *
 * It starts from the deck the server gave it, so it is useful even before the
 * presenting window says anything, and switches to what the channel sends once
 * it does - which is the slide as it is now, edits included.
 */
import { useEffect, useRef, useState } from 'react';
import { PHASE_LABEL, type LessonDeck, type PackObjective, type Slide } from '@/lib/lesson/schema';
import { revealables } from '@/lib/lesson/render_html';

interface Now {
  at: number;
  total: number;
  revealed: boolean;
  slide: Slide;
  objectives: PackObjective[];
}

export default function Notes({ lessonId, deck }: { lessonId: string; deck: LessonDeck }) {
  const first = deck.slides[0];
  const [now, setNow] = useState<Now | null>(first ? {
    at: 0, total: deck.slides.length, revealed: false, slide: first,
    objectives: first.objective_indexes.map(i => deck.objectives[i]).filter(Boolean),
  } : null);
  const [linked, setLinked] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`lesson-${lessonId}`);
    channel.current = ch;
    ch.onmessage = e => {
      const m = e.data as Partial<Now> & { type?: string };
      if (m?.type === 'slide' && m.slide) {
        setNow({
          at: m.at ?? 0, total: m.total ?? deck.slides.length, revealed: !!m.revealed,
          slide: m.slide, objectives: m.objectives ?? [],
        });
        setLinked(true);
      }
    };
    // Ask the presenting window where it is, in case it opened us mid-lesson.
    ch.postMessage({ type: 'hello' });
    return () => { ch.close(); channel.current = null; };
  }, [lessonId, deck.slides.length]);

  const send = (msg: Record<string, unknown>) => channel.current?.postMessage(msg);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', ' ', 'PageDown'].includes(e.key)) { send({ type: 'go', delta: 1 }); e.preventDefault(); }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { send({ type: 'go', delta: -1 }); e.preventDefault(); }
      if (e.key === 'r' || e.key === 'R') { send({ type: 'reveal' }); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!now) return <main className="lnotesview"><p className="lnoteswait">This lesson has no slides.</p></main>;

  const s = now.slide;
  const t = s.teacher;
  const answers = revealables(s);

  return (
    <main className="lnotesview">
      <header className="lnoteshead">
        <h1>{now.at + 1} / {now.total} &middot; {s.title}</h1>
        <span>
          {PHASE_LABEL[s.phase]} &middot; {s.minutes} min &middot;{' '}
          {s.audience === 'student_facing' ? 'the class works' : 'you explain'}
        </span>
      </header>

      <div className="lnotesnav">
        <button type="button" className="lbtn" onClick={() => send({ type: 'go', delta: -1 })}
                disabled={!linked || now.at === 0}>Back</button>
        <button type="button" className="lbtn primary" onClick={() => send({ type: 'go', delta: 1 })}
                disabled={!linked || now.at >= now.total - 1}>Next</button>
        {answers.length > 0 && (
          <button type="button" className="lbtn" onClick={() => send({ type: 'reveal' })} disabled={!linked}
                  aria-pressed={now.revealed}>
            {now.revealed ? 'Hide the answer on the screen' : 'Show the answer on the screen'}
          </button>
        )}
      </div>
      {!linked && (
        <p className="lnoteswait">
          Waiting for the lesson window. Press Present there, and these notes will follow it.
        </p>
      )}

      {answers.length > 0 && (
        <section className="lnotesblock lnotesanswer">
          <h2>Answer</h2>
          {answers.map((a, i) => (
            <p key={i}><strong>{a.q}</strong><br />{a.a}{a.why ? <><br /><em>Watch for: {a.why}</em></> : null}</p>
          ))}
        </section>
      )}

      {t.say && <section className="lnotesblock"><h2>You might say</h2><p>{t.say}</p></section>}
      {t.expect && <section className="lnotesblock"><h2>Listen for</h2><p>{t.expect}</p></section>}
      {t.misconceptions.length > 0 && (
        <section className="lnotesblock">
          <h2>Watch for</h2>
          <ul>{t.misconceptions.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </section>
      )}
      {t.follow_up && <section className="lnotesblock"><h2>If they have it</h2><p>{t.follow_up}</p></section>}
      {t.timing_note && <section className="lnotesblock"><h2>Short of time</h2><p>{t.timing_note}</p></section>}
      <section className="lnotesblock">
        <h2>Why this slide</h2>
        <p>{s.purpose}</p>
        {t.intention && t.intention !== s.purpose && <p>{t.intention}</p>}
      </section>
      {now.objectives.length > 0 && (
        <section className="lnotesblock">
          <h2>Objectives</h2>
          <ul>{now.objectives.map((o, i) => <li key={i}>{o.ref ? `${o.ref} - ` : ''}{o.text}</li>)}</ul>
        </section>
      )}
    </main>
  );
}
