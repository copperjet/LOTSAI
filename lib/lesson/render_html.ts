/**
 * The lesson as a document: the deck a teacher opens, and the source the PDF is
 * printed from.
 *
 * ONE COORDINATE SYSTEM. A slide is 254mm by 143mm - 16:9 at a size that prints
 * without scaling - and every length inside it is in `cqw`, one per cent of the
 * slide's own width. That is what makes the same markup correct on a phone, in a
 * browser at any width, and on the printed page at exactly 254mm: the slide is a
 * container and its contents are a fraction of it, so nothing has to be laid out
 * twice. It also means a slide cannot silently reflow between the preview a
 * teacher approved and the PDF that comes out, which is the failure the study
 * pack's paginator exists to manage and this design avoids having.
 *
 * WHAT IS NOT ON THE SLIDE. Answers, the reasons wrong options are tempting, and
 * the whole teacher note. They are in the panel beside each slide on screen -
 * which is hidden when printing, because what gets printed is what the class
 * sees - and in the notes pane of the exported PowerPoint. A slide that prints
 * its own answers is a slide that cannot be shown to the class.
 *
 * SELF-CONTAINED, like every artefact here: the crest is a data URI, diagrams
 * are inline SVG, pictures are inlined by lib/lesson/assets.ts. The headless
 * print has no session and /api/document/view is behind sign-in, so anything
 * linked would come out blank.
 *
 * PURE, and deliberately so. Nothing here reads the database - the caller hands
 * in the deck and its pictures. That is what lets the editor import this module
 * into the browser and render its canvas with the same code that renders the
 * artefact, instead of a second renderer that drifts from it. The server-side
 * wrapper that does the loading is lib/lesson/render_server.ts.
 */
import { CREST } from '@/lib/crest';
import { fontHref, themeById, type Theme } from '@/lib/studypack/themes';
import { ACCENTS } from '@/lib/studypack/schema';
import { PHASE_LABEL, type LessonDeck, type Slide, type SlideBlock } from './schema';
import { esc, paletteFor, svgForBlock } from './visuals';

const SCHOOL = 'Lusaka Oaktree School';

/** The slide, in millimetres. 16:9, and a size that prints without scaling. */
export const SLIDE_MM = { w: 254, h: 143 };

export interface RenderOpts {
  /** asset id -> data URI. */
  assets?: Record<string, string>;
  /** Screen only: start with the teaching notes showing. Off unless asked for -
   *  a deck opened on a projected screen must not show the answers. */
  notesOpen?: boolean;
  /** Show the answers on the slide itself - the teacher has pressed Reveal. */
  revealed?: boolean;
}

/** The whole document. Pure, so the render-check script can call it with no database. */
export function renderDeckHtml(deck: LessonDeck, opts: RenderOpts = {}): string {
  const theme = themeById(deck.theme);
  const slides = deck.slides ?? [];

  const body = slides.map((s, i) => sheet(deck, s, i, slides.length, theme, opts)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(deck.title)} - ${esc(deck.meta.yearGroup)} ${esc(deck.meta.subjectName)}</title>
<link rel="stylesheet" href="${fontHref(theme)}">
<style>${css(theme)}</style>
</head>
<body class="${opts.notesOpen === true ? 'shownotes' : ''}">
${topBar(deck)}
<main class="deck">
${body}
</main>
${script()}
</body>
</html>`;
}

/**
 * One slide, as a standalone document.
 *
 * This is what the editor's canvas shows, in an iframe. It exists so there is
 * exactly one slide renderer: the alternative was a second, simpler one written
 * in React for the editor, and two renderers mean a teacher approves a slide
 * that looks one way and exports one that looks another. The iframe is also what
 * keeps the deck's own stylesheet - which is 254mm and cqw and its own fonts -
 * from leaking into the application's.
 */
export function renderSlideHtml(
  deck: LessonDeck, slide: Slide, index: number, total: number, opts: RenderOpts = {},
): string {
  const theme = themeById(deck.theme);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${fontHref(theme)}">
<style>${css(theme)}
/* The canvas shows one slide, edge to edge, with no deck furniture around it.
   The iframe is exactly 16:9, so anything that adds height - the deck's own
   padding, a gap, a body margin - shows up as a scrollbar beside the slide. */
html,body{height:100%;overflow:hidden;background:transparent;}
.deck{padding:0;gap:0;}
.sheet{grid-template-columns:1fr;max-width:none;}
.slide{box-shadow:none;border:0;border-radius:0;}
.note{display:none !important;}
.rvbtn{display:none !important;}
</style>
</head>
<body>
<main class="deck">
${sheet(deck, slide, index, total, theme, opts)}
</main>
</body>
</html>`;
}

// ------------------------------------------------------------------- chrome

function topBar(deck: LessonDeck): string {
  const m = deck.meta;
  const total = (deck.slides ?? []).reduce((n, s) => n + s.minutes, 0);
  return `<header class="bar">
  <img class="crest" src="${CREST}" alt="">
  <div class="who">
    <strong>${esc(deck.title)}</strong>
    <span>${esc(m.yearGroup)} ${esc(m.subjectName)}${m.className ? ` &middot; ${esc(m.className)}` : ''}
      &middot; ${esc(total)} min across ${(deck.slides ?? []).length} slides</span>
  </div>
  <div class="acts">
    <button type="button" id="toggleNotes" class="tb">Show teaching notes</button>
    <button type="button" id="printDeck" class="tb">Print</button>
  </div>
</header>`;
}

