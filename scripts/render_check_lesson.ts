/**
 * Build a lesson end to end and write it to disk, without a browser session.
 *
 * There is no test runner in this repository, and this is what stands in for one
 * on the part of the feature that most needs looking at: what actually comes out.
 * It runs the real pipeline - the real blueprint, the real outline and fill
 * passes (on MOCK_LLM fixtures), the real deterministic repair, the real quality
 * gate, the real HTML renderer and the real PowerPoint exporter - and leaves
 * three files you can open.
 *
 *   npm run check:lesson
 *
 * It runs three contrasting cases on purpose, because the failures worth
 * catching are the ones where a rule holds for one class and not another: a CP2
 * mathematics lesson in forty minutes, an LS2 science lesson in sixty, and an
 * IGCSE ICT lesson in eighty. Different age caps, different subject profiles,
 * different phase budgets, different block vocabularies.
 *
 * MOCK_LLM still meters, by design (lib/llm.ts), so this needs the Supabase
 * credentials in .env.local and writes ai_usage rows exactly as a real run
 * would. That is the point: the ledger is the one thing that must never be
 * exercised only in production.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bandFor } from '@/lib/lesson/ages';
import { profileFor } from '@/lib/lesson/profiles';
import { approachFrom, blueprint, timingLine } from '@/lib/lesson/architecture';
import { generateLesson, type GenerateLessonInput } from '@/lib/lesson/generate';
import { checkDeck } from '@/lib/lesson/gate';
import { renderDeckHtml, renderSlideHtml } from '@/lib/lesson/render_html';
import { buildPptx } from '@/lib/lesson/pptx';
import { hasStudentBlock, hasVisualBlock, slideWords } from '@/lib/lesson/repair';
import type { PackObjective } from '@/lib/studypack/schema';
import { THEMES } from '@/lib/studypack/themes';

const OUT = join(process.cwd(), '.render-check');

interface Case {
  name: string;
  input: GenerateLessonInput;
}

function objectives(list: [string, string][]): PackObjective[] {
  return list.map(([ref, text]) => ({ ref, text, source: 'registry' as const }));
}

const CASES: Case[] = [
  {
    name: 'cp2-maths-40',
    input: {
      subjectId: 'mathematics', subjectName: 'Mathematics',
      yearGroup: 'CP2', className: 'CP2A', academicYear: '2026-27',
      semester: 1, weekNumber: 4,
      topic: 'Adding two-digit numbers', subtopic: 'Bridging through ten',
      durationMinutes: 40, approach: 'Direct teaching of something new',
      keyQuestion: 'What do we do when the ones add up to more than ten?',
      priorKnowledge: 'They can add within twenty and know their number bonds to ten.',
      context: 'Thirty-four in the class, one chalkboard, no tablets.',
      objectives: objectives([
        ['2Np.02', 'Add two two-digit numbers, bridging through ten'],
        ['2Np.04', 'Explain a method of addition using place value'],
      ]),
      curriculum: 'Cambridge Primary Mathematics',
      sourceText: null, activities: null,
      workKey: 'lesson|mathematics|CP2|2026-27|W4|2Np.02,2Np.04|40m',
    },
  },
  {
    name: 'ls2-science-60',
    input: {
      subjectId: 'science', subjectName: 'Science',
      yearGroup: 'LS2', className: 'LS2B', academicYear: '2026-27',
      semester: 1, weekNumber: 7,
      topic: 'The water cycle', subtopic: null,
      durationMinutes: 60, approach: 'Discovery and enquiry',
      keyQuestion: 'Where does the water in a cloud come from?',
      priorKnowledge: 'They know the three states of matter.',
      context: null,
      objectives: objectives([
        ['8Es.01', 'Describe the processes of the water cycle'],
        ['8Es.02', 'Explain the role of energy from the Sun in evaporation'],
        ['8Es.03', 'Interpret a diagram of the water cycle'],
      ]),
      curriculum: 'Cambridge Lower Secondary Science',
      sourceText: null, activities: null,
      workKey: 'lesson|science|LS2|2026-27|W7|8Es.01,8Es.02,8Es.03|60m',
    },
  },
  {
    name: 'igcse-ict-80',
    input: {
      subjectId: 'ict', subjectName: 'Information and Communication Technology',
      yearGroup: 'IGCSE 1', className: 'IG1 ICT', academicYear: '2026-27',
      semester: 2, weekNumber: 3,
      topic: 'Validation and verification', subtopic: 'Choosing the right check',
      durationMinutes: 80, approach: 'A balance of teaching and practice',
      keyQuestion: 'Why does a valid entry still need verifying?',
      priorKnowledge: 'They have built a data entry form in a spreadsheet.',
      context: 'Computer room, one machine each.',
      objectives: objectives([
        ['0417.2.1', 'Describe validation checks and their purpose'],
        ['0417.2.2', 'Distinguish between validation and verification'],
        ['0417.2.3', 'Select appropriate validation checks for given data'],
      ]),
      curriculum: 'Cambridge IGCSE ICT 0417',
      sourceText: null, activities: null,
      workKey: 'lesson|ict|IGCSE 1|2026-27|W3|0417.2.1,0417.2.2,0417.2.3|80m',
    },
  },
];

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  let failures = 0;

  for (const c of CASES) {
    const band = bandFor(c.input.yearGroup);
    const profile = profileFor(c.input.subjectId, c.input.subjectName);
    const plan = blueprint({
      durationMinutes: c.input.durationMinutes,
      band,
      approach: approachFrom(c.input.approach),
      objectiveCount: c.input.objectives.length,
    });

    console.log(`\n=== ${c.name} ===`);
    console.log(`  ${band.name} / ${profile.name}`);
    console.log(`  plan: ${plan.slideBudget} slides, ${plan.minStudentSlides}+ student-facing, `
      + `${plan.objectiveBudget} of ${c.input.objectives.length} objectives`);
    console.log(`  timing: ${timingLine(plan.phases)}`);

    const planned = plan.phases.reduce((n, p) => n + p.minutes, 0);
    if (planned !== c.input.durationMinutes) {
      console.error(`  FAIL: the phase plan sums to ${planned} of ${c.input.durationMinutes} minutes`);
      failures++;
    }

    // No signed-in teacher here: ai_usage.user_id has a foreign key, and a made-up
    // uuid makes every metering insert fail loudly for no reason. Null is what a
    // call with no attributable user is already spelled as (lib/llm.ts, meter).
    const out = await generateLesson(c.input, null);
    const deck = out.deck;

    console.log(`  built: ${deck.slides.length} slides in ${out.calls} model call(s)`);
    console.log(`  repair: ${out.report.droppedSlides} slide(s) dropped, `
      + `${out.report.droppedBlocks} block(s) dropped, ${out.report.trimmedSlides} trimmed, `
      + `${out.report.minutesAdjusted} minute(s) moved`);

    // ---- the assertions that matter
    const total = deck.slides.reduce((n, s) => n + s.minutes, 0);
    check(total === c.input.durationMinutes,
      `the slides sum to ${total} of ${c.input.durationMinutes} minutes`);

    const over = deck.slides.filter(s => slideWords(s) > band.maxWordsPerSlide);
    check(!over.length,
      `${over.length} slide(s) over the ${band.maxWordsPerSlide}-word cap for ${band.name}: `
      + over.map(s => `${s.id} (${slideWords(s)})`).join(', '));

    const crowded = deck.slides.filter(s => s.blocks.length > band.maxBlocksPerSlide);
    check(!crowded.length, `${crowded.length} slide(s) over ${band.maxBlocksPerSlide} block(s)`);

    const student = deck.slides.filter(hasStudentBlock).length;
    check(student >= 2, `only ${student} student-facing slide(s)`);

    const visual = deck.slides.filter(hasVisualBlock).length;
    check(visual >= 1, 'no slide shows anything');

    const noPurpose = deck.slides.filter(s => s.purpose.split(/\s+/).filter(Boolean).length < 4);
    check(!noPurpose.length,
      `${noPurpose.length} slide(s) do not say why they exist: ${noPurpose.map(s => s.id).join(', ')}`);

    const allowedKinds = new Set(profile.diagrams);
    const wrongKind = deck.slides.flatMap(s => s.blocks)
      .filter(b => b.type === 'diagram' && !allowedKinds.has(b.kind));
    check(!wrongKind.length,
      `${wrongKind.length} diagram(s) of a kind this subject was never offered`);

    // ---- the gate
    const gate = checkDeck(deck, band);
    console.log(`  gate: ${gate.passed} passed, ${gate.warnings} warning(s), ${gate.blocking} blocking`);
    for (const g of gate.checks.filter(x => x.status !== 'pass')) {
      console.log(`    ${g.status.toUpperCase()}  ${g.title} - ${g.detail}`);
    }

    // ---- the renderings
    const html = renderDeckHtml(deck, {});
    writeFileSync(join(OUT, `lesson-${c.name}.html`), html, 'utf8');
    check(html.includes('<svg'), 'the deck has no drawn diagram in it');
    check(!/undefined|\[object Object\]|NaN/.test(html), 'the HTML contains undefined, NaN or [object Object]');

    const { bytes, notes } = await buildPptx(deck, {});
    writeFileSync(join(OUT, `lesson-${c.name}.pptx`), bytes);
    check(bytes.length > 10_000, `the PowerPoint is only ${bytes.length} bytes`);
    check(bytes[0] === 0x50 && bytes[1] === 0x4B, 'the PowerPoint is not a zip');
    if (notes.length) console.log(`  render notes: ${notes.join(' ')}`);

    // The teaching guide is the reason the export matters, and it is invisible
    // from the slides themselves - so it is checked in the file. One notes part
    // per slide, each carrying more than a slide number.
    const pptx = await inspectPptx(bytes);
    check(pptx.slides >= deck.slides.length,
      `${pptx.slides} slide parts for ${deck.slides.length} slides`);
    check(pptx.notes === pptx.slides,
      `${pptx.notes} notes part(s) for ${pptx.slides} slide(s)`);
    check(!pptx.emptyNotes,
      `${pptx.emptyNotes} slide(s) went out with no teaching note in the notes pane`);
    const drawn = deck.slides.flatMap(s => s.blocks)
      .filter(b => b.type === 'diagram' || b.type === 'chart').length;
    check(pptx.media >= drawn,
      `${drawn} drawing(s) in the deck but only ${pptx.media} image(s) in the PowerPoint`);
    console.log(`  pptx: ${pptx.slides} slides, ${pptx.notes} notes parts `
      + `(${pptx.shortestNote}-${pptx.longestNote} chars), ${pptx.media} embedded image(s)`);

    console.log(`  wrote .render-check/lesson-${c.name}.html and .pptx (${Math.round(bytes.length / 1024)} KB)`);

    function check(ok: boolean, message: string): void {
      if (!ok) { console.error(`  FAIL: ${message}`); failures++; }
    }
  }

  // ---- every theme, on one deck
  //
  // A theme is a composition - cover, header, card - and not only a palette, so
  // each one is rendered and each PowerPoint is opened back up. A cover that draws
  // text on its own accent colour is the kind of thing that shows up in one of
  // the eight and not the other seven.
  console.log('\n=== themes ===');
  const base = (await generateLesson(CASES[1].input, null)).deck;
  for (const t of THEMES) {
    const deck = { ...base, theme: t.id };
    writeFileSync(join(OUT, `lesson-theme-${t.id}.html`), renderDeckHtml(deck, {}), 'utf8');
    const { bytes } = await buildPptx(deck, {});
    writeFileSync(join(OUT, `lesson-theme-${t.id}.pptx`), bytes);
    const p = await inspectPptx(bytes);
    const ok = p.slides >= deck.slides.length && !p.emptyNotes && bytes[0] === 0x50;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${t.id.padEnd(15)} cover=${t.cover.padEnd(6)} `
      + `head=${t.head.padEnd(9)} card=${t.card.padEnd(8)} ${Math.round(bytes.length / 1024)} KB`);
  }

  // ---- the personal-data check
  //
  // Both ways it used to be wrong: an ICT lesson on validating email addresses
  // could never be approved, and "Dear Mary" - capitalised, as anyone writes it -
  // was never caught.
  console.log('\n=== personal data ===');
  const probe = (text: string) => {
    const deck = JSON.parse(JSON.stringify(base)) as typeof base;
    const target = deck.slides.find(s => s.blocks.length)!;
    target.blocks = [{ type: 'statement', text, attribution: null }];
    const g = checkDeck(deck, bandFor(deck.meta.yearGroup));
    const status = (id: string) => g.checks.find(c => c.id === id)?.status;
    return { addresses: status('no_addresses'), names: status('no_names') };
  };
  const cases: [string, 'pass' | 'warn' | 'block', 'pass' | 'warn' | 'block'][] = [
    ['A valid address looks like user@example.com', 'pass', 'pass'],
    ['Test with test.user@school.test and admin@example.org', 'pass', 'pass'],
    ['Email jane.banda@gmail.com for help', 'block', 'pass'],
    ['Write to head@lusakaoaktree.school', 'block', 'pass'],
    ['Dear Mary, thank you for the book', 'pass', 'warn'],
    ['Hello World is the first program', 'pass', 'pass'],
    ['Dear Sir or Madam, I am writing to', 'pass', 'pass'],
    ['Hello class, today we start', 'pass', 'pass'],
    ['Dear Mr Banda, I am writing to', 'pass', 'warn'],
  ];
  for (const [text, addr, name] of cases) {
    const got = probe(text);
    const ok = got.addresses === addr && got.names === name;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} "${text}" -> addresses ${got.addresses}, names ${got.names}`
      + (ok ? '' : ` (wanted ${addr}/${name})`));
  }

  // ---- revealing an answer on the slide
  //
  // The answer is in the slide's markup but hidden, shows only when the slide is
  // revealed, and never prints. And the "spot the mistake" line must not be
  // highlighted before the reveal - that was giving the answer away.
  console.log('\n=== reveal ===');
  {
    const deck = JSON.parse(JSON.stringify(base)) as typeof base;
    const target = deck.slides.find(s => s.blocks.length)!;
    target.blocks = [{
      type: 'mcq', question: 'Which is right?', options: ['Right', 'Wrong'], correct: 0,
      why_wrong: ['', 'They added instead of multiplying.'], explain: 'Because.',
    }];
    const i = deck.slides.indexOf(target);
    const hidden = renderSlideHtml(deck, target, i, deck.slides.length, {});
    const shown = renderSlideHtml(deck, target, i, deck.slides.length, { revealed: true });
    const whole = renderDeckHtml(deck, {});
    const checks: [string, boolean][] = [
      ['answer markup present but hidden', hidden.includes('class="rv"') && /\.rv\{display:none;\}/.test(hidden)
        && !/<article class="slide [^"]*revealed/.test(hidden)],
      ['revealed slide carries the revealed class', /<article class="slide [^"]*revealed/.test(shown)],
      ['correct option marked', hidden.includes('<li class="ok">')],
      ['print never shows answers', /@media print\{[\s\S]*\.rv\{display:none !important;\}|\.rvbtn,\.rv\{display:none !important;\}/.test(whole)],
      ['deck opens with notes hidden', /<body class="">/.test(whole)],
      ['deck has a per-slide reveal button', whole.includes('class="rvbtn"')],
      ['wrong line not highlighted unrevealed', !/(^|[^.revealed ])\.work li\.wrongline\{/.test(whole)
        && whole.includes('.slide.revealed .work li.wrongline')],
    ];
    for (const [what, ok] of checks) {
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    }
  }

  // ---- the teacher's arrangement, on a two-block slide
  //
  // Primary slides hold one block, so the editor cannot show side-by-side or
  // stacked there; this puts a question beside a diagram on a lower-secondary
  // deck and renders each arrangement both ways. It also pins the ordering fix:
  // two text blocks used to be swapped in the PowerPoint whenever the first was
  // not a picture.
  console.log('\n=== arrangements ===');
  for (const arrange of ['auto', 'side', 'stacked', 'focus'] as const) {
    const deck = JSON.parse(JSON.stringify(base)) as typeof base;
    const target = deck.slides.find(s => s.blocks.length === 1 && s.blocks[0].type !== 'diagram')!;
    target.blocks = [
      { type: 'bullets', heading: 'First', items: ['The first block'] },
      { type: 'question', question: 'The second block?', prompt: null, answer: 'Yes', misconception: null },
    ];
    target.arrange = arrange;
    const html = renderDeckHtml(deck, {});
    // The slide's own class attribute, not the whole document: the stylesheet
    // contains every ar-* name, so searching the page proves nothing.
    const slideClasses = [...html.matchAll(/<article class="slide ([^"]+)"/g)].map(m => m[1]).join(' ');
    const cls = arrange === 'auto'
      ? !/\bar-(side|stacked|focus)\b/.test(slideClasses)
      : slideClasses.includes(`ar-${arrange}`);
    const { bytes } = await buildPptx(deck, {});
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(Buffer.from(bytes));
    const n = deck.slides.indexOf(target) + 1;
    const xml = await zip.files[`ppt/slides/slide${n}.xml`].async('string');
    // Text order in the file is drawing order: "The first block" must come first.
    const ordered = xml.indexOf('The first block') > -1
      && xml.indexOf('The first block') < xml.indexOf('The second block?');
    const ok = cls && ordered;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${arrange.padEnd(8)} html class ${cls ? 'ok' : 'MISSING'}, `
      + `pptx order ${ordered ? 'kept' : 'SWAPPED'}`);
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

/**
 * Read the finished .pptx back as a zip.
 *
 * Checking the object we handed to pptxgenjs proves nothing about the file that
 * came out of it. This opens the actual package - which is how it was found that
 * `addNotes` was working all along and the first attempt at reading the notes
 * back was matching `<a:t>(.*?)</a:t>` against text that spans lines.
 */
async function inspectPptx(bytes: Uint8Array): Promise<{
  slides: number; notes: number; media: number;
  emptyNotes: number; shortestNote: number; longestNote: number;
}> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(Buffer.from(bytes));
  const names = Object.keys(zip.files);

  const slides = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const notes = names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const media = names.filter(n => /^ppt\/media\/\S+\.(png|jpe?g)$/i.test(n));

  let emptyNotes = 0;
  let shortest = Number.POSITIVE_INFINITY;
  let longest = 0;
  for (const n of notes) {
    const xml = await zip.files[n].async('string');
    // [\s\S] rather than . - the notes are several lines long.
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1]).join(' ');
    // A notes part with nothing but the slide number is an empty note.
    if (text.trim().length < 40) emptyNotes++;
    shortest = Math.min(shortest, text.length);
    longest = Math.max(longest, text.length);
  }

  return {
    slides: slides.length, notes: notes.length, media: media.length,
    emptyNotes,
    shortestNote: Number.isFinite(shortest) ? shortest : 0,
    longestNote: longest,
  };
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
