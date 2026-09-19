/**
 * The lesson as a real PowerPoint.
 *
 * Not a PDF with a .pptx extension and not an HTML page that looks like slides:
 * a genuine OOXML package, which a teacher opens in PowerPoint or Google Slides,
 * edits, reorders and presents. That is the whole point of exporting at all - a
 * deck a teacher cannot change is a deck they will not use.
 *
 * THREE DECISIONS WORTH KNOWING ABOUT.
 *
 * 1. Diagrams are rasterised, not redrawn. lib/lesson/visuals.ts already draws
 *    every diagram as standalone SVG for the on-screen deck; sharp turns that
 *    into a PNG on the way in here. Redrawing nine diagram kinds a second time
 *    in pptxgenjs shapes would be a second drawing engine to keep in step with
 *    the first, and it would still not give a teacher shapes they could
 *    meaningfully edit. A picture that is right beats shapes that drift.
 *
 * 2. The fonts are Office fonts, not the theme's. A theme asks for Fraunces or
 *    Space Grotesk, which a teacher's laptop does not have; PowerPoint would
 *    substitute something arbitrary and reflow every slide. So a serif theme
 *    exports as Georgia and a sans theme as Calibri - both ship with Office on
 *    Windows and macOS. The colours are the theme's, and they carry the identity.
 *
 * 3. Answers are never on a slide. They are in the notes pane, where the
 *    teacher sees them on the presenter display and the projector does not. The
 *    one exception is a worked example marked `reveal`, which gets a second
 *    slide of its own - PowerPoint has no reveal, and an answer slide is what a
 *    teacher would have built by hand.
 *
 * The notes pane is the teaching guide: purpose, timing, what to say, what to
 * listen for, the misconceptions, and every answer. That is requirement ten of
 * the brief, delivered inside the file rather than beside it.
 */
import type PptxGenJS from 'pptxgenjs';
import { CREST } from '@/lib/crest';
import { themeById, type Theme } from '@/lib/studypack/themes';
import { ACCENTS } from '@/lib/studypack/schema';
import { PHASE_LABEL, type LessonDeck, type Slide, type SlideBlock } from './schema';
import { paletteFor, svgForBlock, type Palette } from './visuals';
import { revealables, sameAs } from './render_html';
import { loadAssetBytes } from './assets';
import { readLesson, saveDeck } from './persist';

const SCHOOL = 'Lusaka Oaktree School';

/** LAYOUT_16x9, in inches. Every coordinate below is in these units. */
const W = 10;
const H = 5.625;
const PAD = 0.5;
const BODY_TOP = 1.5;
const BODY_BOTTOM = 5.02;
const BODY_H = BODY_BOTTOM - BODY_TOP;

/** How much of a slide's width a column takes when two blocks sit side by side. */
const COL_W = (W - PAD * 2 - 0.3) / 2;

/** Rasterise SVG at this many dots per inch of slide. 200 is crisp on a projector
 *  and on a printed handout without making a twenty slide deck enormous. */
const RASTER_DPI = 200;
const MAX_RASTER_PX = 2400;

interface Rect { x: number; y: number; w: number; h: number }

interface Ctx {
  pptx: PptxGenJS;
  deck: LessonDeck;
  theme: Theme;
  fonts: { display: string; body: string; mono: string };
  /** asset id -> PNG/JPEG data URI. */
  assets: Record<string, string>;
  /** Diagram/chart svg -> data URI, resolved before drawing. */
  images: Map<string, { data: string; ratio: number }>;
  /** Set when something had to degrade, and written back to the row. */
  notes: string[];
}

/** The renderer, as the registry calls it. */
export async function renderLessonPptx(lessonId: string): Promise<Uint8Array> {
  const row = await readLesson(lessonId);
  if (!row?.content) throw new Error('lesson not found');
  const deck = row.content;

  const assetBytes = await loadAssetBytes(lessonId);
  const assets: Record<string, string> = {};
  for (const [id, a] of Object.entries(assetBytes)) {
    assets[id] = `data:${a.contentType};base64,${a.bytes.toString('base64')}`;
  }

  const { bytes, notes } = await buildPptx(deck, assets);

  // A degraded render is recorded rather than hidden, the same way a study pack
  // records why it got the plain PDF (lib/pdf/renderers/studypack_print.ts).
  if (notes.length) {
    await saveDeck(lessonId, { ...deck, render_note: notes.join(' ') }, {}).catch(() => {});
  }
  return bytes;
}

/** Pure enough to run from the render-check script: a deck in, bytes out. */
export async function buildPptx(
  deck: LessonDeck, assets: Record<string, string> = {},
): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const PptxGenJSCtor = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJSCtor();
  const theme = themeById(deck.theme);

  pptx.layout = 'LAYOUT_16x9';
  pptx.author = SCHOOL;
  pptx.company = SCHOOL;
  pptx.title = deck.title;
  pptx.subject = `${deck.meta.yearGroup} ${deck.meta.subjectName} - ${deck.meta.topic}`;

  const ctx: Ctx = {
    pptx, deck, theme,
    fonts: fontsFor(theme),
    assets,
    images: new Map(),
    notes: [],
  };

  // Rasterise every drawing first: it is async, and everything after it is not.
  await rasterise(ctx);

  defineMasters(ctx);

  for (const [i, slide] of (deck.slides ?? []).entries()) {
    drawSlide(ctx, slide, i, deck.slides.length);
  }

  const out = await pptx.write({ outputType: 'nodebuffer' }) as Buffer;
  return { bytes: new Uint8Array(out), notes: ctx.notes };
}

// -------------------------------------------------------------------- theme

/**
 * Office fonts, chosen by what the theme was reaching for.
 *
 * Georgia and Calibri both ship with Microsoft Office on Windows and macOS and
 * with Google Slides' font list, so the exported deck opens looking like itself
 * on a teacher's own machine.
 */