/**
 * The notes toggle and the print button.
 *
 * The only script in the document, and it does nothing the document needs to be
 * correct - a deck with scripting disabled shows its slides and its notes, which
 * is the useful default.
 */
function script(): string {
  return `<script>
(function(){
  var b=document.body, t=document.getElementById('toggleNotes');
  if(t) t.addEventListener('click',function(){
    var on=b.classList.toggle('shownotes');
    t.textContent=on?'Hide teaching notes':'Show teaching notes';
  });
  var p=document.getElementById('printDeck');
  if(p) p.addEventListener('click',function(){window.print();});
  document.addEventListener('click',function(e){
    var r=e.target.closest&&e.target.closest('.rvbtn'); if(!r) return;
    var sl=r.closest('.sheet').querySelector('.slide');
    var on=sl.classList.toggle('revealed');
    r.textContent=on?'Hide the answer':'Show the answer';
  });
})();
</script>`;
}

// -------------------------------------------------------------------- slides

function sheet(
  deck: LessonDeck, s: Slide, index: number, total: number, theme: Theme, opts: RenderOpts,
): string {
  const refs = s.objective_indexes
    .map(i => deck.objectives[i]?.ref)
    .filter(Boolean) as string[];

  return `<section class="sheet" id="${esc(s.id)}">
  <div class="slidecol">
  <article class="slide a${Math.max(0, ACCENTS.indexOf(s.accent))} l-${esc(s.layout)} ${themeClasses(theme, s)}${opts.revealed ? ' revealed' : ''}"
           data-audience="${esc(s.audience)}">
    <div class="chrome">
      <span class="eyebrow">${esc(s.eyebrow ?? PHASE_LABEL[s.phase])}</span>
      ${refs.length ? `<span class="refs">${refs.map(r => esc(r)).join(' &middot; ')}</span>` : ''}
    </div>
    ${s.layout === 'title' ? '' : `<h2 class="stitle">${esc(s.title)}</h2>`}
    <div class="blocks">${slideBody(deck, s, theme, opts)}</div>
    <div class="foot">
      <span>${esc(SCHOOL)}</span>
      ${s.audience === 'student_facing' ? '<span class="tag">Your turn</span>' : '<span></span>'}
      <span>${index + 1} / ${total}</span>
    </div>
  </article>
  ${hasReveal(s) ? '<button type="button" class="rvbtn">Show the answer</button>' : ''}
  </div>
  ${notePanel(deck, s)}
</section>`;
}

/**
 * The three slides the deck draws itself rather than from blocks.
 *
 * The title, the objectives and the summary are composed from what the deck
 * already knows. Asking the model to write the objectives slide would be asking
 * it to write out the objectives, which is the one thing it must never do.
 */
function slideBody(deck: LessonDeck, s: Slide, theme: Theme, opts: RenderOpts): string {
  if (s.phase === 'title' && !s.blocks.length) return titleSlide(deck, s);
  if (s.phase === 'objectives' && !s.blocks.length) return objectivesSlide(deck);
  if (s.phase === 'summary' && !s.blocks.length) return summarySlide(deck);
  if (!s.blocks.length) return '';
  return s.blocks.map(b => block(b, deck, theme, s, opts)).join('');
}

/**
 * The theme's composition, as classes on the slide.
 *
 * A theme is more than a palette: the study pack's themes each carry a cover
 * composition, a header treatment and a card treatment (lib/studypack/themes.ts),
 * and for a while the lesson used only the colours - so every deck had the same
 * white slide, the same thin bar and the same title page, and only the hue told
 * two lessons apart. The cover applies to the title slide alone; the header and
 * the card to every other one.
 */
function themeClasses(theme: Theme, s: Slide): string {
  const cover = s.phase === 'title' && !s.blocks.length ? ` cv-${theme.cover}` : '';
  const arrange = s.arrange && s.arrange !== 'auto' ? ` ar-${s.arrange}` : '';
  return `hd-${theme.head} cd-${theme.card}${cover}${arrange}`;
}

function titleSlide(deck: LessonDeck, s: Slide): string {
  const m = deck.meta;
  return `<div class="hero">
    <h1>${esc(deck.title)}</h1>
    ${deck.subtitle ? `<p class="sub">${esc(deck.subtitle)}</p>` : ''}
    ${m.key_question ? `<p class="key">${esc(m.key_question)}</p>` : ''}
    <p class="meta">${esc(m.yearGroup)} ${esc(m.subjectName)}
      &middot; ${esc(m.duration_minutes)} minutes${s.minutes ? '' : ''}</p>
  </div>`;
}

function objectivesSlide(deck: LessonDeck): string {
  const items = deck.objectives.map(o =>
    `<li><span class="oref">${o.ref ? esc(o.ref) : ''}</span>${esc(o.text)}</li>`).join('');
  return `<p class="lead">By the end of this lesson you will be able to:</p>
    <ul class="objectives">${items}</ul>`;
}

function summarySlide(deck: LessonDeck): string {
  const rows = deck.timing.map(t =>
    `<li><span class="tmin">${esc(t.minutes)} min</span>${esc(t.label)}</li>`).join('');
  const items = deck.objectives.map(o => `<li>${esc(o.text)}</li>`).join('');
  return `<div class="two">
    <div><p class="lead">What we did</p><ul class="plain">${rows}</ul></div>
    <div><p class="lead">What you can now do</p><ul class="plain">${items}</ul></div>
  </div>`;
}

