/**
 * One run against the real model.
 *
 *   npm run check:lesson:live
 *
 * Everything else about the Lesson Maker is checked on MOCK_LLM fixtures, which
 * prove the plumbing and prove nothing about what a real model writes. This
 * spends real money (a few US cents per lesson, metered in ai_usage like every
 * other call) to find out: whether the strict schemas are accepted, how many
 * calls a lesson really takes, whether the prompt cache is hit, whether the
 * gate passes real output, and - by reading it - whether the lessons are any
 * good.
 *
 * It calls the same library functions the routes do, in the same order, and
 * saves the lessons as drafts under the demo account so they can be opened in
 * the real editor. It clears MOCK_CLAUDE and MOCK_LLM itself (see run()), because
 * .env.local holds MOCK_CLAUDE="1" for everything else.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admin } from '@/lib/supabase';
import { activeProvider, TIER } from '@/lib/llm';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';
import { bandFor } from '@/lib/lesson/ages';
import { profileFor } from '@/lib/lesson/profiles';
import { buildContext, YEAR, type LessonAsk } from '@/lib/lesson/context';
import { lessonWorkKey } from '@/lib/lesson/match';
import {
  generateLesson, repairLessonSlides, type GenerateLessonInput,
} from '@/lib/lesson/generate';
import { allowedFor, checkDeck, repairRequests, type GateResult } from '@/lib/lesson/gate';
import { improveSlide } from '@/lib/lesson/improve';
import { insertLesson, snapshot } from '@/lib/lesson/persist';
import { renderDeckHtml } from '@/lib/lesson/render_html';
import { buildPptx } from '@/lib/lesson/pptx';
import { slideWords } from '@/lib/lesson/repair';
import type { LessonDeck } from '@/lib/lesson/schema';

const OUT = join(process.cwd(), '.render-check');

interface Usage { input: number; cached: number; output: number; cost: number; ms: number; calls: number }
const total: Usage = { input: 0, cached: 0, output: 0, cost: 0, ms: 0, calls: 0 };

function add(u: Partial<Usage> | null | undefined, calls = 1) {
  if (!u) return;
  total.input += u.input ?? 0; total.cached += u.cached ?? 0; total.output += u.output ?? 0;
  total.cost += u.cost ?? 0; total.ms += u.ms ?? 0; total.calls += calls;
}

function money(n: number) { return `$${n.toFixed(4)}`; }

async function demoUser(): Promise<string> {
  const { data } = await admin().from('app_user').select('id')
    .eq('email', process.env.DEMO_USER_EMAIL ?? '').maybeSingle();
  if (!data?.id) throw new Error('DEMO_USER_EMAIL does not name a user');
  return data.id as string;
}

/** The generate route's work, in the generate route's order. */
async function build(name: string, ask: LessonAsk, userId: string, save: boolean) {
  console.log(`\n=== ${name} ===`);
  const ctx = await buildContext(ask);
  if (ctx.blocked) throw new Error(`blocked: ${ctx.blocked.message}`);
  const band = bandFor(ctx.yearGroup);
  const profile = profileFor(ctx.subjectId, ctx.subjectName);
  console.log(`  ${ctx.yearGroup} ${ctx.subjectName} - ${ctx.topic} - ${ctx.durationMinutes} min`);
  console.log(`  ${band.name} / ${profile.name}; ${ctx.objectives.length} objective(s): `
    + ctx.objectives.map(o => o.ref ?? '(no ref)').join(', '));

  const workKey = lessonWorkKey({
    subjectId: ctx.subjectId, yearGroup: ctx.yearGroup, academicYear: YEAR,
    weekNumber: ctx.weekNumber, refs: ctx.objectives.map(o => o.ref).filter(Boolean) as string[],
    durationMinutes: ctx.durationMinutes, topic: ctx.topic,
  });
  const input: GenerateLessonInput = {
    subjectId: ctx.subjectId, subjectName: ctx.subjectName, yearGroup: ctx.yearGroup,
    className: ctx.className, academicYear: YEAR, semester: ctx.semester,
    weekNumber: ctx.weekNumber, topic: ctx.topic, subtopic: ctx.subtopic,
    durationMinutes: ctx.durationMinutes, approach: ask.approach ?? null,
    keyQuestion: ask.keyQuestion ?? null, priorKnowledge: ask.priorKnowledge ?? null,
    context: ask.context ?? null, objectives: ctx.objectives, curriculum: ctx.curriculum,
    sourceText: ctx.sourceText, activities: ctx.activities, workKey,
  };

  const t0 = Date.now();
  const out = await generateLesson(input, userId);
  add(out.usage, out.calls);
  const deck = out.deck;
  const hit = out.usage.input + out.usage.cached
    ? out.usage.cached / (out.usage.input + out.usage.cached) : 0;
  console.log(`  generated: ${deck.slides.length} slides, ${out.calls} call(s), `
    + `${out.failedGroups} failed group(s), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  tokens: ${out.usage.input} in + ${out.usage.cached} cached + ${out.usage.output} out `
    + `(cache hit ${(hit * 100).toFixed(0)}%) - ${money(out.usage.cost)} on ${out.usage.model}`);
  console.log(`  repair: ${out.report.droppedSlides} slide(s) dropped, ${out.report.droppedBlocks} `
    + `block(s) dropped, ${out.report.trimmedSlides} trimmed, ${out.report.minutesAdjusted} minute(s) moved`);

  // ---- quality control, as the route does it
  let gate: GateResult = checkDeck(deck, band);
  report('gate', gate);
  let repaired = 0;
  if (gate.blocking) {
    const requests = repairRequests(deck, gate, allowedFor(deck));
    if (requests.length) {
      const fix = await repairLessonSlides(deck, requests, userId);
      add(fix.usage, fix.usage ? 1 : 0);
      repaired = fix.changed;
      gate = checkDeck(deck, band);
      console.log(`  repair call: ${repaired} slide(s) rewritten - ${money(fix.usage?.cost ?? 0)}`);
      report('gate after repair', gate);
    }
  }

  // ---- what came out, measured
  const words = deck.slides.map(s => slideWords(s));
  const over = deck.slides.filter(s => slideWords(s) > band.maxWordsPerSlide);
  const types = new Map<string, number>();
  for (const s of deck.slides) for (const b of s.blocks) types.set(b.type, (types.get(b.type) ?? 0) + 1);
  const kinds = deck.slides.flatMap(s => s.blocks).flatMap(b => (b.type === 'diagram' ? [b.kind] : []));
  const offProfile = kinds.filter(k => !profile.diagrams.includes(k));
  console.log(`  words/slide: max ${Math.max(...words)}, mean ${(words.reduce((a, b) => a + b, 0) / words.length).toFixed(0)} `
    + `(cap ${band.maxWordsPerSlide}); ${over.length} over`);
  console.log(`  blocks: ${[...types].map(([t, n]) => `${t}x${n}`).join(' ')}`);
  console.log(`  diagrams: ${kinds.join(', ') || 'none'}${offProfile.length ? ` - OFF PROFILE: ${offProfile.join(', ')}` : ''}`);
  console.log(`  minutes: ${deck.slides.reduce((n, s) => n + s.minutes, 0)} of ${deck.meta.duration_minutes}`);

  // ---- files, for reading
  const tag = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  writeFileSync(join(OUT, `live-${tag}.json`), JSON.stringify(deck, null, 2), 'utf8');
  writeFileSync(join(OUT, `live-${tag}.html`), renderDeckHtml(deck, { notesOpen: true }), 'utf8');
  const { bytes, notes } = await buildPptx(deck, {});
  writeFileSync(join(OUT, `live-${tag}.pptx`), bytes);
  console.log(`  files: .render-check/live-${tag}.{json,html,pptx} (${Math.round(bytes.length / 1024)} KB pptx)`
    + (notes.length ? ` - render notes: ${notes.join(' ')}` : ''));

  // ---- saved, so it can be opened in the editor
  let lessonId: string | null = null;
  if (save) {
    const row = await insertLesson({
      author_id: userId, class_id: ctx.classId, subject_id: ctx.subjectId,
      year_group: ctx.yearGroup, academic_year: YEAR, semester: ctx.semester,
      week_number: ctx.weekNumber, topic: ctx.topic, subtopic: ctx.subtopic,
      duration_minutes: ctx.durationMinutes, approach: ask.approach ?? null,
      title: deck.title, content: deck, objective_refs: deck.objective_refs,
      objective_sources: deck.objectives, work_key: workKey, theme: deck.theme,
      status: 'draft', source_upload_id: null,
    });
    if (row) {
      lessonId = row.id;
      await snapshot(row.id, deck, null, userId);
      const { standard } = await engine.resolveWorkflow('lesson');
      await storeArtefact(standard, row.id);
      console.log(`  saved: /lesson/${row.id}`);
    } else {
      console.log('  NOT SAVED - insert failed (see the log above)');
    }
  }
  return { deck, lessonId, band };
}