function fontsFor(theme: Theme): Ctx['fonts'] {
  const serif = /Fraunces|Source Serif|Georgia/i.test(theme.display);
  return {
    display: serif ? 'Georgia' : 'Calibri',
    body: 'Calibri',
    mono: 'Consolas',
  };
}

/** pptxgenjs wants bare hex. */
function hex(colour: string): string {
  return String(colour ?? '').replace('#', '').toUpperCase() || '000000';
}

/**
 * One master, and the accent drawn per slide.
 *
 * It was five masters, one per accent, which read better as a design and was
 * wrong as a file: pptxgenjs embeds a master's images per master, so the crest
 * went into the package five times and put 90KB of duplicate PNG into every
 * deck. The accent is a single coloured rectangle, so drawing it on the slide
 * costs nothing and the shared furniture stays where a teacher restyling the
 * deck in PowerPoint would look for it.
 */
const MASTER = 'LOTS';

function defineMasters(ctx: Ctx): void {
  const { pptx, theme } = ctx;
  pptx.defineSlideMaster({
    title: MASTER,
    background: { color: hex(theme.ink.card) },
    objects: [
      {
        text: {
          text: SCHOOL,
          options: {
            x: PAD, y: H - 0.38, w: 4, h: 0.25, fontSize: 9,
            color: hex(theme.ink.muted), fontFace: ctx.fonts.body,
          },
        },
      },
      {
        line: {
          x: PAD, y: H - 0.42, w: W - PAD * 2, h: 0,
          line: { color: hex(theme.ink.line), width: 0.75 },
        },
      },
      { image: { x: W - PAD - 0.3, y: H - 0.42, w: 0.3, h: 0.3, data: CREST } },
    ],
  });
}

// -------------------------------------------------------------- rasterising

/**
 * Every diagram and chart, drawn as SVG and rasterised once.
 *
 * sharp reads SVG through librsvg, which is a native dependency and the one
 * thing here that can be absent on a host. A failure is not fatal: the slide
 * falls back to the diagram's own labels as text, the deck records why, and the
 * teacher gets a slide with the words on it instead of a hole. That is the same
 * bargain the study pack strikes with its PDF.
 */
