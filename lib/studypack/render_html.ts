/**
 * Render a v2 study pack to one self-contained HTML document.
 *
 * This is both the working artefact and the print master. The school's own packs are
 * page-designed documents - "GP LS3 Study Pack Formative 4.pdf" was made by printing
 * a web page to A4 landscape from Chrome - so the same markup carries a screen
 * reading (scrolling sheets, live quizzes, tickable checklists) and a print reading
 * (@page sizing, flattened questions with answer space, an answer key at the back).
 * lib/pdf/renderers/studypack_print.ts prints this exact file server-side.
 *
 * Every sheet carries the crest, the school name and a footer credit, which is the
 * Reference Guide's "on every page" rule and the Build Kit's sixth non-negotiable.
 *
 * All generated text is HTML-escaped and long dashes are normalised to a hyphen, as
 * in lib/studypack_html.ts; the quiz data goes to the engine as a JSON island with
 * </script> neutralised, so a stray tag or brace in a question can never break the
 * page.
 */
import { CREST } from '../crest';
import type { Block, PackV2, Page } from './schema';

/** Long dashes to a plain hyphen - the school writes with hyphens, and a model
 *  produces em dashes however firmly its prompt asks it not to. The PDF side does
 *  the same in sanitizeWinAnsi (lib/pdf/layout.ts). */
const DASHES = /[\u2012\u2013\u2014\u2015]/g;

const esc = (s: unknown) =>
  String(s ?? '').replace(DASHES, '-')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const json = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * The cover lists every objective. It is the page the Reference Guide asks for, and
 * every section header points at it - "and 4 more, listed in full on the cover" - so a
 * cover that stopped at eight and said "and 29 more" broke a promise the document made
 * on six other pages.
 *
 * A long list is set in columns rather than truncated: these two thresholds are density,
 * not a cap. Only past COVER_MAX - far more objectives than a four week span holds - does
 * the cover give up, and then it says where the rest actually are.
 */
const COVER_COLUMNS = 10;
const COVER_DENSE = 20;
const COVER_MAX = 44;

/** How many objectives a section header states before deferring to the cover. A page
 *  the model tagged with all eleven objectives of a four-week span spent a third of
 *  itself on the strip. */
const PAGE_OBJECTIVES = 4;

/** Longest a lettered row of options can be, in characters, and still fit one line. */
const INLINE_OPTIONS = 100;

/** Page geometry per layout. A4 landscape for a worked-through document, 16:9 for
 *  a topic deck like the CP5 Mathematics packs. */
const SIZES = {
  // px/py are kept apart from `pad` because the header band is full bleed: it cancels
  // the sheet's own padding with a negative margin, and cannot do that from a shorthand.
  'a4-landscape': { css: 'A4 landscape', w: '297mm', h: '210mm', px: '14mm', py: '11mm' },
  'slide-16x9': { css: '254mm 143mm', w: '254mm', h: '143mm', px: '12mm', py: '9mm' },
} as const;

interface QuizQ { q: string; options: string[]; correct: number; explain: string }

export interface RenderOpts {
  /**
   * Draw the cover sheet. A study pack wants one - it is where the Reference Guide
   * puts the full objective list. A homework does not: it is a two page paper a
   * learner writes on, and a cover would be half of what they were handed.
   */
  cover?: boolean;
  /**
   * Server print. The browser draws the running footer and the page number itself
   * (lib/pdf/renderers/studypack_print.ts), because it is the only thing that knows
   * how many physical pages a section actually took: a dense section runs onto a
   * second page, and a footer drawn inside the document would then be missing from
   * it and the count would be a lie. So the document drops its own footer and lets
   * each section flow, and Chrome stamps every page.
   */
  paged?: boolean;
}

/** The running footer Chrome stamps on every printed page. Inline styles only, and
 *  an explicit font-size - a footer template inherits nothing from the page. */
export function footerTemplate(pack: PackV2): string {
  const left = esc(`Lusaka Oaktree School \u00b7 ${pack.meta.subject}`
    + (pack.meta.curriculum ? ` \u00b7 ${pack.meta.curriculum}` : ''));
  const right = esc(pack.meta.span ?? '');
  return `<div style="width:100%;font-size:7.5pt;font-family:Arial,Helvetica,sans-serif;color:#657064;`
    + `padding:0 14mm;display:flex;justify-content:space-between;align-items:center;">`
    + `<span>${left}</span><span>${right}</span>`
    + `<span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`;
}