function report(label: string, g: GateResult) {
  console.log(`  ${label}: ${g.passed} passed, ${g.warnings} warning(s), ${g.blocking} blocking`);
  for (const c of g.checks.filter(x => x.status !== 'pass')) {
    console.log(`    ${c.status.toUpperCase()} ${c.title} - ${c.detail}`);
  }
}

async function run() {
  mkdirSync(OUT, { recursive: true });
  // Real calls are the whole point of this script, so it turns the fixtures off
  // itself rather than relying on the shell: npm runs scripts through cmd.exe on
  // Windows, where `MOCK_CLAUDE= node ...` is not a thing. lib/llm.ts reads the
  // flags at call time, so clearing them here is enough.
  process.env.MOCK_CLAUDE = '';
  process.env.MOCK_LLM = '';
  console.log('LIVE RUN - real model calls, real cost, metered in ai_usage.');
  const p = activeProvider();
  console.log(`Provider: ${p}; standard tier = ${TIER[p].standard}`);
  const started = new Date().toISOString();
  const userId = await demoUser();

  const mathsAsk: LessonAsk = {
    classId: 'CP4B-MATH', weekNumber: 4, semester: 1, durationMinutes: 60,
    approach: 'A balance of teaching and practice',
  };

  // Case A, twice: the second run measures the prompt cache.
  const a1 = await build('A1 CP4 Maths', mathsAsk, userId, true);
  await build('A2 CP4 Maths (cache)', mathsAsk, userId, false);

  // Case B: secondary, languages profile.
  await build('B LS3 English', {
    subjectId: 'ENG', yearGroup: 'LS3', weekNumber: 8, semester: 1, durationMinutes: 60,
    approach: 'Discussion and talk',
  }, userId, true);

  // One improve call, on a teacher-led text slide of A1.
  console.log('\n=== improve: make it more visual ===');
  const target = a1.deck.slides.find(s =>
    s.audience === 'teacher_led' && s.blocks.some(b => ['bullets', 'statement', 'steps'].includes(b.type)))
    ?? a1.deck.slides.find(s => s.blocks.length);
  if (target) {
    const before = target.blocks.map(b => b.type).join('+');
    const res = await improveSlide({
      deck: a1.deck as LessonDeck, slideId: target.id, action: 'visual', userId, band: a1.band,
    });
    add(res ? { cost: res.usage.cost, ms: res.usage.ms } : null);
    const after = a1.deck.slides.find(s => s.id === target.id)!;
    console.log(`  ${target.id} "${target.title}": ${before} -> ${after.blocks.map(b => b.type).join('+')}`);
    console.log(`  note: ${res?.note} - ${money(res?.usage.cost ?? 0)}`);
  }

  // ---- the ledger, as the board would see it
  const { data: rows } = await admin().from('ai_usage')
    .select('workflow, model, input_tokens, cached_tokens, output_tokens, cost_usd')
    .gte('created_at', started).like('workflow', 'lesson%');
  const ledger = (rows ?? []).reduce((n, r) => n + Number(r.cost_usd ?? 0), 0);
  const byWorkflow = new Map<string, number>();
  for (const r of rows ?? []) byWorkflow.set(r.workflow as string, (byWorkflow.get(r.workflow as string) ?? 0) + 1);
  console.log('\n=== totals ===');
  console.log(`  ${total.calls} call(s), ${total.input} in + ${total.cached} cached + ${total.output} out, `
    + `${money(total.cost)}, ${(total.ms / 1000).toFixed(0)}s of model time`);
  console.log(`  ai_usage since start: ${(rows ?? []).length} row(s), ${money(ledger)} - `
    + [...byWorkflow].map(([w, n]) => `${w} x${n}`).join(', '));
}

run().catch(e => {
  console.error('\nFAILED:', e instanceof Error ? `${e.message}\n${e.stack}` : e);
  process.exit(1);
});