async function rasterise(ctx: Ctx): Promise<void> {
  const jobs: { key: string; svg: string }[] = [];
  for (const s of ctx.deck.slides ?? []) {
    const palette = paletteFor(ctx.deck.theme, s.accent);
    for (const b of s.blocks) {
      if (b.type !== 'diagram' && b.type !== 'chart') continue;
      const svg = svgForBlock(b, palette);
      if (svg) jobs.push({ key: svgKey(s.id, b), svg });
    }
  }
  if (!jobs.length) return;

  let sharp: Awaited<typeof import('sharp')>['default'] | null = null;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    ctx.notes.push('Diagrams were exported as text because the image library could not be loaded.');
    console.error(`[lesson-pptx] sharp unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  let failed = 0;
  for (const job of jobs) {
    try {
      const size = svgSize(job.svg);
      const targetPx = Math.min(MAX_RASTER_PX, Math.round((W - PAD * 2) * RASTER_DPI));
      // Render at the right size rather than upscaling a small render: density
      // scales what librsvg draws, resize only stretches what it drew.
      const density = Math.min(600, Math.max(72, Math.round((targetPx / size.w) * 72)));
      const png = await sharp!(Buffer.from(job.svg), { density })
        .png({ compressionLevel: 9 })
        .toBuffer();
      ctx.images.set(job.key, {
        data: `data:image/png;base64,${png.toString('base64')}`,
        ratio: size.w / size.h,
      });
    } catch (e) {
      failed++;
      console.error(`[lesson-pptx] could not rasterise ${job.key}: `
        + `${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed) {
    ctx.notes.push(`${failed} diagram(s) could not be drawn and were exported as text.`);
  }
}

function svgKey(slideId: string, b: SlideBlock): string {
  return `${slideId}:${b.type}:${JSON.stringify(b).length}`;
}

/** The intrinsic size, from the attributes lib/lesson/visuals.ts writes. */
function svgSize(svg: string): { w: number; h: number } {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (vb) return { w: Number(vb[1]) || 880, h: Number(vb[2]) || 400 };
  return { w: 880, h: 400 };
}

// -------------------------------------------------------------------- slides

function drawSlide(ctx: Ctx, s: Slide, index: number, total: number): void {
  const accentIndex = Math.max(0, ACCENTS.indexOf(s.accent));
  const palette = paletteFor(ctx.deck.theme, s.accent);
  const slide = ctx.pptx.addSlide({ masterName: MASTER });

  // The theme's composition goes down first, so everything after it sits on top.
  // The cover belongs to the title slide alone; every other slide gets the
  // theme's header. Drawn per slide rather than on the master because the accent
  // belongs to the slide's phase - see defineMasters.
  const isCover = s.phase === 'title' && !s.blocks.length;
  if (isCover) coverBackground(ctx, slide, palette);
  else headerBar(ctx, slide, palette);

  // ---- the chrome
  // White where the cover puts it on the accent colour, or it vanishes.
  const onColour = isCover && (ctx.theme.cover === 'panel' || ctx.theme.cover === 'split');
  slide.addText(s.eyebrow ?? PHASE_LABEL[s.phase], {
    x: PAD, y: 0.3, w: 6, h: 0.26,
    fontSize: 10, bold: true, color: onColour ? 'FFFFFF' : hex(palette.accent),
    fontFace: ctx.fonts.display, charSpacing: 1.6,
  });

  const refs = s.objective_indexes
    .map(i => ctx.deck.objectives[i]?.ref).filter(Boolean).join('  ');
  if (refs) {
    slide.addText(refs, {
      x: W - PAD - 3, y: 0.3, w: 3, h: 0.26, align: 'right',
      fontSize: 10, bold: true, color: hex(palette.mark), fontFace: ctx.fonts.body,
    });
  }

  slide.addText(`${index + 1} / ${total}`, {
    x: W - PAD - 1.4, y: H - 0.38, w: 1.1, h: 0.25, align: 'right',
    fontSize: 9, color: hex(palette.muted), fontFace: ctx.fonts.body,
  });

  if (s.audience === 'student_facing') {
    slide.addText('YOUR TURN', {
      x: W / 2 - 0.6, y: H - 0.37, w: 1.2, h: 0.22, align: 'center',
      fontSize: 8, bold: true, color: 'FFFFFF', fontFace: ctx.fonts.body, charSpacing: 1.2,
      fill: { color: hex(palette.accent) }, rectRadius: 0.1, shape: ctx.pptx.ShapeType.roundRect,
    });
  }

  // ---- the deck's own slides
  if (s.phase === 'title' && !s.blocks.length) { titleSlide(ctx, slide, palette); }
  else if (s.phase === 'objectives' && !s.blocks.length) { objectivesSlide(ctx, slide, s, palette); }
  else if (s.phase === 'summary' && !s.blocks.length) { summarySlide(ctx, slide, s, palette); }
  else {
    slide.addText(s.title, {
      x: PAD, y: 0.64, w: W - PAD * 2, h: 0.78,
      fontSize: titleSize(s.title), bold: true, color: hex(palette.ink),
      fontFace: ctx.fonts.display, valign: 'top',
    });
    headerUnderTitle(ctx, slide, palette);
    placeBlocks(ctx, slide, s, palette);
  }

  slide.addNotes(speakerNotes(ctx.deck, s, index, total));

  // ---- the answer slide, where a worked example was held back
  for (const b of s.blocks) {
    if (b.type === 'worked_example' && b.reveal && b.answer) {
      answerSlide(ctx, s, b.prompt, b.answer, b.steps, palette);
    }
  }
}

/** A long title at 28pt runs off the slide; this is the one thing pptx cannot do
 *  for itself, because it will not shrink text to fit without a hint. */
function titleSize(title: string): number {
  if (title.length > 72) return 20;
  if (title.length > 52) return 24;
  return 28;
}

function titleSlide(ctx: Ctx, slide: PptxGenJS.Slide, p: Palette): void {
  const m = ctx.deck.meta;
  const cover = ctx.theme.cover;
  // Where the words go, and what colour they are, depends on what is behind them.
  const onColour = cover === 'panel' || cover === 'band';
  const x = cover === 'split' ? SPLIT_W + 0.4 : PAD;
  const w = W - x - PAD;
  const ink = onColour ? 'FFFFFF' : hex(p.ink);
  const soft = onColour ? 'F1F1F1' : hex(p.muted);
  const keyColour = onColour ? 'FFFFFF' : hex(p.accent);

  slide.addText(ctx.deck.title, {
    x, y: 1.45, w, h: 1.3,
    fontSize: ctx.deck.title.length > 48 ? 32 : 40, bold: true, color: ink,
    fontFace: ctx.fonts.display, valign: 'bottom',
  });
  if (cover === 'rule') {
    slide.addShape('rect', { x, y: 2.85, w: 2.2, h: 0.1, fill: { color: hex(p.accent) } });
  }
  if (ctx.deck.subtitle) {
    slide.addText(ctx.deck.subtitle, {
      x, y: cover === 'rule' ? 3.0 : 2.8, w, h: 0.4,
      fontSize: 16, color: soft, fontFace: ctx.fonts.body,
    });
  }
  if (m.key_question) {
    // Below the band when there is one, so the question reads against the page.
    const y = cover === 'band' ? 3.7 : 3.35;
    const colour = cover === 'band' ? hex(p.accent) : keyColour;
    slide.addText(m.key_question, {
      x: x + 0.12, y, w: w - 0.12, h: 0.7,
      fontSize: 18, italic: true, color: colour, fontFace: ctx.fonts.body, valign: 'top',
    });
    slide.addShape('rect', {
      x, y, w: 0.06, h: 0.7, fill: { color: cover === 'panel' ? hex(p.mark) : colour },
    });
  }
  slide.addText(`${m.yearGroup} ${m.subjectName}`
    + `${m.className ? `  |  ${m.className}` : ''}  |  ${m.duration_minutes} minutes`, {
    x, y: 4.45, w, h: 0.3,
    fontSize: 12, color: cover === 'panel' ? 'F1F1F1' : hex(p.muted), fontFace: ctx.fonts.body,
  });
}

/** The coloured left third of a `split` cover, in inches. */
const SPLIT_W = 3.4;

/**
 * The title slide's background, per the theme's cover.
 *
 * Five different first pages rather than one page in five colours - which is
 * what the deck had while the theme was used only for its palette. Everything
 * stops short of the footer strip, so the school's name and crest on the master
 * stay visible on every cover.
 */
function coverBackground(ctx: Ctx, slide: PptxGenJS.Slide, p: Palette): void {
  const top = H - 0.5;
  switch (ctx.theme.cover) {
    case 'panel':
      slide.addShape('rect', { x: 0, y: 0, w: W, h: top, fill: { color: hex(p.accent) } });
      return;
    case 'band':
      slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.07, fill: { color: hex(p.accent) } });
      slide.addShape('rect', { x: 0, y: 1.3, w: W, h: 2.3, fill: { color: hex(p.accent) } });
      return;
    case 'split':
      slide.addShape('rect', { x: 0, y: 0, w: SPLIT_W, h: top, fill: { color: hex(p.accent) } });
      return;
    case 'orbit':
      slide.addShape('ellipse', {
        x: 6.4, y: -1.8, w: 4.8, h: 4.8,
        fill: { color: hex(p.accent2), transparency: 82 },
      });
      slide.addShape('ellipse', {
        x: 7.9, y: 2.6, w: 1.5, h: 1.5,
        line: { color: hex(p.accent), width: 4, transparency: 55 },
      });
      slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.07, fill: { color: hex(p.accent) } });
      return;
    case 'rule':
    default:
      slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.07, fill: { color: hex(p.accent) } });
  }
}

/**
 * How a content slide announces itself, per the theme's header.
 * `gradient` is the two-tone bar; `solid` a heavier one; `rule` and `underline`
 * have no top bar and mark the title instead (headerUnderTitle).
 */