export function renderPackHtml(pack: PackV2, opts: RenderOpts = {}): string {
  const size = SIZES[pack.layout] ?? SIZES['a4-landscape'];
  const paged = opts.paged === true;
  const cover = opts.cover !== false;
  // How much of the page height a sheet does not get, in millimetres.
  //
  // On the server print that is the strip the running footer is stamped into. On the
  // screen variant the footer is inside the sheet, so the strip is only slack - but it
  // has to exist: Chrome lays A4 out as 209.98mm, and a sheet asking for the full 210
  // overran by a fraction of a point and printed a continuation page carrying nothing
  // but its footer. Five of the fifteen pages of a ten sheet pack were that page.
  //
  // The same figure sets the sheet's printed min-height and the height the paginator
  // measures against, so the two cannot drift apart.
  const slackMm = paged ? 10 : 4;
  const pagePx = Math.round(((parseFloat(size.h) - slackMm) * 96) / 25.4);

  // Quiz payloads for the on-screen engine, and a continuously numbered answer key
  // for the printed copy - a printed pack must be workable before the answers are seen.
  const quizData: Record<string, QuizQ[]> = {};
  const answerKey: { n: number; correct: string; explain: string }[] = [];
  let qNum = 0;

  // The cover and the answer key are sheets like any other, so they count towards
  // "n of N" - a pack whose last page reads 8/8 while its first reads 1/7 looks like a
  // page went missing.
  const hasQuiz = pack.pages.some(p => (p.blocks ?? []).some(b => b.type === 'quiz'));
  const total = pack.pages.length + (cover ? 1 : 0) + (hasQuiz ? 1 : 0);

  const sheets = pack.pages.map((page, index) => {
    const pi = cover ? index + 1 : index;   // with a cover, it is sheet 0
    const objectives = (page.objective_indexes ?? [])
      .map(i => pack.objectives[i]).filter(Boolean);

    const drawn = (page.blocks ?? []).map((block, bi) => {
      if (block.type === 'quiz') {
        const id = `quiz-${pi}-${bi}`;
        quizData[id] = block.questions;
        const printed = block.questions.map(q => {
          qNum++;
          answerKey.push({ n: qNum, correct: OPTION_LETTERS[q.correct] ?? '?', explain: q.explain });
          return { n: qNum, q };
        });
        return { html: renderQuiz(id, printed), half: block.span === 'half' };
      }
      return { html: renderBlock(block, pack), half: block.span === 'half' };
    }).filter(d => d.html);

    const body = pairUp(drawn);

    return sheet({
      pack, index: pi, total, accent: page.accent, paged,
      eyebrow: page.eyebrow, title: page.title,
      objectives: objectives.map(o => ({ ref: o.ref, text: o.text })),
      body, cover,
    });
  }).join('');

  const keySheet = answerKey.length
    ? sheet({
      pack, index: total - 1, total, accent: 'gold', paged,
      eyebrow: 'FOR THE TEACHER', title: 'Answer key',
      objectives: [], cover,
      body: `<div class="answer-key">${answerKey.map(a =>
        `<p><b>${a.n}.</b> ${esc(a.correct)}${a.explain ? ` <span class="muted">- ${esc(a.explain)}</span>` : ''}</p>`).join('')}</div>`,
      printOnly: true,
    })
    : '';

  const glossary = pack.pages.flatMap(p => p.blocks)
    .filter((b): b is Extract<Block, { type: 'glossary' }> => b.type === 'glossary')
    .flatMap(b => b.terms);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pack.title)} - LOTS ${esc(pack.kind ?? 'Study Pack')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${css(size, paged, slackMm)}
</style>
</head>
<body${paged ? ' class="paged"' : ''}>
<div class="toolbar no-print">
  <span class="tb-title">${esc(pack.title)}</span>
  <button onclick="__packPrepare();window.print()">Print / Save as PDF</button>
</div>
<div class="deck">
${cover ? coverSheet(pack, total) : ''}
${sheets}
${keySheet}
</div>
<script>
window.__packPagePx=${pagePx};
${engine()}
document.addEventListener('DOMContentLoaded',function(){
  var quizzes=${json(quizData)};
  Object.keys(quizzes).forEach(function(k){initQuiz(k,quizzes[k]);});
  initFlash(${json(glossary.map(g => ({ front: g.term, back: g.definition })))});
});
</script>
</body>
</html>`;
}

// --------------------------------------------------------------------- sheet

/**
 * Sit half-width blocks beside each other.
 *
 * A block that asked for half the page only gets it if something follows it to fill the
 * other half; a lone half at the end of a page would otherwise print as a column with
 * empty space beside it, which reads as a mistake rather than a choice. The pair is
 * wrapped in one element so the paginator, which moves whole children of .sheet-body,
 * carries them to a continuation sheet together.
 */
function pairUp(blocks: { html: string; half: boolean }[]): string {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const here = blocks[i], next = blocks[i + 1];
    if (here.half && next?.half) {
      out.push(`<div class="row">${here.html}${next.html}</div>`);
      i++;
    } else {
      out.push(here.html);
    }
  }
  return out.join('');
}

/**
 * The cover.
 *
 * Both of the school's packs open on one and neither generates it: "GP LS3 Study Pack
 * Formative 4.pdf" puts the crest, the title, the unit and every objective in full on a
 * dark green panel, and "CP5 Mathematic StudyPack 1.pdf" does the same in a deck's
 * proportions. It is the Reference Guide's "objectives in full" page, so it is drawn
 * from the pack's own meta and objective list rather than asked of the model - there is
 * nothing on it a model could add, and one less page for it to get wrong.
 */
function coverSheet(pack: PackV2, total: number): string {
  const meta = [pack.meta.yearGroup, pack.meta.subject].filter(Boolean).join(' ');
  const lines = [pack.meta.curriculum, pack.meta.span].filter(Boolean) as string[];
  return `<section class="sheet cover accent-forest">
  <div class="cover-body">
    <img class="crest" src="${CREST}" alt="Lusaka Oaktree School">
    <div class="cover-eyebrow">Lusaka Oaktree School &middot; ${esc(pack.kind ?? 'Study Pack')}</div>
    <h1>${esc(pack.title)}</h1>
    <div class="cover-rule"></div>
    ${pack.subtitle ? `<p class="cover-sub">${esc(pack.subtitle)}</p>` : ''}
    <p class="cover-meta">${esc(meta)}${lines.length ? ` &middot; ${lines.map(esc).join(' &middot; ')}` : ''}</p>
    ${pack.objectives.length ? `<div class="cover-objectives${
      pack.objectives.length > COVER_COLUMNS ? ' cols' : ''}${
      pack.objectives.length > COVER_DENSE ? ' dense' : ''}">
      ${pack.objectives.slice(0, COVER_MAX).map(o =>
        `<p>${o.ref ? `<span class="ref">${esc(o.ref)}</span>` : ''}<span>${esc(o.text)}</span></p>`).join('')}
      ${pack.objectives.length > COVER_MAX
        ? `<p class="more">and ${pack.objectives.length - COVER_MAX} more, stated on the pages that cover them</p>` : ''}
    </div>` : ''}
  </div>
  <div class="cover-foot">1/${total}</div>
</section>`;
}

function sheet(o: {
  pack: PackV2; index: number; total: number; accent: string; paged?: boolean;
  eyebrow: string | null; title: string; objectives: { ref: string | null; text: string }[]; body: string;
  /** Whether this document has a cover, which is where a long objective list is
   *  stated in full. Without one there is nowhere to defer to, so nothing is said. */
  cover?: boolean;
  printOnly?: boolean;
}): string {
  const { pack } = o;
  const subject = `${pack.meta.yearGroup} ${pack.meta.subject}`.trim();
  return `<section class="sheet accent-${esc(o.accent)}${o.printOnly ? ' print-only' : ''}">
  <header class="sheet-head">
    <img class="crest" src="${CREST}" alt="Lusaka Oaktree School">
    <div class="head-text">
      ${o.eyebrow ? `<div class="eyebrow">${esc(o.eyebrow)}</div>` : `<div class="eyebrow">${esc(subject)}</div>`}
      <h2>${esc(o.title)}</h2>
    </div>
    <div class="head-page">${o.index + 1}/${o.total}</div>
  </header>
  ${o.objectives.length ? `<div class="objectives">${o.objectives.slice(0, PAGE_OBJECTIVES).map(t =>
    `<p class="obj">${t.ref ? `<span class="ref">${esc(t.ref)}</span>` : ''}${esc(t.text)}</p>`).join('')}${
    o.objectives.length > PAGE_OBJECTIVES
      ? `<p class="obj muted">and ${o.objectives.length - PAGE_OBJECTIVES} more${
          o.cover === false ? '' : ', listed in full on the cover'}</p>` : ''
  }</div>` : ''}
  <main class="sheet-body">${o.body}</main>
  ${o.paged ? '' : `<footer class="sheet-foot">
    <span>Lusaka Oaktree School &middot; ${esc(pack.meta.subject)}${pack.meta.curriculum ? ` &middot; ${esc(pack.meta.curriculum)}` : ''}</span>
    <span>${esc(pack.meta.span ?? '')}</span>
  </footer>`}
</section>`;
}

// -------------------------------------------------------------------- blocks

function renderBlock(b: Block, pack: PackV2): string {
  switch (b.type) {
    case 'resources':
      return `<div class="block">
        <h3 class="block-title">Helpful resources</h3>
        ${b.intro ? `<p class="lede">${esc(b.intro)}</p>` : ''}
        <div class="grid cols-2">
          ${b.groups.map(g => `<div class="res-group">
            <div class="res-label">${esc(g.label)}</div>
            ${g.items.map(i => `<div class="res-item">
              <div class="res-name">${esc(i.name)}</div>
              <div class="res-why">${esc(i.why)}</div>
              ${i.url ? `<a class="res-url" href="${esc(i.url)}">${esc(i.url)}</a>` : ''}
            </div>`).join('')}
          </div>`).join('')}
        </div></div>`;

    case 'key_notes':
      return `<div class="block"><div class="grid cols-${b.columns === 3 ? 3 : 2}">
        ${b.cards.map(c => `<div class="note-card">
          <div class="note-head">${esc(c.heading)}</div>
          <div class="note-body">${esc(c.body)}</div>
        </div>`).join('')}
      </div></div>`;

    case 'key_ideas':
      return `<div class="block key-ideas">
        <h4>Key ideas</h4>
        <ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
      </div>`;

    case 'worked_example':
      return `<div class="block"><h3 class="block-title">Worked examples</h3>
        <div class="grid cols-${b.examples.length > 1 ? 2 : 1}">${b.examples.map(e => `<div class="worked">
          <div class="worked-q">Q: ${esc(e.prompt)}</div>
          <ol class="worked-steps">${e.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
          <div class="worked-a">Answer: ${esc(e.answer)}</div>
        </div>`).join('')}</div></div>`;

    case 'practice':
      return `<div class="block practice">
        <h3 class="block-title">Practice questions</h3>
        ${b.intro ? `<p class="lede">${esc(b.intro)}</p>` : ''}
        <ol class="q-list cols-${b.columns === 2 ? 2 : 1}">
          ${b.questions.map(q => `<li>
            <span class="q-text">${esc(q.text)}</span>${q.marks != null ? ` <span class="marks">[${q.marks}]</span>` : ''}
            ${answerSpace(q.answer_lines ?? (q.marks && q.marks > 4 ? 4 : 2))}
          </li>`).join('')}
        </ol></div>`;

    case 'glossary':
      return `<div class="block"><h3 class="block-title">Glossary</h3>
        <p class="flash-hint no-print">Tap a card to flip it.</p>
        <div class="flash-grid no-print" data-flash></div>
        <div class="grid cols-2 print-only">${b.terms.map(t =>
          `<div class="note-card"><div class="note-head">${esc(t.term)}</div><div class="note-body">${esc(t.definition)}</div></div>`).join('')}</div>
      </div>`;

    case 'checklist':
      return `<div class="block"><div class="grid cols-${Math.min(3, Math.max(2, b.columns.length))}">
        ${b.columns.map(c => `<div class="check-col">
          <div class="note-head">${esc(c.heading)}</div>
          ${c.blurb ? `<div class="note-body">${esc(c.blurb)}</div>` : ''}
          <ul class="checks">${c.items.map(i => `<li><label><input type="checkbox"><span>${esc(i)}</span></label></li>`).join('')}</ul>
        </div>`).join('')}
      </div></div>`;

    case 'source_card':
      return `<div class="block"><div class="grid cols-${b.sources.length > 1 ? 2 : 1}">
        ${b.sources.map(s => `<div class="source">
          <div class="src-label">${esc(s.label)}</div>
          <div class="src-text">${esc(s.text)}</div>
          ${s.quick_check ? `<div class="src-check"><b>Quick check</b> ${esc(s.quick_check)}</div>` : ''}
        </div>`).join('')}
      </div></div>`;

    case 'table':
      return `<div class="block"><div class="table-wrap"><table>
        <thead><tr>${b.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${b.rows.map(r => `<tr>${r.cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>${b.note ? `<p class="muted small">${esc(b.note)}</p>` : ''}</div>`;

    case 'chart':
      return `<div class="block"><div class="chart-row">
        <div class="chart-main">${chartSvg(b)}</div>
        ${b.aside_items.length ? `<aside class="chart-aside">
          <div class="res-label">${esc(b.aside_heading ?? 'Useful phrases')}</div>
          <ul>${b.aside_items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
        </aside>` : ''}
      </div></div>`;

    case 'two_column':
      return `<div class="block"><div class="grid cols-2">
        <div class="note-card"><div class="note-head">${esc(b.left.heading)}</div><div class="note-body">${esc(b.left.body)}</div></div>
        <div class="note-card"><div class="note-head">${esc(b.right.heading)}</div><div class="note-body">${esc(b.right.body)}</div></div>
      </div></div>`;

    case 'callout':
      return `<div class="block callout tone-${esc(b.tone)}">
        ${b.heading ? `<b>${esc(b.heading)}</b> ` : ''}${esc(b.body)}
      </div>`;

    case 'think':
      return `<div class="block think">
        <h5>Think further</h5>
        <p>${esc(b.question)}</p>
        ${b.resource_name ? `<p class="small">Explore more: ${b.resource_url
          ? `<a href="${esc(b.resource_url)}">${esc(b.resource_name)}</a>`
          : esc(b.resource_name)}</p>` : ''}
      </div>`;

    case 'reflection':
      return `<div class="block reflect">
        <h3 class="block-title">Reflection task</h3>
        <p>${esc(b.prompt)}${b.marks != null ? ` <span class="marks">[${b.marks}]</span>` : ''}</p>
        ${answerSpace(6)}
        ${b.self_check.length ? `<div class="chips">${b.self_check.map(s => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
      </div>`;

    case 'contents':
      return `<div class="block"><h3 class="block-title">${esc(b.heading ?? 'Contents')}</h3>
        <ol class="contents">${pack.pages
          // Number by the page's real position, not by its position in the filtered
          // list: the sheet header prints n/N over every page, and a contents page
          // that disagrees with it reads as a missing page. The cover is sheet 1, so
          // page i is sheet i + 2.
          .map((p, i) => ({ p, n: i + 2 }))
          .filter(({ p }) => p.blocks.some(x => x.type !== 'contents'))
          .map(({ p, n }) => `<li><span class="c-num">${n}</span><span class="c-title">${esc(p.title)}</span>`
            + `<span class="c-eyebrow">${esc(p.eyebrow ?? '')}</span></li>`).join('')}</ol></div>`;

    case 'closing':
      return `<div class="block closing">
        <h3>${esc(b.heading)}</h3>
        <ul>${b.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`;
    // A block type the renderer does not know draws nothing rather than throwing:
    // stored content outlives this file.
    default:
      return '';
  }
}

/** A quiz twice over: live on screen, lettered with room to answer on paper. */
function renderQuiz(id: string, printed: { n: number; q: QuizQ }[]): string {
  return `<div class="block quiz">
    <h3 class="block-title">Quick quiz</h3>
    <div class="no-print" id="${id}"></div>
    <ol class="q-list print-only" style="counter-reset:q ${(printed[0]?.n ?? 1) - 1}">
      ${printed.map(p => `<li><span class="q-text">${esc(p.q.q)}</span>
        <div class="opts${optionRow(p.q.options) <= INLINE_OPTIONS ? ' inline' : ''}">${p.q.options.map((o, i) =>
          `<div class="opt">${OPTION_LETTERS[i] ?? '?'}) ${esc(o)}</div>`).join('')}</div></li>`).join('')}
    </ol>
  </div>`;
}

/**
 * Roughly how wide the options read as one line: each one plus its "A) " and the gap
 * after it. Measured over the row rather than the longest option, so a quiz does not
 * stack one question's answers while its neighbours sit inline.
 */
function optionRow(options: string[]): number {
  return options.reduce((n, o) => n + o.length + 6, 0);
}

function answerSpace(lines: number): string {
  const n = Math.min(12, Math.max(0, lines));
  return n ? `<div class="ruled">${'<span></span>'.repeat(n)}</div>` : '';
}

/** A bar or line chart as inline SVG - no library, prints exactly as it renders. */
function chartSvg(b: Extract<Block, { type: 'chart' }>): string {
  const W = 520, H = 200, PAD_L = 34, PAD_B = 26, PAD_T = 16;
  const max = Math.max(...b.series.map(s => s.value), 1);
  const innerW = W - PAD_L - 10, innerH = H - PAD_B - PAD_T;
  const step = innerW / b.series.length;
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const grid = [0, 0.5, 1].map(f => {
    const yy = PAD_T + innerH - f * innerH;
    return `<line x1="${PAD_L}" y1="${yy}" x2="${W - 10}" y2="${yy}" class="gridline"/>`
      + `<text x="${PAD_L - 6}" y="${yy + 4}" class="axis" text-anchor="end">${Math.round(max * f)}</text>`;
  }).join('');

  const marks = b.kind === 'line'
    ? `<polyline class="line" points="${b.series.map((s, i) =>
        `${PAD_L + step * (i + 0.5)},${y(s.value)}`).join(' ')}"/>`
      + b.series.map((s, i) => `<circle class="dot" cx="${PAD_L + step * (i + 0.5)}" cy="${y(s.value)}" r="3.5"/>`).join('')
    : b.series.map((s, i) => {
        const bw = Math.min(48, step * 0.55), x = PAD_L + step * (i + 0.5) - bw / 2;
        return `<rect class="bar" x="${x}" y="${y(s.value)}" width="${bw}" height="${PAD_T + innerH - y(s.value)}" rx="3"/>`;
      }).join('');

  const labels = b.series.map((s, i) => {
    const cx = PAD_L + step * (i + 0.5);
    return `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(s.label)}</text>`
      + `<text class="value" x="${cx}" y="${y(s.value) - 6}" text-anchor="middle">${esc(s.value)}</text>`;
  }).join('');

  return `<figure class="chart">
    <figcaption>${esc(b.title)}${b.unit ? ` <span class="muted">(${esc(b.unit)})</span>` : ''}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(b.title)}">
      ${grid}${marks}${labels}
      <line x1="${PAD_L}" y1="${PAD_T + innerH}" x2="${W - 10}" y2="${PAD_T + innerH}" class="axis-line"/>
    </svg>
  </figure>`;
}

// ----------------------------------------------------------------------- css

function css(size: { css: string; w: string; h: string; px: string; py: string },
             paged: boolean, slackMm: number): string {
  return `
:root{
  --forest:#1D5829; --forest-dark:#103C19; --forest-light:#31773F; --gold:#E3A73B; --gold-dark:#B8860B;
  --purple:#4D27A5; --pink:#EC4899; --teal:#0D9488; --blue:#194AB3; --green:#16A34A; --red:#DC2626;
  --ink:#26302A; --paper:#FFFDF8; --card:#FFFFFF; --muted:#657064; --line:#D9DED2;
  --shadow:0 6px 18px rgba(23,41,28,.10);
  --accent:var(--forest); --accent-2:var(--forest-light);
  --font-display:'Fraunces',Georgia,serif; --font-body:'Public Sans','Segoe UI',sans-serif;
}
*{box-sizing:border-box;}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important;}}
html,body{margin:0;padding:0;}
body{font-family:var(--font-body);color:var(--ink);background:#EEF1E8;line-height:1.45;font-size:12.5px;}
.print-only{display:none;}
.toolbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;
  gap:12px;padding:10px 18px;background:var(--forest-dark);color:#fff;}
.toolbar .tb-title{font-family:var(--font-display);font-weight:700;font-size:15px;}
.toolbar button{border:none;cursor:pointer;border-radius:999px;padding:8px 16px;font:inherit;font-weight:700;
  background:var(--gold);color:#2A1E05;}
.deck{display:flex;flex-direction:column;align-items:center;gap:18px;padding:18px 12px 40px;}

/* On screen the sheet is fluid, so a pack is readable on a phone and never scrolls
   sideways; it only takes its true page proportions where there is room for them,
   and exactly, in print. The printed page is the master - the screen is a reading. */
.sheet{--px:${size.px};--py:${size.py};
  width:100%;max-width:${size.w};padding:var(--py) var(--px);background:var(--card);
  box-shadow:var(--shadow);display:flex;flex-direction:column;position:relative;overflow:hidden;}
@media screen and (min-width:calc(${size.w} + 40px)){.sheet{min-height:${size.h};}}
.sheet.accent-forest{--accent:var(--forest);--accent-2:var(--forest-light);}
.sheet.accent-purple{--accent:var(--purple);--accent-2:#9F67FF;}
.sheet.accent-teal{--accent:var(--teal);--accent-2:#22D3EE;}
.sheet.accent-blue{--accent:var(--blue);--accent-2:#7C3AED;}
.sheet.accent-gold{--accent:var(--gold-dark);--accent-2:var(--gold);}

/* The page title sits in a full-bleed band, as it does on every page of the school's
   own packs: the band is what makes a section legible at a glance across a printed
   set, and it carries the page number the Reference Guide asks for. It cancels the
   sheet's padding with a negative margin, which is why px and py are separate. */
.sheet-head{display:flex;align-items:center;gap:12px;
  margin:calc(-1 * var(--py)) calc(-1 * var(--px)) 0;
  padding:calc(var(--py) * .62) var(--px);
  background:linear-gradient(105deg,var(--accent),var(--accent-2));color:#fff;}
.sheet-head .crest{width:30px;height:30px;border-radius:50%;background:#fff;flex:none;
  padding:2px;}
.head-text{flex:1;min-width:0;}
.eyebrow{font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;
  color:rgba(255,255,255,.82);}
.sheet-head h2{margin:2px 0 0;font-family:var(--font-display);font-size:22px;font-weight:700;
  line-height:1.12;color:#fff;}
.head-page{font-size:11px;font-weight:700;color:rgba(255,255,255,.8);flex:none;}

/* Objectives in full, under the band. The code leads in gold, as on the GP cover. */
.objectives{display:flex;flex-direction:column;gap:3px;
  margin:0 calc(-1 * var(--px));padding:7px var(--px);background:#F5F7F0;
  border-bottom:1px solid var(--line);}
.obj{margin:0;font-size:10.5px;color:#3F4A40;line-height:1.35;}
.obj .ref{font-weight:700;color:var(--gold-dark);margin-right:6px;}
.sheet-body{flex:1;padding-top:11px;}
.sheet-foot{display:flex;justify-content:space-between;gap:10px;margin-top:10px;padding-top:6px;
  border-top:1px solid var(--line);font-size:9.5px;color:var(--muted);}

/* The cover: one dark panel, as both reference packs open on. */
.cover{color:#fff;background:linear-gradient(135deg,var(--forest-dark),var(--forest));
  justify-content:center;}
.cover::after{content:"";position:absolute;right:-14%;top:-32%;width:62%;aspect-ratio:1;
  border-radius:50%;background:rgba(255,255,255,.045);}
.cover-body{position:relative;z-index:1;max-width:72%;}
.cover-body:has(.cover-objectives.cols){max-width:92%;}
.cover .crest{width:74px;height:74px;border-radius:50%;background:#fff;padding:4px;
  display:block;margin-bottom:16px;}
.cover-eyebrow{font-size:11px;font-weight:700;letter-spacing:.19em;text-transform:uppercase;
  color:rgba(255,255,255,.78);}
.cover h1{font-family:var(--font-display);font-size:44px;line-height:1.06;margin:8px 0 0;font-weight:700;}
.cover-rule{width:132px;height:7px;background:var(--gold);margin:16px 0 14px;}
.cover-sub{margin:0 0 4px;font-size:16px;color:rgba(255,255,255,.9);}
.cover-meta{margin:0;font-size:13px;font-weight:600;color:rgba(255,255,255,.82);}
.cover-objectives{margin-top:18px;display:flex;flex-direction:column;gap:5px;}
/* A four week span can carry thirty objectives, and they all belong here - every
   section header says so. Past ten they run in two columns, past twenty they run
   smaller as well, and the panel takes the width it needs to hold them. */
.cover-objectives.cols{display:block;columns:2;column-gap:20px;}
.cover-objectives.cols p{break-inside:avoid;margin-bottom:4px;}
.cover-objectives.dense p{font-size:9.5px;line-height:1.3;margin-bottom:2px;}
.cover-objectives p{margin:0;font-size:11.5px;color:rgba(255,255,255,.88);}
.cover-objectives .ref{font-weight:700;color:var(--gold);margin-right:8px;}
.cover-objectives .more{color:rgba(255,255,255,.6);font-style:italic;}
.cover-foot{position:relative;z-index:1;margin-top:auto;font-size:10px;
  color:rgba(255,255,255,.6);}

.block{margin-bottom:11px;}
/* Two half-width blocks, side by side. The inner grids of whatever landed in them
   collapse to one column - three columns of notes in half a page is a column of
   syllables. */
.row{display:grid;grid-template-columns:1fr 1fr;gap:13px;align-items:start;margin-bottom:11px;}
.row > .block{margin-bottom:0;}
.row .cols-2,.row .cols-3{grid-template-columns:1fr;}
.row .q-list.cols-2{column-count:1;}
.block:last-child{margin-bottom:0;}
.block-title{margin:0 0 7px;font-family:var(--font-display);font-size:15px;color:var(--accent);}
.lede{margin:0 0 8px;color:var(--muted);}
.muted{color:var(--muted);} .small{font-size:10px;}
.grid{display:grid;gap:9px;}
.cols-1{grid-template-columns:1fr;} .cols-2{grid-template-columns:1fr 1fr;}
.cols-3{grid-template-columns:1fr 1fr 1fr;}

.note-card{background:#F5F7F0;border-left:4px solid var(--accent);border-radius:8px;padding:9px 12px;}
.note-head{font-weight:700;color:var(--accent);margin-bottom:3px;}
.note-body{white-space:pre-line;}
.key-ideas{background:#F5F7F0;border-left:5px solid var(--accent);border-radius:8px;padding:9px 13px;}
.key-ideas h4{margin:0 0 5px;font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}
.key-ideas ul{margin:0;padding-left:17px;} .key-ideas li{margin-bottom:3px;}

.res-group{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:#FCFDFA;}
.res-label{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:5px;}
.res-item{margin-bottom:7px;} .res-item:last-child{margin-bottom:0;}
.res-name{font-weight:700;} .res-why{font-size:10.5px;color:var(--muted);}
.res-url{font-size:10px;color:var(--blue);word-break:break-all;}

.worked{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:#FCFDFA;}
.worked-q{font-weight:700;margin-bottom:4px;}
.worked-steps{margin:0 0 5px;padding-left:18px;} .worked-steps li{margin-bottom:2px;}
.worked-a{font-weight:700;color:var(--green);}

/* Numbered questions with a badge and the marks in gold, as on GP LS3's section
   pages. The counter is on the list, so a two-column drill still numbers 1-10 down
   the first column and on into the second. */
.q-list{list-style:none;margin:0;padding:0;counter-reset:q;}
.q-list.cols-2{column-count:2;column-gap:24px;}
.q-list li{counter-increment:q;position:relative;padding-left:27px;margin-bottom:9px;
  break-inside:avoid;}
.q-list li::before{content:counter(q);position:absolute;left:0;top:0;width:20px;height:20px;
  border-radius:50%;background:var(--accent);color:#fff;font-size:10.5px;font-weight:700;
  display:flex;align-items:center;justify-content:center;}
.q-text{font-weight:500;}
.marks{color:var(--gold-dark);font-weight:700;font-size:10.5px;}
.ruled{margin-top:6px;display:flex;flex-direction:column;gap:11px;}
.ruled span{display:block;border-bottom:1px dotted #B9C2B2;height:1px;}
.opts{margin-top:3px;} .opt{padding:2px 0 2px 6px;}
/* "A) 5  B) 6  C) 7" belongs on one line. Stacked, five such questions ran a maths
   sheet on to a second page over four words of answer. Options long enough to be read
   as sentences keep a line each - see INLINE_OPTION. */
.opts.inline{display:flex;flex-wrap:wrap;column-gap:22px;}
.opts.inline .opt{padding:2px 0;}

.source{border:1px solid var(--line);border-radius:10px;background:#FCFDFA;overflow:hidden;}
.src-label{background:var(--accent);color:#fff;font-weight:700;padding:6px 11px;}
.src-text{padding:9px 11px 0;}
.src-check{margin:8px 11px 10px;background:#F1F5FF;border:1px dashed #C7D2FE;border-radius:6px;
  padding:6px 9px;font-size:11px;}

.table-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;}
th{background:var(--accent);color:#fff;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;
  padding:6px 8px;text-align:left;}
td{border:1px solid var(--line);padding:6px 8px;vertical-align:top;}
tbody tr:nth-child(even) td{background:#F8FAF5;}

.chart-row{display:flex;gap:12px;align-items:flex-start;}
.chart-main{flex:2;min-width:0;} .chart-aside{flex:1;border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:#FCFDFA;}
.chart-aside ul{margin:0;padding-left:16px;font-size:10.5px;}
.chart figcaption{font-weight:700;margin-bottom:4px;}
.chart svg{width:100%;height:auto;}
.chart .gridline{stroke:#E4E8DE;stroke-width:1;}
.chart .axis-line{stroke:#9AA595;stroke-width:1;}
.chart .axis{font-size:10px;fill:var(--muted);}
.chart .value{font-size:10px;font-weight:700;fill:var(--accent);}
.chart .bar{fill:var(--accent);}
.chart .line{fill:none;stroke:var(--accent);stroke-width:2.5;}
.chart .dot{fill:var(--accent);}

.callout{border-radius:10px;padding:8px 11px;border:1px solid;}
.tone-note{background:#F1F5FF;border-color:#C7D2FE;}
.tone-tip{background:#F0FDF4;border-color:#86EFAC;}
.tone-warning{background:#FEF2F2;border-color:#FCA5A5;}

.think{background:#FFF7ED;border:2px solid #FDBA74;border-radius:10px;padding:9px 12px;}
.think h5{margin:0 0 4px;font-size:11px;}
.think p{margin:0;}

.reflect{background:#F7F5FF;border:2px solid #DDD3FF;border-radius:10px;padding:10px 12px;}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;}
.chip{background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:10px;font-weight:600;}

.check-col{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:#FCFDFA;}
.checks{list-style:none;margin:6px 0 0;padding:0;}
.checks li{margin-bottom:4px;} .checks label{display:flex;gap:7px;align-items:flex-start;cursor:pointer;}
.checks input{margin:2px 0 0;width:13px;height:13px;flex:none;}

.contents{list-style:none;margin:0;padding:0;}
.contents li{display:flex;align-items:baseline;gap:12px;padding:6px 0;
  border-bottom:1px dotted var(--line);}
.contents .c-num{flex:none;width:26px;height:26px;border-radius:50%;background:var(--accent);
  color:#fff;font-family:var(--font-display);font-weight:700;font-size:12px;
  display:flex;align-items:center;justify-content:center;}
.contents .c-title{flex:1;font-family:var(--font-display);font-size:15px;color:var(--accent);}
.contents .c-eyebrow{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);}
.closing h3{font-family:var(--font-display);color:var(--accent);margin:0 0 6px;}
.closing ul{margin:0;padding-left:18px;}
.answer-key p{margin:0 0 4px;}

.quiz-score{font-weight:700;color:var(--accent);margin-bottom:8px;}
.quiz-q{margin-bottom:10px;} .quiz-question{font-weight:600;margin:0 0 5px;}
.quiz-opts{display:flex;flex-direction:column;gap:4px;}
.quiz-opt{text-align:left;padding:6px 10px;border:2px solid var(--line);background:#fff;border-radius:8px;
  cursor:pointer;font-size:11px;font-family:inherit;}
.quiz-opt:hover:not(:disabled){border-color:var(--accent);}
.quiz-opt:disabled{cursor:default;opacity:.95;}
.opt-correct{background:#F0FDF4;border-color:#86EFAC;font-weight:600;}
.opt-wrong{background:#FEF2F2;border-color:#FCA5A5;}
.quiz-explain{font-size:10px;color:var(--muted);margin:4px 0 0;}

.flash-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:9px;}
.flash-hint{font-size:10px;color:var(--muted);margin:0 0 6px;}
.flashcard{perspective:800px;height:86px;cursor:pointer;}
.flash-inner{position:relative;width:100%;height:100%;transition:transform .5s;transform-style:preserve-3d;}
.flashcard.flipped .flash-inner{transform:rotateY(180deg);}
.flash-front,.flash-back{position:absolute;width:100%;height:100%;backface-visibility:hidden;border-radius:9px;
  display:flex;align-items:center;justify-content:center;padding:8px;text-align:center;box-shadow:var(--shadow);}
.flash-front{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700;}
.flash-back{background:#fff;border:2px solid var(--accent);transform:rotateY(180deg);font-size:10px;}

@media print{
  @page{size:${size.css};margin:${paged ? `0 0 ${slackMm}mm` : '0'};}
${printRules(size, paged, slackMm, '  ')}
}
/* The same rules again, on screen, under a class the paginator puts on <html> while
   it measures.

   The paginator has to know how tall a sheet really is on paper, and a sheet measured
   against the screen stylesheet is a different sheet: it is fluid rather than 297mm
   wide, its answer key and its printed quiz lists are display:none, and the two do not
   split in the same place. The server print gets this for free by emulating print
   media before it measures; a teacher pressing Ctrl+P cannot, so the document puts
   the print geometry on itself for the length of the measurement instead. */
${printRules(size, paged, slackMm, '.measuring ')}
.measuring .sheet{width:${size.w};max-width:${size.w};}
.measuring .toolbar{display:none!important;}`;
}

/**
 * Everything the printed page changes about the screen one.
 *
 * Emitted twice - inside `@media print`, and behind `.measuring` for the pass the
 * paginator makes before a browser print. Anything that only makes sense to a printer,
 * `@page` above, stays out of here.
 */
function printRules(size: { css: string; w: string; h: string; px: string; py: string },
                    paged: boolean, slackMm: number, at: string): string {
  const p = (sel: string) => sel.split(',').map(x => `${at}${x.trim()}`).join(',');
  return `
  ${p('body')}{background:#fff;}
  ${p('.no-print')}{display:none!important;}
  ${p('.print-only')}{display:block!important;}
  ${p('.sheet.print-only')}{display:flex!important;}
  ${p('.grid.print-only')}{display:grid!important;}
  ${p('.deck')}{padding:0;gap:0;}
  /* A hair under the page, not exactly it: Chrome lays A4 out as 594.96pt, which is
     209.98mm, so a sheet asking for a full 210mm overflowed by a third of a point and
     pushed its footer onto a blank continuation page. In the paged variant the sheet
     takes its natural height instead - a section longer than one page runs on to the
     next, with the stamped footer on both. Content is never clipped either way:
     losing a question silently would be far worse than an extra page. */
  ${p('.sheet')}{box-shadow:none;break-after:page;page-break-after:always;width:100%;max-width:none;
    /* overflow:hidden is what rounds the accent bar on screen; in print it would
       clip the very content the spill exists to preserve. */
    overflow:visible;
    ${paged ? 'padding-bottom:1mm;' : `min-height:calc(${size.h} - ${slackMm}mm);`}}
  ${paged ? `${p('.paged .head-page')},${p('.paged .cover-foot')}{display:none;}` : ''}
  /* Every other sheet may take its natural height in the paged variant; the cover
     is a full-page panel and a half-painted one looks like a printing fault.
     It also keeps clipping its decoration, unlike every other sheet: the circle
     hangs 14% past the right edge, and with overflow visible it widened the layout
     to 338mm. Chrome then scaled the whole document by 297/338 to fit the paper, so
     every millimetre in this stylesheet printed 12 per cent short and the panel
     covered seven eighths of the page. Nothing but decoration is outside the box. */
  ${p('.sheet.cover')}{min-height:calc(${size.h} - ${slackMm}mm);overflow:hidden;}
  /* Without a fixed sheet height there is nothing to stretch into, and a stretched
     body leaves a page of white between the last block and the page break. */
  ${paged ? `${p('.paged .sheet-body')}{flex:none;}` : ''}
  ${p('.sheet:last-child')}{break-after:auto;page-break-after:auto;}
  ${p('.block')},${p('.note-card')},${p('.worked')},${p('.source')},${p('.res-group')},${p('.row')}{break-inside:avoid;}`;
}

// -------------------------------------------------------------------- engine

function engine(): string {
  return `
/**
 * Split any sheet taller than the page it is printed on.
 *
 * A sheet is a page. Real content does not respect that on its own: a section with
 * three dense blocks runs past the sheet, and the browser then prints a continuation
 * page with no heading, no objectives and no crest - which is exactly the "branding on
 * every page" rule broken. Estimating heights server-side would be guesswork (a block's
 * height depends on the text in it), so the browser that is about to print measures the
 * real thing and moves the overflow onto a fresh sheet that carries the same heading,
 * marked "(continued)".
 *
 * The print renderer calls this after emulating print media, so the measurements are
 * the printed ones. lib/pdf/renderers/studypack_print.ts.
 */
window.__packPaginate=function(pagePx){
  var deck=document.querySelector('.deck'); if(!deck||!pagePx) return 0;
  // Splitting a document that has already been split would cut it again at the new
  // sheet boundaries. One pass per document, whoever asks for it.
  if(window.__packPrepared) return 0;
  window.__packPrepared=true;
  var made=0,guard=0;
  var over=function(el){return el.getBoundingClientRect().height>pagePx+2;};
  var queue=[].slice.call(deck.querySelectorAll('.sheet'));
  while(queue.length&&guard++<300){
    var sheet=queue.shift();
    if(sheet.classList.contains('cover')) continue;
    var body=sheet.querySelector('.sheet-body');
    if(!body||!body.children.length) continue;
    if(!over(sheet)) continue;
    var next=sheet.cloneNode(true);
    var nextBody=next.querySelector('.sheet-body');
    while(nextBody.firstChild) nextBody.removeChild(nextBody.firstChild);
    var h2=next.querySelector('.sheet-head h2');
    if(h2&&h2.textContent.indexOf('(continued)')<0) h2.textContent=h2.textContent+' (continued)';
    while(over(sheet)&&body.children.length>1){
      nextBody.insertBefore(body.lastElementChild,nextBody.firstChild);
    }
    // A single block taller than the page. Moving whole blocks cannot help here, and
    // leaving it spilled is what printed a sheet carrying four questions and a footer:
    // a ten question drill with five ruled lines each is half a page longer than the
    // page. So the list inside it is split instead, and its numbering carried across.
    if(over(sheet)) splitList(sheet,body,nextBody,pagePx);
    if(!nextBody.children.length) continue;   // nothing could be moved: let it spill
    sheet.parentNode.insertBefore(next,sheet.nextSibling);
    made++;
    queue.unshift(next);   // a continuation sheet can overflow in its turn
  }
  // The page numbers drawn into the headers are now wrong, so redraw them.
  var all=deck.querySelectorAll('.sheet'),n=all.length;
  for(var j=0;j<n;j++){
    var tag=all[j].querySelector('.head-page')||all[j].querySelector('.cover-foot');
    if(tag) tag.textContent=(j+1)+'/'+n;
  }
  return made;
};

/**
 * Split the document before a browser print, the way the server print does.
 *
 * The pack's own toolbar button and Ctrl+P both come through here. Without it nothing
 * ran the paginator on the teacher's own machine: a ten sheet pack printed as fifteen
 * pages, five of them carrying a footer and nothing else, and the headers still read
 * "3/10". The server print (lib/pdf/renderers/studypack_print.ts) emulates print media
 * and calls __packPaginate directly; here the print geometry is put on the document
 * for the length of the measurement instead, which is what the .measuring class is.
 */
window.__packPrepare=function(){
  if(window.__packPrepared) return 0;
  var root=document.documentElement;
  root.classList.add('measuring');
  try{ return window.__packPaginate(window.__packPagePx); }
  finally{ root.classList.remove('measuring'); }
};
window.addEventListener('beforeprint',function(){window.__packPrepare();});

/**
 * Move the tail of a block's list onto the continuation sheet.
 *
 * The last resort of the paginator, for the one block that is taller than a page on
 * its own. The block is cloned without its title and lede - the sheet header already
 * says "(continued)" - and its trailing list items are moved across one at a time
 * until the sheet fits. The list numbers itself with a CSS counter, so the clone is
 * told where to start or a continued drill would number itself 1 again.
 */
function splitList(sheet,body,nextBody,pagePx){
  var block=body.lastElementChild; if(!block) return;
  var list=block.querySelector('ol,ul'); if(!list||list.children.length<2) return;
  var start=0,m=/counter-reset:\s*q\s+(-?\d+)/.exec(list.getAttribute('style')||'');
  if(m) start=parseInt(m[1],10);
  var clone=block.cloneNode(true);
  var cloneList=clone.querySelector('ol,ul');
  while(cloneList.firstChild) cloneList.removeChild(cloneList.firstChild);
  var title=clone.querySelector('.block-title'); if(title) title.parentNode.removeChild(title);
  var lede=clone.querySelector('.lede'); if(lede) lede.parentNode.removeChild(lede);
  nextBody.insertBefore(clone,nextBody.firstChild);
  while(sheet.getBoundingClientRect().height>pagePx+2&&list.children.length>1){
    cloneList.insertBefore(list.lastElementChild,cloneList.firstChild);
  }
  if(!cloneList.children.length){ nextBody.removeChild(clone); return; }
  cloneList.style.counterReset='q '+(start+list.children.length);
}

function initQuiz(id,questions){var el=document.getElementById(id);if(!el)return;
el.innerHTML='<div class="quiz-score">Score: 0 / '+questions.length+'</div>'+questions.map(function(q,qi){
return '<div class="quiz-q"><p class="quiz-question">'+(qi+1)+'. '+q.q+'</p><div class="quiz-opts">'+q.options.map(function(o,oi){
return '<button class="quiz-opt" data-q="'+qi+'" data-o="'+oi+'">'+o+'</button>';}).join('')+
'</div><p class="quiz-explain" data-qi="'+qi+'"></p></div>';}).join('');
var score=0,answered=new Array(questions.length).fill(false),scoreEl=el.querySelector('.quiz-score');
el.querySelectorAll('.quiz-opt').forEach(function(btn){btn.addEventListener('click',function(){
var qi=+btn.dataset.q,oi=+btn.dataset.o;if(answered[qi])return;answered[qi]=true;
var q=questions[qi],opts=el.querySelectorAll('.quiz-opt[data-q="'+qi+'"]');
opts.forEach(function(o){o.disabled=true;});
if(oi===q.correct){btn.classList.add('opt-correct');score++;}else{btn.classList.add('opt-wrong');opts[q.correct].classList.add('opt-correct');}
el.querySelector('.quiz-explain[data-qi="'+qi+'"]').textContent=q.explain;
scoreEl.textContent='Score: '+score+' / '+questions.length;});});}
function initFlash(cards){document.querySelectorAll('[data-flash]').forEach(function(el){
el.innerHTML=cards.map(function(c){return '<div class="flashcard" onclick="this.classList.toggle(\\'flipped\\')">'+
'<div class="flash-inner"><div class="flash-front">'+c.front+'</div><div class="flash-back">'+c.back+'</div></div></div>';}).join('');});}`;
}