// -------------------------------------------------------------------- blocks

function block(
  b: SlideBlock, deck: LessonDeck, theme: Theme, s: Slide, opts: RenderOpts,
): string {
  switch (b.type) {
    case 'statement':
      return `<div class="statement"><p>${esc(b.text)}</p>`
        + `${b.attribution ? `<p class="attrib">${esc(b.attribution)}</p>` : ''}</div>`;

    case 'bullets':
      return `<div class="blk">${head(b.heading)}
        <ul class="bul">${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`;

    case 'definition':
      return `<div class="blk def">
        <p class="term">${esc(b.term)}</p>
        <p class="mean">${esc(b.meaning)}</p>
        ${b.example ? `<p class="eg"><span>For example</span> ${esc(b.example)}</p>` : ''}
      </div>`;

    case 'steps':
      return `<div class="blk">${head(b.heading)}
        <ol class="steps">${b.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>`;

    case 'worked_example':
      return `<div class="blk worked">
        <p class="prompt">${esc(b.prompt)}</p>
        <ol class="steps">${b.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
        ${b.reveal
    ? `<p class="hidden-answer">Try it first.</p>${rv(b.answer, null)}`
    : `<p class="answer"><span>Answer</span> ${esc(b.answer)}</p>`}
      </div>`;

    case 'compare': {
      const cols = b.columns.map(c => `<div class="col">
        <p class="colhead">${esc(c.heading)}</p>
        <ul class="bul">${c.points.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('');
      return `<div class="blk">${head(b.heading)}<div class="cols n${b.columns.length}">${cols}</div></div>`;
    }

    case 'table': {
      const thead = b.headers.length
        ? `<thead><tr>${b.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : '';
      const rows = b.rows.map(r =>
        `<tr>${r.cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
      return `<div class="blk"><table class="tbl">${thead}<tbody>${rows}</tbody></table>
        ${b.note ? `<p class="small">${esc(b.note)}</p>` : ''}</div>`;
    }

    case 'code':
      return `<div class="blk"><pre class="code"><code>${b.lines.map(l => esc(l)).join('\n')}</code></pre>
        ${b.caption ? `<p class="small">${esc(b.caption)}</p>` : ''}</div>`;

    case 'diagram':
    case 'chart': {
      const svg = svgForBlock(b, paletteFor(deck.theme, s.accent));
      if (!svg) return '';
      const caption = b.type === 'diagram' ? b.caption : b.note;
      // A drawing titled the same as the slide prints the heading twice and
      // takes a fifth of the slide to say nothing.
      const title = sameAs(b.title, s.title) ? null : b.title;
      return `<figure class="fig">
        ${title ? `<figcaption>${esc(title)}</figcaption>` : ''}
        <div class="svgwrap">${svg}</div>
        ${caption ? `<p class="small">${esc(caption)}</p>` : ''}
      </figure>`;
    }

    case 'image': {
      const src = opts.assets?.[b.asset_id];
      // A missing asset renders as nothing, never as a broken image on a wall.
      if (!src) return '';
      return `<figure class="fig img">
        <img src="${src}" alt="${esc(b.alt)}">
        ${b.caption ? `<p class="small">${esc(b.caption)}</p>` : ''}
      </figure>`;
    }

    case 'question':
      return `<div class="ask">
        <p class="q">${esc(b.question)}</p>
        ${b.prompt ? `<p class="how">${esc(b.prompt)}</p>` : ''}
        ${rv(b.answer, b.misconception)}
      </div>`;

    case 'mcq': {
      const letters = 'ABCDE';
      const opts2 = b.options.map((o, i) =>
        `<li${i === b.correct ? ' class="ok"' : ''}><span class="letter">${letters[i] ?? '?'}</span>${esc(o)}</li>`).join('');
      // Why each wrong option tempts is shown too: talking through why B was
      // tempting is the point of a diagnostic question, and it is only useful
      // once the class has committed.
      const tempts = b.why_wrong
        .map((w, i) => (w && i !== b.correct ? `${letters[i]}: ${w}` : ''))
        .filter(Boolean).join('  ');
      return `<div class="ask">
        <p class="q">${esc(b.question)}</p>
        <ul class="mcq">${opts2}</ul>
        ${rv(`${letters[b.correct] ?? '?'} - ${b.options[b.correct] ?? ''}${b.explain ? `. ${b.explain}` : ''}`,
    tempts || null)}
      </div>`;
    }

    case 'true_false':
      return `<div class="ask">
        <p class="how">True or false?</p>
        <ol class="tf">${b.statements.map(x =>
    `<li>${esc(x.text)}<span class="rv rvinline"> - <strong>${x.is_true ? 'True' : 'False'}</strong>`
    + `${x.why ? `. ${esc(x.why)}` : ''}</span></li>`).join('')}</ol>
      </div>`;

    case 'predict':
      return `<div class="ask">
        ${b.setup ? `<p class="setup">${esc(b.setup)}</p>` : ''}
        <p class="q">${esc(b.question)}</p>
        <p class="how">Decide before we find out.</p>
        ${rv(b.answer, b.misconception)}
      </div>`;

    case 'sort': {
      const cats = b.categories.map(c => `<div class="cat"><p>${esc(c)}</p></div>`).join('');
      const chips = b.items.map(i => `<li>${esc(i.text)}`
        + `<span class="rv rvinline"> - ${esc(b.categories[i.category] ?? '?')}</span></li>`).join('');
      return `<div class="ask">
        <p class="q">${esc(b.instruction)}</p>
        <div class="cats">${cats}</div>
        <ul class="chips">${chips}</ul>
      </div>`;
    }

    case 'error_spot':
      return `<div class="ask">
        <p class="q">${esc(b.instruction)}</p>
        <ol class="work">${b.work.map((l, i) =>
    // Marked, but only drawn once revealed: highlighting the wrong line on the
    // slide the class is asked to search gives the answer away.
    `<li${b.wrong_line === i ? ' class="wrongline"' : ''}>${esc(l)}</li>`).join('')}</ol>
        ${rv(b.correction || b.error, b.correction ? b.error : null, 'The correction', 'The mistake')}
      </div>`;

    case 'scenario':
      return `<div class="blk scen">
        <p class="ctx">${esc(b.context)}</p>
        <p class="q">${esc(b.task)}</p>
        ${b.prompts.length
    ? `<ul class="bul">${b.prompts.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </div>`;

    case 'discuss': {
      const how: Record<string, string> = {
        think_pair_share: 'Think on your own, then talk to the person beside you, then we share',
        pairs: 'In pairs', groups: 'In your groups', whole_class: 'All together',
      };
      return `<div class="ask talk">
        <p class="q">${esc(b.prompt)}</p>
        <p class="how">${esc(how[b.structure] ?? 'Talk about it')} &middot; ${esc(b.minutes)} minutes</p>
      </div>`;
    }

    case 'task':
      return `<div class="blk">
        <p class="q">${esc(b.instruction)}</p>
        ${b.questions.length
    ? `<ol class="qs">${b.questions.map(q =>
      `<li>${esc(q.text)}${q.marks ? ` <span class="marks">[${esc(q.marks)}]</span>` : ''}</li>`)
      .join('')}</ol>` : ''}
        ${b.extension ? `<p class="small"><strong>Finished?</strong> ${esc(b.extension)}</p>` : ''}
      </div>`;

    case 'exit_ticket':
      return `<div class="ask exit">
        <p class="how">Before you go</p>
        <p class="q">${esc(b.question)}</p>
        ${b.success_criteria.length
    ? `<ul class="bul">${b.success_criteria.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${rv(b.answer, null)}
      </div>`;

    default:
      return '';
  }
}

/**
 * An answer, on the slide but hidden until the teacher reveals it.
 *
 * On the slide rather than only in the notes because the brief asks for it:
 * after a hinge question the teacher shows the class the answer and talks
 * through the tempting wrong one. Hidden by default everywhere, and never
 * printed - a printed slide is a handout.
 */
function rv(
  answer: string | null | undefined, mistake: string | null | undefined,
  answerLabel = 'Answer', mistakeLabel = 'A common mistake',
): string {
  const a = String(answer ?? '').trim();
  const m = String(mistake ?? '').trim();
  if (!a && !m) return '';
  return `<div class="rv">`
    + (a ? `<p class="rvans"><span>${esc(answerLabel)}</span> ${esc(a)}</p>` : '')
    + (m ? `<p class="rvmis"><span>${esc(mistakeLabel)}</span> ${esc(m)}</p>` : '')
    + `</div>`;
}

/** Whether a slide has anything to reveal - the button and the key only appear if so. */
export function hasReveal(s: Slide): boolean {
  return s.blocks.some(b =>
    ['question', 'mcq', 'true_false', 'predict', 'sort', 'error_spot', 'exit_ticket'].includes(b.type)
    || (b.type === 'worked_example' && b.reveal));
}

function head(text: string | null): string {
  return text ? `<p class="bhead">${esc(text)}</p>` : '';
}

/** Two headings that say the same thing, allowing for punctuation and case. */
export function sameAs(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const x = norm(a);
  return !!x && x === norm(b);
}

// --------------------------------------------------------------- the notes

/**
 * The teaching guide, beside the slide.
 *
 * This is the half a teacher reads and the class never sees, and it is why this
 * is a lesson rather than a deck. It carries the answers too - a question's
 * answer belongs where the teacher can see it and the projector cannot.
 */
function notePanel(deck: LessonDeck, s: Slide): string {
  const t = s.teacher;
  const answers = revealables(s);
  const rows: string[] = [];

  if (s.purpose) rows.push(row('Why this slide', s.purpose));
  if (t.intention && t.intention !== s.purpose) rows.push(row('Teaching intention', t.intention));
  if (t.say) rows.push(row('You might say', t.say));
  if (t.expect) rows.push(row('Listen for', t.expect));
  if (answers.length) {
    rows.push(`<div class="nrow"><dt>Answer</dt><dd>${answers.map(a =>
      `<p><strong>${esc(a.q)}</strong><br>${esc(a.a)}`
      + `${a.why ? `<br><em>${esc(a.why)}</em>` : ''}</p>`).join('')}</dd></div>`);
  }
  if (t.misconceptions.length) {
    rows.push(`<div class="nrow"><dt>Watch for</dt><dd><ul>${t.misconceptions
      .map(m => `<li>${esc(m)}</li>`).join('')}</ul></dd></div>`);
  }
  if (t.follow_up) rows.push(row('If they have it', t.follow_up));
  if (t.timing_note) rows.push(row('Short of time', t.timing_note));

  const objectives = s.objective_indexes
    .map(i => deck.objectives[i])
    .filter(Boolean)
    .map(o => `<li>${o.ref ? `<span class="oref">${esc(o.ref)}</span>` : ''}${esc(o.text)}</li>`)
    .join('');

  return `<aside class="note">
    <p class="nhead">${esc(PHASE_LABEL[s.phase])} &middot; ${esc(s.minutes)} min
      &middot; ${s.audience === 'student_facing' ? 'the class works' : 'you explain'}</p>
    <dl>${rows.join('')}</dl>
    ${objectives ? `<p class="nhead">Objectives</p><ul class="nobj">${objectives}</ul>` : ''}
  </aside>`;
}

function row(label: string, value: string): string {
  return `<div class="nrow"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

/** Everything on this slide the teacher can reveal but the class cannot see. */
export function revealables(s: Slide): { q: string; a: string; why: string | null }[] {
  const out: { q: string; a: string; why: string | null }[] = [];
  for (const b of s.blocks) {
    switch (b.type) {
      case 'question':
        out.push({ q: b.question, a: b.answer, why: b.misconception }); break;
      case 'mcq': {
        const letters = 'ABCDE';
        const why = b.why_wrong
          .map((w, i) => (w && i !== b.correct ? `${letters[i]}: ${w}` : ''))
          .filter(Boolean).join('  ');
        out.push({
          q: b.question,
          a: `${letters[b.correct] ?? '?'} - ${b.options[b.correct] ?? ''}`
            + (b.explain ? `. ${b.explain}` : ''),
          why: why || null,
        });
        break;
      }
      case 'true_false':
        for (const st of b.statements) {
          out.push({ q: st.text, a: st.is_true ? 'True' : 'False', why: st.why || null });
        }
        break;
      case 'predict':
        out.push({ q: b.question, a: b.answer, why: b.misconception }); break;
      case 'error_spot':
        out.push({ q: b.instruction, a: b.correction || b.error, why: b.error }); break;
      case 'exit_ticket':
        out.push({ q: b.question, a: b.answer, why: null }); break;
      case 'worked_example':
        if (b.reveal) out.push({ q: b.prompt, a: b.answer, why: null });
        break;
      case 'sort':
        out.push({
          q: b.instruction,
          a: b.items.map(i => `${i.text} - ${b.categories[i.category] ?? '?'}`).join('; '),
          why: null,
        });
        break;
      default: break;
    }
  }
  return out;
}

// ----------------------------------------------------------------------- css

/**
 * One stylesheet, in cqw.
 *
 * Every size inside a slide is a fraction of the slide's own width, so the
 * design holds at any rendered size and the printed page is the preview at
 * 254mm. The only lengths in mm are the page and the slide itself.
 */
function css(t: Theme): string {
  const a = t.slots;
  return `
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --ink:${t.ink.text}; --muted:${t.ink.muted}; --line:${t.ink.line}; --paper:${t.ink.paper};
  --card:${t.ink.card}; --tint:${t.ink.tint}; --tint2:${t.ink.tint2}; --deck:${t.ink.deck};
  --mark:${t.mark}; --rule:${t.ink.rule};
  --display:${t.display}; --body:${t.body}; --radius:${t.radius}px;
}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{background:var(--deck);color:var(--ink);font-family:var(--body);}

/* ---------- the bar (screen only) ---------- */
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;
  padding:10px 18px;background:var(--card);border-bottom:1px solid var(--line);}
.bar .crest{height:34px;width:auto;}
.bar .who{display:flex;flex-direction:column;line-height:1.3;min-width:0;}
.bar .who strong{font-family:var(--display);font-size:16px;}
.bar .who span{color:var(--muted);font-size:12.5px;}
.bar .acts{margin-left:auto;display:flex;gap:8px;}
.tb{font:inherit;font-size:13px;padding:7px 13px;border:1px solid var(--line);
  border-radius:999px;background:var(--paper);color:var(--ink);cursor:pointer;}
.tb:hover{border-color:var(--mark);}

/* ---------- layout ---------- */
.deck{display:flex;flex-direction:column;gap:22px;padding:22px 18px 60px;align-items:center;}
.sheet{display:grid;grid-template-columns:1fr;gap:12px;width:100%;max-width:1180px;}
body.shownotes .sheet{grid-template-columns:minmax(0,1fr) 272px;}
@media (max-width:1000px){body.shownotes .sheet{grid-template-columns:1fr;}}

/* ---------- the slide ---------- */
.slide{
  container-type:inline-size;
  position:relative;width:100%;aspect-ratio:${SLIDE_MM.w} / ${SLIDE_MM.h};
  background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:0 1px 2px rgba(0,0,0,.05),0 10px 26px rgba(0,0,0,.07);
  display:flex;flex-direction:column;overflow:hidden;
  padding:4.2cqw 5cqw 3.4cqw;
}
.slide.a0{--ac:${a[0].c1};--ac2:${a[0].c2};}
.slide.a1{--ac:${a[1].c1};--ac2:${a[1].c2};}
.slide.a2{--ac:${a[2].c1};--ac2:${a[2].c2};}
.slide.a3{--ac:${a[3].c1};--ac2:${a[3].c2};}
.slide.a4{--ac:${a[4].c1};--ac2:${a[4].c2};}
.slide::before{content:"";position:absolute;inset:0 0 auto 0;height:0.7cqw;
  background:linear-gradient(90deg,var(--ac),var(--ac2));}

.chrome{display:flex;align-items:baseline;gap:1.6cqw;margin-bottom:1.4cqw;}
.eyebrow{font-family:var(--display);font-size:1.35cqw;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ac);font-weight:700;}
.refs{margin-left:auto;font-size:1.2cqw;color:var(--mark);font-weight:700;letter-spacing:.06em;}
.stitle{font-family:var(--display);font-size:3.5cqw;line-height:1.15;font-weight:700;
  margin-bottom:1.8cqw;}
.blocks{flex:1;min-height:0;display:flex;flex-direction:column;gap:1.6cqw;justify-content:center;}
.l-split .blocks{flex-direction:row;align-items:stretch;gap:2.4cqw;}
.l-split .blocks>*{flex:1;min-width:0;}
.l-visual_full .blocks,.l-visual_caption .blocks{justify-content:center;}
.foot{display:flex;align-items:center;gap:1.6cqw;margin-top:1.6cqw;padding-top:1cqw;
  border-top:1px solid var(--line);font-size:1.15cqw;color:var(--muted);}
.foot span:last-child{margin-left:auto;}
.foot .tag{background:var(--ac);color:#fff;padding:.35cqw 1.1cqw;border-radius:999px;
  font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:1.05cqw;}

/* ---------- blocks ---------- */
.blk{min-width:0;}
.bhead{font-family:var(--display);font-weight:700;font-size:2.1cqw;margin-bottom:.9cqw;color:var(--ac);}
.statement{display:flex;flex-direction:column;justify-content:center;gap:1.2cqw;text-align:center;
  padding:0 3cqw;}
.statement p{font-family:var(--display);font-size:4.4cqw;line-height:1.25;font-weight:700;}
.statement .attrib{font-family:var(--body);font-size:1.6cqw;font-weight:400;color:var(--muted);}
.bul{list-style:none;display:flex;flex-direction:column;gap:1.05cqw;}
.bul li{position:relative;padding-left:2.5cqw;font-size:2.15cqw;line-height:1.4;}
.bul li::before{content:"";position:absolute;left:.5cqw;top:.72cqw;width:.85cqw;height:.85cqw;
  border-radius:50%;background:var(--ac);}
.steps,.qs,.tf,.work{list-style:none;counter-reset:n;display:flex;flex-direction:column;gap:.95cqw;}
.steps li,.qs li,.tf li,.work li{counter-increment:n;position:relative;padding-left:3.2cqw;
  font-size:2.05cqw;line-height:1.4;}
.steps li::before,.qs li::before,.tf li::before,.work li::before{
  content:counter(n);position:absolute;left:0;top:0;width:2.3cqw;height:2.3cqw;border-radius:50%;
  background:var(--ac);color:#fff;font-size:1.3cqw;font-weight:700;display:flex;
  align-items:center;justify-content:center;}
.work li{font-family:ui-monospace,Consolas,monospace;}
.slide.revealed .work li.wrongline{background:var(--tint);border-radius:var(--radius);padding-right:1cqw;
  outline:.3cqw solid var(--ac);}

/* ---------- answers, revealed on the slide ---------- */
.rv{display:none;}
.slide.revealed .rv{display:block;}
.slide.revealed .rv.rvinline{display:inline;}
.slide.revealed .hidden-answer{display:none;}
.rv p{font-size:1.85cqw;line-height:1.4;margin-top:.8cqw;padding:1cqw 1.4cqw;border-radius:var(--radius);}
.rvans{background:var(--ac);color:#fff;}
.rvans span,.rvmis span{font-weight:700;margin-right:.6cqw;}
.rvmis{background:var(--tint);color:var(--ink);}
.rvinline{color:var(--ac);font-size:.9em;}
.slide.revealed .mcq li.ok{border-color:var(--ac);background:var(--tint);box-shadow:0 0 0 .3cqw var(--ac) inset;}
.slidecol{display:flex;flex-direction:column;gap:8px;min-width:0;}
.rvbtn{align-self:flex-start;font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line);
  border-radius:999px;background:var(--card);color:var(--ink);cursor:pointer;}
.rvbtn:hover{border-color:var(--mark);}
.def{background:var(--tint);border-left:.7cqw solid var(--ac);border-radius:var(--radius);
  padding:1.8cqw 2.2cqw;}
.def .term{font-family:var(--display);font-size:2.9cqw;font-weight:700;color:var(--ac);}
.def .mean{font-size:2.15cqw;line-height:1.4;margin-top:.6cqw;}
.def .eg{font-size:1.75cqw;color:var(--muted);margin-top:.9cqw;}
.def .eg span{font-weight:700;color:var(--ink);}
.worked{background:var(--tint2);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.6cqw 2cqw;}
.worked .prompt{font-family:var(--display);font-size:2.4cqw;font-weight:700;margin-bottom:1cqw;}
.worked .answer{margin-top:1cqw;padding-top:.9cqw;border-top:1px solid var(--line);font-size:2cqw;}
.worked .answer span{font-weight:700;color:var(--ac);}
.worked .hidden-answer{margin-top:1cqw;font-size:1.5cqw;color:var(--muted);font-style:italic;}
.cols{display:flex;gap:1.8cqw;}
.cols .col{flex:1;min-width:0;background:var(--tint2);border:1px solid var(--line);
  border-radius:var(--radius);padding:1.4cqw 1.6cqw;}
.colhead{font-family:var(--display);font-weight:700;font-size:2.1cqw;color:var(--ac);
  margin-bottom:.8cqw;padding-bottom:.6cqw;border-bottom:2px solid var(--ac);}
.tbl{width:100%;border-collapse:collapse;font-size:1.85cqw;}
.tbl th{background:var(--ac);color:#fff;text-align:left;padding:.9cqw 1.1cqw;font-weight:700;}
.tbl td{padding:.85cqw 1.1cqw;border-bottom:1px solid var(--line);}
.tbl tbody tr:nth-child(even){background:var(--tint);}
.code{background:${t.ink.text};color:#f4f6f3;border-radius:var(--radius);padding:1.5cqw 1.8cqw;
  font-family:ui-monospace,Consolas,monospace;font-size:1.8cqw;line-height:1.5;
  white-space:pre-wrap;overflow:hidden;}
.fig{display:flex;flex-direction:column;gap:.8cqw;min-height:0;align-items:center;}
.fig figcaption{font-family:var(--display);font-weight:700;font-size:2cqw;color:var(--ac);
  align-self:flex-start;}
.svgwrap{width:100%;display:flex;justify-content:center;min-height:0;}
.svgwrap svg{max-width:100%;max-height:100%;height:auto;}
.fig.img img{max-width:100%;max-height:100%;object-fit:contain;border-radius:var(--radius);}
.small{font-size:1.5cqw;color:var(--muted);line-height:1.4;}
.ask{display:flex;flex-direction:column;gap:1.2cqw;justify-content:center;}
.ask .q{font-family:var(--display);font-size:3cqw;line-height:1.25;font-weight:700;}
.ask .how{font-size:1.7cqw;color:var(--muted);}
.ask .setup{font-size:2cqw;line-height:1.4;}
.ask.talk .q,.ask.exit .q{font-size:2.8cqw;}
.ask.exit .how{font-family:var(--display);text-transform:uppercase;letter-spacing:.12em;
  font-size:1.35cqw;font-weight:700;color:var(--ac);}
.mcq{list-style:none;display:flex;flex-direction:column;gap:.95cqw;}
.mcq li{display:flex;align-items:center;gap:1.2cqw;font-size:2.15cqw;background:var(--tint2);
  border:1px solid var(--line);border-radius:var(--radius);padding:.95cqw 1.4cqw;}
.mcq .letter{flex:0 0 auto;width:2.4cqw;height:2.4cqw;border-radius:50%;background:var(--ac);
  color:#fff;font-weight:700;font-size:1.35cqw;display:flex;align-items:center;justify-content:center;}
.cats{display:flex;gap:1.2cqw;}
.cats .cat{flex:1;border:2px dashed var(--ac);border-radius:var(--radius);padding:1.2cqw;
  text-align:center;font-weight:700;font-size:1.9cqw;color:var(--ac);}
.chips{list-style:none;display:flex;flex-wrap:wrap;gap:.8cqw;}
.chips li{background:var(--tint);border:1px solid var(--line);border-radius:999px;
  padding:.6cqw 1.3cqw;font-size:1.8cqw;}
.scen .ctx{background:var(--tint);border-radius:var(--radius);padding:1.4cqw 1.6cqw;
  font-size:1.95cqw;line-height:1.45;}
.scen .q{font-family:var(--display);font-size:2.4cqw;font-weight:700;margin-top:1.1cqw;}
.marks{color:var(--mark);font-weight:700;}
.hero{flex:1;display:flex;flex-direction:column;justify-content:center;gap:1.2cqw;}
.hero h1{font-family:var(--display);font-size:5.4cqw;line-height:1.1;font-weight:700;}
.hero .sub{font-size:2.4cqw;color:var(--muted);}
.hero .key{font-size:2.6cqw;font-style:italic;color:var(--ac);border-left:.6cqw solid var(--ac);
  padding-left:1.6cqw;margin-top:.8cqw;}
.hero .meta{font-size:1.7cqw;color:var(--muted);margin-top:.6cqw;}
.lead{font-family:var(--display);font-size:2.2cqw;font-weight:700;color:var(--ac);margin-bottom:1.1cqw;}
.objectives{list-style:none;display:flex;flex-direction:column;gap:1.2cqw;}
.objectives li{font-size:2.15cqw;line-height:1.4;padding-left:2.6cqw;position:relative;}
.objectives li::before{content:"";position:absolute;left:.4cqw;top:.7cqw;width:1cqw;height:1cqw;
  background:var(--ac);border-radius:.2cqw;}
.oref{display:inline-block;color:var(--mark);font-weight:700;margin-right:.8cqw;}
.two{display:flex;gap:2.4cqw;}
.two>div{flex:1;min-width:0;}
.plain{list-style:none;display:flex;flex-direction:column;gap:.8cqw;font-size:1.9cqw;}
.tmin{display:inline-block;min-width:5cqw;color:var(--mark);font-weight:700;}

/* ---------- the teacher's arrangement ----------
   After the layout rules, so a choice the teacher made beats the automatic one. */
.slide.ar-side .blocks{flex-direction:row;align-items:stretch;gap:2.4cqw;}
.slide.ar-side .blocks>*{flex:1;min-width:0;}
.slide.ar-stacked .blocks{flex-direction:column;align-items:stretch;}
.slide.ar-stacked .blocks>*{flex:0 1 auto;}
.slide.ar-focus .blocks{flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:0 6cqw;}
.slide.ar-focus .blocks>*{max-width:100%;}
.slide.ar-focus .bul li,.slide.ar-focus .steps li{text-align:left;}
.slide.ar-focus :is(.bul,.steps,.qs,.mcq,.tf){align-self:center;}

/* ---------- the theme's composition ----------
   Written after the base rules so each one overrides only what it changes. */

/* Headers: how a content slide announces itself. */
.slide.hd-solid::before{height:1.5cqw;background:var(--ac);}
.slide.hd-rule::before,.slide.hd-underline::before{display:none;}
.slide.hd-rule .stitle{padding-bottom:1.1cqw;border-bottom:.25cqw solid var(--line);}
.slide.hd-underline .stitle::after{content:"";display:block;width:9cqw;height:.55cqw;
  background:var(--ac);border-radius:.3cqw;margin-top:1cqw;}

/* Cards: how a boxed thing - a definition, a worked example, an option - is drawn. */
.slide.cd-leftbar :is(.def,.worked,.cols .col,.mcq li,.scen .ctx){
  background:var(--tint2);border:0;border-left:.7cqw solid var(--ac);}
.slide.cd-outline :is(.def,.worked,.cols .col,.mcq li,.scen .ctx){
  background:transparent;border:.22cqw solid var(--line);border-left-width:.22cqw;}
.slide.cd-outline :is(.def,.worked){border-color:var(--ac);}
.slide.cd-tint :is(.def,.worked,.cols .col,.mcq li,.scen .ctx){
  background:var(--tint);border:0;}
.slide.cd-shadow :is(.def,.worked,.cols .col,.mcq li,.scen .ctx){
  background:var(--card);border:0;box-shadow:0 .3cqw 1.4cqw rgba(0,0,0,.10);}

/* Covers: the title slide. Each is a different first page, not a recolour. */
.slide.cv-panel{background:var(--ac);color:#fff;}
.slide.cv-panel::before{display:none;}
.slide.cv-panel :is(.eyebrow,.hero .sub,.hero .meta,.foot){color:rgba(255,255,255,.85);}
.slide.cv-panel .hero .key{color:#fff;border-left-color:var(--mark);}
.slide.cv-panel .foot{border-top-color:rgba(255,255,255,.3);}

.slide.cv-band .hero{background:var(--ac);color:#fff;margin:0 -5cqw;padding:3.2cqw 5cqw;
  flex:0 0 auto;align-self:stretch;margin-top:auto;margin-bottom:auto;}
.slide.cv-band .hero :is(.sub,.meta){color:rgba(255,255,255,.85);}
.slide.cv-band .hero .key{color:#fff;border-left-color:var(--mark);}

.slide.cv-split{background:linear-gradient(90deg,var(--ac) 0 34%,var(--card) 34%);}
.slide.cv-split::before{display:none;}
.slide.cv-split .chrome .eyebrow{color:#fff;}
.slide.cv-split .hero{margin-left:34%;padding-left:4cqw;}
.slide.cv-split .foot span:first-child{color:rgba(255,255,255,.9);}
.slide.cv-split .foot{border-top-color:transparent;}

.slide.cv-orbit{overflow:hidden;}
.slide.cv-orbit::after{content:"";position:absolute;right:-9cqw;top:-12cqw;width:40cqw;height:40cqw;
  border-radius:50%;background:var(--ac2);opacity:.16;pointer-events:none;}
.slide.cv-orbit .hero::after{content:"";position:absolute;right:8cqw;bottom:9cqw;width:12cqw;
  height:12cqw;border-radius:50%;border:.8cqw solid var(--ac);opacity:.35;pointer-events:none;}

.slide.cv-rule .hero h1{padding-bottom:1.8cqw;border-bottom:1cqw solid var(--ac);
  align-self:flex-start;}

/* ---------- the teaching note (screen only) ---------- */
.note{display:none;background:var(--card);border:1px solid var(--line);
  border-radius:var(--radius);padding:14px 15px;font-size:12.5px;line-height:1.5;
  align-self:start;position:sticky;top:76px;max-height:calc(100vh - 100px);overflow:auto;}
body.shownotes .note{display:block;}
.nhead{font-family:var(--display);font-size:11px;font-weight:700;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted);margin-bottom:8px;}
.note dl + .nhead{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);}
.note dl{display:flex;flex-direction:column;gap:9px;}
.nrow dt{font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--mark);margin-bottom:2px;}
.nrow dd ul{margin-left:14px;}
.nrow dd p{margin-bottom:5px;}
.nobj{list-style:none;display:flex;flex-direction:column;gap:6px;color:var(--muted);}

/* ---------- print: the slides, and only the slides ---------- */
@page{size:${SLIDE_MM.w}mm ${SLIDE_MM.h}mm;margin:0;}
@media print{
  body{background:#fff;}
  .bar,.note,.rvbtn,.rv{display:none !important;}
  .slidecol{display:block;}
  .deck{display:block;padding:0;gap:0;}
  .sheet{display:block;max-width:none;width:auto;page-break-after:always;break-after:page;}
  .sheet:last-child{page-break-after:auto;break-after:auto;}
  .slide{width:${SLIDE_MM.w}mm;height:${SLIDE_MM.h}mm;aspect-ratio:auto;
    border:0;border-radius:0;box-shadow:none;}
}
@media (prefers-reduced-motion:reduce){*{transition:none !important;animation:none !important;}}
`;
}