function headerBar(ctx: Ctx, slide: PptxGenJS.Slide, p: Palette): void {
  switch (ctx.theme.head) {
    case 'solid':
      slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.16, fill: { color: hex(p.accent) } });
      return;
    case 'gradient':
      // A true gradient fill is not portable across PowerPoint, Keynote and
      // Google Slides; two tones read as one at this height.
      slide.addShape('rect', { x: 0, y: 0, w: W * 0.66, h: 0.08, fill: { color: hex(p.accent) } });
      slide.addShape('rect', { x: W * 0.66, y: 0, w: W * 0.34, h: 0.08, fill: { color: hex(p.accent2) } });
      return;
    default:
      return;
  }
}

function headerUnderTitle(ctx: Ctx, slide: PptxGenJS.Slide, p: Palette): void {
  if (ctx.theme.head === 'rule') {
    slide.addShape('line', {
      x: PAD, y: 1.4, w: W - PAD * 2, h: 0, line: { color: hex(p.line), width: 1.5 },
    });
  } else if (ctx.theme.head === 'underline') {
    slide.addShape('rect', { x: PAD, y: 1.38, w: 0.9, h: 0.06, fill: { color: hex(p.accent) } });
  }
}

/**
 * A boxed area, per the theme's card: tinted, outlined, or lifted with a shadow.
 * `leftbar` is tinted here and gets its bar from boxBar, because a text box has
 * one border and the bar is only on one side.
 */
function box(ctx: Ctx, p: Palette): Partial<PptxGenJS.TextPropsOptions> {
  switch (ctx.theme.card) {
    case 'outline':
      return { line: { color: hex(p.accent), width: 1.25 } };
    case 'shadow':
      return {
        fill: { color: hex(p.card) },
        shadow: { type: 'outer', blur: 6, offset: 2, angle: 90, color: '000000', opacity: 0.18 },
      };
    case 'leftbar':
    case 'tint':
    default:
      return { fill: { color: hex(p.tint) } };
  }
}

function boxBar(ctx: Ctx, slide: PptxGenJS.Slide, p: Palette, r: Rect): void {
  if (ctx.theme.card !== 'leftbar') return;
  slide.addShape('rect', { x: r.x - 0.07, y: r.y, w: 0.07, h: r.h, fill: { color: hex(p.accent) } });
}

function objectivesSlide(ctx: Ctx, slide: PptxGenJS.Slide, s: Slide, p: Palette): void {
  slide.addText(s.title || 'By the end of this lesson', {
    x: PAD, y: 0.64, w: W - PAD * 2, h: 0.6,
    fontSize: 28, bold: true, color: hex(p.ink), fontFace: ctx.fonts.display,
  });
  const runs = ctx.deck.objectives.flatMap(o => {
    const out: PptxGenJS.TextProps[] = [];
    if (o.ref) {
      out.push({ text: `${o.ref}  `, options: { bold: true, color: hex(p.mark), bullet: true } });
      out.push({ text: o.text, options: { breakLine: true } });
    } else {
      out.push({ text: o.text, options: { bullet: true, breakLine: true } });
    }
    return out;
  });
  slide.addText(runs.length ? runs : [{ text: 'No objectives were attached to this lesson.' }], {
    x: PAD, y: BODY_TOP, w: W - PAD * 2, h: BODY_H,
    fontSize: 16, color: hex(p.ink), fontFace: ctx.fonts.body, lineSpacingMultiple: 1.25,
    valign: 'top',
  });
}

function summarySlide(ctx: Ctx, slide: PptxGenJS.Slide, s: Slide, p: Palette): void {
  slide.addText(s.title || 'What we did', {
    x: PAD, y: 0.64, w: W - PAD * 2, h: 0.6,
    fontSize: 28, bold: true, color: hex(p.ink), fontFace: ctx.fonts.display,
  });
  slide.addText('What we did', {
    x: PAD, y: BODY_TOP, w: COL_W, h: 0.3,
    fontSize: 13, bold: true, color: hex(p.accent), fontFace: ctx.fonts.display,
  });
  slide.addText(ctx.deck.timing.map(t => ({
    text: `${t.minutes} min   ${t.label}`, options: { bullet: true, breakLine: true },
  })), {
    x: PAD, y: BODY_TOP + 0.35, w: COL_W, h: BODY_H - 0.35,
    fontSize: 13, color: hex(p.ink), fontFace: ctx.fonts.body, valign: 'top',
  });
  slide.addText('What you can now do', {
    x: PAD + COL_W + 0.3, y: BODY_TOP, w: COL_W, h: 0.3,
    fontSize: 13, bold: true, color: hex(p.accent), fontFace: ctx.fonts.display,
  });
  slide.addText(ctx.deck.objectives.map(o => ({
    text: o.text, options: { bullet: true, breakLine: true },
  })), {
    x: PAD + COL_W + 0.3, y: BODY_TOP + 0.35, w: COL_W, h: BODY_H - 0.35,
    fontSize: 13, color: hex(p.ink), fontFace: ctx.fonts.body, valign: 'top',
  });
}

/**
 * The answer to a worked example the class was asked to try.
 *
 * PowerPoint has no reveal that survives being edited, and animating one would
 * be the sort of decoration this feature is explicitly not for. A second slide
 * is what a teacher building this by hand would make, and it is a slide they can
 * skip, delete or move.
 */
function answerSlide(
  ctx: Ctx, s: Slide, prompt: string, answer: string, steps: string[], p: Palette,
): void {
  const slide = ctx.pptx.addSlide({ masterName: MASTER });
  slide.addShape('rect', {
    x: 0, y: 0, w: W, h: 0.07, fill: { color: hex(p.accent) },
  });
  slide.addText('ANSWER', {
    x: PAD, y: 0.3, w: 6, h: 0.26,
    fontSize: 10, bold: true, color: hex(p.accent), fontFace: ctx.fonts.display, charSpacing: 1.6,
  });
  slide.addText(prompt, {
    x: PAD, y: 0.64, w: W - PAD * 2, h: 0.7,
    fontSize: titleSize(prompt), bold: true, color: hex(p.ink), fontFace: ctx.fonts.display,
  });
  if (steps.length) {
    slide.addText(steps.map((t, i) => ({
      text: `${i + 1}.  ${t}`, options: { breakLine: true },
    })), {
      x: PAD, y: BODY_TOP, w: W - PAD * 2, h: BODY_H - 0.8,
      fontSize: 15, color: hex(p.ink), fontFace: ctx.fonts.body,
      lineSpacingMultiple: 1.2, valign: 'top',
    });
  }
  slide.addText(`Answer:  ${answer}`, {
    x: PAD, y: BODY_BOTTOM - 0.66, w: W - PAD * 2, h: 0.6,
    fontSize: 18, bold: true, color: 'FFFFFF', fontFace: ctx.fonts.body,
    fill: { color: hex(p.accent) }, align: 'center', valign: 'middle',
  });
  slide.addNotes(`The answer to the worked example on "${s.title}". Show it once the class has `
    + 'had a go, not before.');
}

// -------------------------------------------------------------------- blocks

function placeBlocks(ctx: Ctx, slide: PptxGenJS.Slide, s: Slide, p: Palette): void {
  const blocks = s.blocks;
  if (!blocks.length) return;

  const arrange = s.arrange ?? 'auto';

  if (blocks.length === 1) {
    // Centred and large: the same box, inset, so the one idea sits in the middle
    // of the slide rather than hanging from the title.
    const r = arrange === 'focus'
      ? { x: PAD + 0.8, y: BODY_TOP + 0.3, w: W - PAD * 2 - 1.6, h: BODY_H - 0.6 }
      : { x: PAD, y: BODY_TOP, w: W - PAD * 2, h: BODY_H };
    place(ctx, slide, blocks[0], r, p, s);
    return;
  }

  // Two blocks. Automatically, a picture goes on the left - the eye reads left
  // to right and the words are usually about the picture - and otherwise they
  // keep the order they were written in. (This used to swap two text blocks
  // whenever the first was not a picture, which put a question before the thing
  // it asked about.) A teacher's own arrangement keeps their order exactly.
  const [a, b] = blocks;
  const isVisual = (x: SlideBlock) => x.type === 'diagram' || x.type === 'chart' || x.type === 'image';
  const [first, second] = arrange === 'auto' && !isVisual(a) && isVisual(b) ? [b, a] : [a, b];

  if (arrange === 'stacked' || arrange === 'focus') {
    const gap = 0.2;
    const h = (BODY_H - gap) / 2;
    place(ctx, slide, first, { x: PAD, y: BODY_TOP, w: W - PAD * 2, h }, p, s);
    place(ctx, slide, second, { x: PAD, y: BODY_TOP + h + gap, w: W - PAD * 2, h }, p, s);
    return;
  }
  place(ctx, slide, first, { x: PAD, y: BODY_TOP, w: COL_W, h: BODY_H }, p, s);
  place(ctx, slide, second, { x: PAD + COL_W + 0.3, y: BODY_TOP, w: COL_W, h: BODY_H }, p, s);
}

function place(
  ctx: Ctx, slide: PptxGenJS.Slide, b: SlideBlock, r: Rect, p: Palette, s: Slide,
): void {
  const f = ctx.fonts;
  const body = (size: number, extra: Partial<PptxGenJS.TextPropsOptions> = {}) => ({
    x: r.x, y: r.y, w: r.w, h: r.h, fontSize: size, color: hex(p.ink),
    fontFace: f.body, valign: 'top' as const, ...extra,
  });

  switch (b.type) {
    case 'statement': {
      slide.addText(b.text, {
        x: r.x, y: r.y, w: r.w, h: r.h - (b.attribution ? 0.4 : 0),
        fontSize: b.text.length > 90 ? 22 : b.text.length > 50 ? 28 : 34,
        bold: true, color: hex(p.ink), fontFace: f.display, align: 'center', valign: 'middle',
      });
      if (b.attribution) {
        slide.addText(b.attribution, {
          x: r.x, y: r.y + r.h - 0.35, w: r.w, h: 0.3,
          fontSize: 11, color: hex(p.muted), fontFace: f.body, align: 'center',
        });
      }
      return;
    }

    case 'bullets': {
      let y = r.y;
      if (b.heading) {
        slide.addText(b.heading, {
          x: r.x, y, w: r.w, h: 0.32,
          fontSize: 15, bold: true, color: hex(p.accent), fontFace: f.display,
        });
        y += 0.4;
      }
      slide.addText(b.items.map(t => ({ text: t, options: { bullet: true, breakLine: true } })), {
        ...body(fitSize(b.items, r), { y, h: r.h - (y - r.y) }),
        lineSpacingMultiple: 1.25,
      });
      return;
    }

    case 'definition': {
      slide.addShape('rect', {
        x: r.x, y: r.y, w: 0.07, h: r.h, fill: { color: hex(p.accent) },
      });
      slide.addText(b.term, {
        x: r.x + 0.22, y: r.y + 0.05, w: r.w - 0.3, h: 0.5,
        fontSize: 26, bold: true, color: hex(p.accent), fontFace: f.display,
      });
      slide.addText(b.meaning, {
        x: r.x + 0.22, y: r.y + 0.62, w: r.w - 0.3, h: r.h - 1.1,
        fontSize: 16, color: hex(p.ink), fontFace: f.body, valign: 'top',
      });
      if (b.example) {
        slide.addText(`For example: ${b.example}`, {
          x: r.x + 0.22, y: r.y + r.h - 0.5, w: r.w - 0.3, h: 0.45,
          fontSize: 12, color: hex(p.muted), fontFace: f.body, italic: true,
        });
      }
      return;
    }

    case 'steps': {
      let y = r.y;
      if (b.heading) {
        slide.addText(b.heading, {
          x: r.x, y, w: r.w, h: 0.32,
          fontSize: 15, bold: true, color: hex(p.accent), fontFace: f.display,
        });
        y += 0.4;
      }
      slide.addText(b.steps.map((t, i) => ({
        text: `${i + 1}.  ${t}`, options: { breakLine: true },
      })), { ...body(fitSize(b.steps, r), { y, h: r.h - (y - r.y) }), lineSpacingMultiple: 1.3 });
      return;
    }

    case 'worked_example': {
      slide.addText(b.prompt, {
        x: r.x, y: r.y, w: r.w, h: 0.5,
        fontSize: 19, bold: true, color: hex(p.ink), fontFace: f.display,
      });
      const shown = b.reveal ? b.steps.slice(0, 1) : b.steps;
      slide.addText(shown.map((t, i) => ({
        text: `${i + 1}.  ${t}`, options: { breakLine: true },
      })), {
        x: r.x, y: r.y + 0.58, w: r.w, h: r.h - 1.2,
        fontSize: fitSize(shown, r), color: hex(p.ink), fontFace: f.body,
        lineSpacingMultiple: 1.3, valign: 'top',
      });
      slide.addText(b.reveal ? 'Try it. The answer is on the next slide.' : `Answer:  ${b.answer}`, {
        x: r.x, y: r.y + r.h - 0.52, w: r.w, h: 0.45,
        fontSize: 14, bold: !b.reveal, italic: b.reveal,
        color: b.reveal ? hex(p.muted) : 'FFFFFF',
        fill: b.reveal ? undefined : { color: hex(p.accent) },
        fontFace: f.body, align: 'center', valign: 'middle',
      });
      return;
    }

    case 'compare': {
      const n = b.columns.length;
      const gap = 0.18;
      const cw = (r.w - gap * (n - 1)) / n;
      b.columns.forEach((c, i) => {
        const x = r.x + i * (cw + gap);
        slide.addText(c.heading, {
          x, y: r.y, w: cw, h: 0.38,
          fontSize: 15, bold: true, color: 'FFFFFF', fontFace: f.display,
          fill: { color: hex(p.accent) }, align: 'center', valign: 'middle',
        });
        slide.addText(c.points.map(t => ({ text: t, options: { bullet: true, breakLine: true } })), {
          x, y: r.y + 0.46, w: cw, h: r.h - 0.46,
          fontSize: fitSize(c.points, { ...r, w: cw }), color: hex(p.ink), fontFace: f.body,
          valign: 'top', lineSpacingMultiple: 1.2,
        });
      });
      return;
    }

    case 'table': {
      const head = b.headers.length
        ? [b.headers.map(h => ({
          text: h,
          options: { bold: true, color: 'FFFFFF', fill: { color: hex(p.accent) } },
        }))]
        : [];
      const rows = b.rows.map(row => row.cells.map(c => ({ text: c })));
      slide.addTable([...head, ...rows] as PptxGenJS.TableRow[], {
        x: r.x, y: r.y, w: r.w,
        fontSize: rows.length > 5 ? 11 : 13, fontFace: f.body, color: hex(p.ink),
        border: { type: 'solid', color: hex(p.line), pt: 0.5 },
        autoPage: false, valign: 'middle',
      });
      if (b.note) {
        slide.addText(b.note, {
          x: r.x, y: r.y + r.h - 0.3, w: r.w, h: 0.28,
          fontSize: 10, color: hex(p.muted), fontFace: f.body,
        });
      }
      return;
    }

    case 'code': {
      slide.addText(b.lines.join('\n'), {
        x: r.x, y: r.y, w: r.w, h: r.h - (b.caption ? 0.32 : 0),
        fontSize: b.lines.length > 9 ? 12 : 15, fontFace: f.mono, color: 'F4F6F3',
        fill: { color: hex(p.ink) }, valign: 'top', margin: 10,
      });
      if (b.caption) {
        slide.addText(b.caption, {
          x: r.x, y: r.y + r.h - 0.3, w: r.w, h: 0.28,
          fontSize: 10, color: hex(p.muted), fontFace: f.body,
        });
      }
      return;
    }

    case 'diagram':
    case 'chart': {
      const img = ctx.images.get(svgKey(s.id, b));
      const caption = b.type === 'diagram' ? b.caption : b.note;
      // The same rule the HTML follows: a drawing titled the same as the slide
      // is a heading printed twice, and on a slide that is a fifth of the room.
      const title = sameAs(b.title, s.title) ? null : b.title;
      let top = r.y;
      if (title) {
        slide.addText(title, {
          x: r.x, y: top, w: r.w, h: 0.32,
          fontSize: 14, bold: true, color: hex(p.accent), fontFace: f.display,
        });
        top += 0.38;
      }
      const room = r.h - (top - r.y) - (caption ? 0.34 : 0);

      if (img) {
        // Fit inside the box, keeping the drawing's own proportions.
        const boxRatio = r.w / room;
        const w = img.ratio >= boxRatio ? r.w : room * img.ratio;
        const h = img.ratio >= boxRatio ? r.w / img.ratio : room;
        slide.addImage({
          data: img.data,
          x: r.x + (r.w - w) / 2, y: top + (room - h) / 2, w, h,
        });
      } else {
        // The fallback: the labels, as text. A slide with the words beats a hole.
        const labels = b.type === 'diagram'
          ? b.nodes.map(n => n.label).concat(b.parts.map(x => x.label))
          : b.series.map(x => `${x.label}: ${x.value}`);
        slide.addText(labels.filter(Boolean).map(t => ({
          text: t, options: { bullet: true, breakLine: true },
        })), {
          x: r.x, y: top, w: r.w, h: room,
          fontSize: 15, color: hex(p.ink), fontFace: f.body, valign: 'top',
        });
      }
      if (caption) {
        slide.addText(caption, {
          x: r.x, y: r.y + r.h - 0.3, w: r.w, h: 0.28,
          fontSize: 10, color: hex(p.muted), fontFace: f.body,
        });
      }
      return;
    }

    case 'image': {
      const data = ctx.assets[b.asset_id];
      if (!data) return;
      const room = r.h - (b.caption ? 0.34 : 0);
      slide.addImage({
        data, x: r.x, y: r.y, w: r.w, h: room,
        sizing: { type: 'contain', w: r.w, h: room },
        altText: b.alt,
      });
      if (b.caption) {
        slide.addText(b.caption, {
          x: r.x, y: r.y + r.h - 0.3, w: r.w, h: 0.28,
          fontSize: 10, color: hex(p.muted), fontFace: f.body,
        });
      }
      return;
    }

    case 'question': {
      slide.addText(b.question, {
        x: r.x, y: r.y, w: r.w, h: r.h - 0.4,
        fontSize: b.question.length > 110 ? 20 : 26, bold: true,
        color: hex(p.ink), fontFace: f.display, valign: 'middle',
      });
      if (b.prompt) {
        slide.addText(b.prompt, {
          x: r.x, y: r.y + r.h - 0.38, w: r.w, h: 0.34,
          fontSize: 12, color: hex(p.muted), fontFace: f.body,
        });
      }
      return;
    }

    case 'mcq': {
      const letters = 'ABCDE';
      slide.addText(b.question, {
        x: r.x, y: r.y, w: r.w, h: 0.62,
        fontSize: 20, bold: true, color: hex(p.ink), fontFace: f.display, valign: 'top',
      });
      const top = r.y + 0.72;
      const room = r.h - 0.72;
      const rowH = Math.min(0.6, room / Math.max(1, b.options.length));
      b.options.forEach((o, i) => {
        const y = top + i * rowH;
        slide.addText(`${letters[i] ?? '?'}`, {
          x: r.x, y, w: 0.34, h: rowH - 0.06,
          fontSize: 13, bold: true, color: 'FFFFFF', fontFace: f.body,
          fill: { color: hex(p.accent) }, align: 'center', valign: 'middle',
        });
        slide.addText(o, {
          x: r.x + 0.42, y, w: r.w - 0.42, h: rowH - 0.06,
          fontSize: 15, color: hex(p.ink), fontFace: f.body, valign: 'middle',
        });
      });
      return;
    }

    case 'true_false': {
      slide.addText('True or false?', {
        x: r.x, y: r.y, w: r.w, h: 0.32,
        fontSize: 13, bold: true, color: hex(p.accent), fontFace: f.display,
      });
      slide.addText(b.statements.map((st, i) => ({
        text: `${i + 1}.  ${st.text}`, options: { breakLine: true },
      })), {
        ...body(17, { y: r.y + 0.42, h: r.h - 0.42 }), lineSpacingMultiple: 1.4,
      });
      return;
    }

    case 'predict': {
      if (b.setup) {
        slide.addText(b.setup, {
          x: r.x, y: r.y, w: r.w, h: 0.8,
          fontSize: 15, color: hex(p.ink), fontFace: f.body,
          ...box(ctx, p), valign: 'middle', margin: 8,
        });
        boxBar(ctx, slide, p, { x: r.x, y: r.y, w: r.w, h: 0.8 });
      }
      slide.addText(b.question, {
        x: r.x, y: r.y + (b.setup ? 0.95 : 0), w: r.w, h: r.h - (b.setup ? 1.35 : 0.4),
        fontSize: 24, bold: true, color: hex(p.ink), fontFace: f.display, valign: 'middle',
      });
      slide.addText('Decide before we find out.', {
        x: r.x, y: r.y + r.h - 0.34, w: r.w, h: 0.3,
        fontSize: 12, color: hex(p.muted), fontFace: f.body, italic: true,
      });
      return;
    }

    case 'sort': {
      slide.addText(b.instruction, {
        x: r.x, y: r.y, w: r.w, h: 0.44,
        fontSize: 19, bold: true, color: hex(p.ink), fontFace: f.display,
      });
      const n = b.categories.length;
      const gap = 0.18;
      const cw = (r.w - gap * (n - 1)) / n;
      b.categories.forEach((c, i) => {
        slide.addText(c, {
          x: r.x + i * (cw + gap), y: r.y + 0.56, w: cw, h: 0.5,
          fontSize: 13, bold: true, color: hex(p.accent), fontFace: f.body,
          align: 'center', valign: 'middle',
          line: { color: hex(p.accent), width: 1.25, dashType: 'dash' },
        });
      });
      slide.addText(b.items.map(i => ({ text: i.text, options: { bullet: true, breakLine: true } })), {
        x: r.x, y: r.y + 1.2, w: r.w, h: r.h - 1.2,
        fontSize: 14, color: hex(p.ink), fontFace: f.body, valign: 'top',
      });
      return;
    }

    case 'error_spot': {
      slide.addText(b.instruction, {
        x: r.x, y: r.y, w: r.w, h: 0.44,
        fontSize: 19, bold: true, color: hex(p.ink), fontFace: f.display,
      });
      slide.addText(b.work.map((l, i) => ({
        text: `${i + 1}.  ${l}`, options: { breakLine: true },
      })), {
        x: r.x, y: r.y + 0.56, w: r.w, h: r.h - 0.56,
        fontSize: 15, fontFace: f.mono, color: hex(p.ink),
        ...box(ctx, p), valign: 'top', margin: 10,
      });
      boxBar(ctx, slide, p, { x: r.x, y: r.y + 0.56, w: r.w, h: r.h - 0.56 });
      return;
    }

    case 'scenario': {
      slide.addText(b.context, {
        x: r.x, y: r.y, w: r.w, h: Math.min(1.5, r.h * 0.42),
        fontSize: 14, color: hex(p.ink), fontFace: f.body,
        ...box(ctx, p), valign: 'top', margin: 10,
      });
      boxBar(ctx, slide, p, { x: r.x, y: r.y, w: r.w, h: Math.min(1.5, r.h * 0.42) });
      const top = r.y + Math.min(1.5, r.h * 0.42) + 0.16;
      slide.addText(b.task, {
        x: r.x, y: top, w: r.w, h: 0.5,
        fontSize: 19, bold: true, color: hex(p.ink), fontFace: f.display,
      });
      if (b.prompts.length) {
        slide.addText(b.prompts.map(t => ({ text: t, options: { bullet: true, breakLine: true } })), {
          x: r.x, y: top + 0.58, w: r.w, h: r.h - (top - r.y) - 0.58,
          fontSize: 14, color: hex(p.ink), fontFace: f.body, valign: 'top',
        });
      }
      return;
    }

    case 'discuss': {
      const how: Record<string, string> = {
        think_pair_share: 'Think on your own, then talk to the person beside you, then we share',
        pairs: 'In pairs', groups: 'In your groups', whole_class: 'All together',
      };
      slide.addText(b.prompt, {
        x: r.x, y: r.y, w: r.w, h: r.h - 0.5,
        fontSize: 26, bold: true, color: hex(p.ink), fontFace: f.display,
        align: 'center', valign: 'middle',
      });
      slide.addText(`${how[b.structure] ?? 'Talk about it'}  -  ${b.minutes} minutes`, {
        x: r.x, y: r.y + r.h - 0.46, w: r.w, h: 0.4,
        fontSize: 13, color: 'FFFFFF', fontFace: f.body, align: 'center', valign: 'middle',
        fill: { color: hex(p.accent) },
      });
      return;
    }

    case 'task': {
      slide.addText(b.instruction, {
        x: r.x, y: r.y, w: r.w, h: 0.46,
        fontSize: 19, bold: true, color: hex(p.ink), fontFace: f.display,
      });
      slide.addText(b.questions.map((q, i) => ({
        text: `${i + 1}.  ${q.text}${q.marks ? `   [${q.marks}]` : ''}`,
        options: { breakLine: true },
      })), {
        x: r.x, y: r.y + 0.58, w: r.w, h: r.h - (b.extension ? 1.0 : 0.58),
        fontSize: fitSize(b.questions.map(q => q.text), r), color: hex(p.ink),
        fontFace: f.body, lineSpacingMultiple: 1.3, valign: 'top',
      });
      if (b.extension) {
        slide.addText(`Finished? ${b.extension}`, {
          x: r.x, y: r.y + r.h - 0.42, w: r.w, h: 0.38,
          fontSize: 12, color: hex(p.muted), fontFace: f.body, italic: true,
        });
      }
      return;
    }

    case 'exit_ticket': {
      slide.addText('BEFORE YOU GO', {
        x: r.x, y: r.y, w: r.w, h: 0.3,
        fontSize: 11, bold: true, color: hex(p.accent), fontFace: f.display, charSpacing: 1.6,
      });
      slide.addText(b.question, {
        x: r.x, y: r.y + 0.4, w: r.w, h: r.h - 0.4 - (b.success_criteria.length ? 1.1 : 0),
        fontSize: 26, bold: true, color: hex(p.ink), fontFace: f.display, valign: 'middle',
      });
      if (b.success_criteria.length) {
        slide.addText(b.success_criteria.map(t => ({
          text: t, options: { bullet: true, breakLine: true },
        })), {
          x: r.x, y: r.y + r.h - 1.05, w: r.w, h: 1.0,
          fontSize: 13, color: hex(p.muted), fontFace: f.body, valign: 'top',
        });
      }
      return;
    }

    default:
      return;
  }
}

/**
 * A font size that will fit.
 *
 * PowerPoint does not shrink text to fit a box without being told to, and an
 * autoFit hint is honoured inconsistently across PowerPoint, Keynote and Google
 * Slides. Estimating from the amount of text is cruder and works everywhere.
 */
function fitSize(items: string[], r: Rect): number {
  const chars = items.reduce((n, t) => n + String(t ?? '').length, 0);
  const area = r.w * r.h;
  const density = chars / Math.max(0.5, area);
  if (density > 120) return 12;
  if (density > 80) return 14;
  if (density > 50) return 16;
  return 18;
}

// --------------------------------------------------------------------- notes

/**
 * The teaching guide, in the notes pane.
 *
 * Plain text with headings, because the notes pane is read on a presenter
 * display at a glance while a class waits. Structure it too cleverly and it
 * becomes something to parse rather than something to read.
 */
export function speakerNotes(deck: LessonDeck, s: Slide, index: number, total: number): string {
  const t = s.teacher;
  const out: string[] = [];

  out.push(`${PHASE_LABEL[s.phase].toUpperCase()}  -  ${s.minutes} min  -  slide ${index + 1} of ${total}`);
  out.push(s.audience === 'student_facing'
    ? 'THE CLASS WORKS ON THIS SLIDE.' : 'You explain on this slide.');
  out.push('');

  if (s.purpose) out.push(`WHY THIS SLIDE\n${s.purpose}`);
  if (t.intention && t.intention !== s.purpose) out.push(`\nTEACHING INTENTION\n${t.intention}`);
  if (t.say) out.push(`\nYOU MIGHT SAY\n${t.say}`);
  if (t.expect) out.push(`\nLISTEN FOR\n${t.expect}`);

  const answers = revealables(s);
  if (answers.length) {
    out.push('\nANSWERS');
    for (const a of answers) {
      out.push(`  Q: ${a.q}`);
      out.push(`  A: ${a.a}`);
      if (a.why) out.push(`  Watch for: ${a.why}`);
    }
  }

  if (t.misconceptions.length) {
    out.push('\nMISCONCEPTIONS TO WATCH FOR');
    for (const m of t.misconceptions) out.push(`  - ${m}`);
  }
  if (t.follow_up) out.push(`\nIF THEY HAVE IT\n${t.follow_up}`);
  if (t.timing_note) out.push(`\nSHORT OF TIME\n${t.timing_note}`);

  const objectives = s.objective_indexes
    .map(i => deck.objectives[i])
    .filter(Boolean)
    .map(o => `  ${o.ref ? `${o.ref} - ` : ''}${o.text}`);
  if (objectives.length) out.push(`\nOBJECTIVES\n${objectives.join('\n')}`);

  return out.join('\n');
}
