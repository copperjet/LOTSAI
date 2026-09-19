/**
 * The lesson quality gate.
 *
 * Deterministic, structural and free. Nothing here asks a model whether the deck
 * is any good - a model marking its own work is the check that agrees with
 * itself. Every check below is a measurement against a number the generator was
 * given in its prompt (lib/lesson/ages.ts, lib/lesson/architecture.ts), which is
 * what makes the gate fair as well as cheap.
 *
 * It answers in the shape every other gate here answers in (lib/gate.ts,
 * lib/studypack/gate.ts, lib/homework.ts) - pass, warn or block per check - so
 * the chat card, the editor and the review screen render it without knowing
 * which artefact they are looking at.
 *
 * BLOCK versus WARN is a judgement about who can fix it. A deck with no
 * assessment slide is missing something only a regeneration can add, so it
 * blocks and one repair pass is spent on it. A deck whose prose is a little long
 * for the year group is something a teacher can see and shorten in the editor in
 * fifteen seconds, so it warns. Blocking on everything fixable would mean
 * spending a model call to save a teacher a sentence.
 */
import { admin } from '@/lib/supabase';
import { bandById, type AgeBand } from './ages';
import { COMPOSED_PHASES, minStudentSlides, minVisualSlides } from './architecture';
import { profileFor } from './profiles';
import {
  SLIDE_BLOCKS, STUDENT_BLOCKS, type LessonDeck, type Slide, type SlideBlockType,
} from './schema';
import {
  hasAnswerBlock, hasStudentBlock, hasVisualBlock, learnerText, meanSentenceWords, slideWords,
} from './repair';
import type { RepairRequest } from './generate';

export type CheckStatus = 'pass' | 'warn' | 'block';

export interface LessonCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  /** The slides this check is about, when it is about particular slides. */
  slides?: string[];
  /** True when one repair pass could plausibly fix it. */
  repairable?: boolean;
}

export interface GateResult {
  checks: LessonCheck[];
  blocking: number;
  warnings: number;
  passed: number;
}

/** A purpose shorter than this is not a reason, it is a restatement of the title. */
const MIN_PURPOSE_WORDS = 4;
/** Over the age cap by this factor, a slide is not long - it is a document. */
const LOAD_BLOCK_FACTOR = 1.5;
/** The timing may miss the period by this fraction before a teacher is told. */
const TIMING_TOLERANCE = 0.15;

/**
 * Somebody's name or address in learner-facing text.
 *
 * v1 of this product holds no identifiable learner data, deliberately, and the
 * rule has to hold in generated content too. A deck cannot be scanned for names
 * in general - "Mary" is a name and also a person in a history lesson - so this
 * looks for the two shapes that mean a real person got in: an email address, and
 * a salutation.
 */
const ADDRESS = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * Domains reserved for examples (RFC 2606 and 6761). An ICT lesson on validating
 * an email address has to show one, and the first version of this check refused
 * to approve any lesson that did - `user@example.com` included. An address on one
 * of these can never belong to anybody; every other one still blocks, the
 * school's own domain included.
 */
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;

/**
 * A greeting to a named person. The first version was case-sensitive and matched
 * only "dear mary", so "Dear Mary" - the only way anyone writes it - went through.
 */
const SALUTATION = /\b(?:[Dd]ear|[Hh]i|[Hh]ello)\s+(?:(?:Mr|Mrs|Miss|Ms|Dr)\.?\s+)?([A-Z][a-z]+)/g;

/** Greetings to nobody in particular - a class, a program's first output, a letter form. */
const NOT_A_PERSON = new Set([
  'class', 'everyone', 'everybody', 'all', 'there', 'team', 'students', 'learners',
  'pupils', 'friends', 'world', 'sir', 'madam', 'reader', 'children',
]);

/** Real-looking addresses on a slide, reserved example domains excepted. */
export function realAddresses(text: string): string[] {
  return [...text.matchAll(ADDRESS)]
    .filter(m => !RESERVED_DOMAIN.test(m[1]))
    .map(m => m[0]);
}

/** People greeted by name on a slide, group greetings excepted. */
export function namedGreetings(text: string): string[] {
  return [...text.matchAll(SALUTATION)]
    .filter(m => !NOT_A_PERSON.has(m[1].toLowerCase()))
    .map(m => m[0]);
}

/**
 * Check a deck without touching the database.
 *
 * Pure, so it runs in the render-check script, in the repair loop before a
 * write, and in a test the day there is a test runner.
 */
export function checkDeck(deck: LessonDeck, band: AgeBand): GateResult {
  const checks: LessonCheck[] = [];
  const slides = deck.slides ?? [];
  const objectives = deck.objectives ?? [];

  // ---- the deck exists
  if (!slides.length) {
    checks.push({
      id: 'slides', status: 'block',
      title: 'The lesson has no slides',
      detail: 'Nothing was generated. Try again, or start from a shorter list of objectives.',
    });
    return tally(checks);
  }
  checks.push({
    id: 'slides', status: 'pass',
    title: 'The lesson has slides',
    detail: `${slides.length} slides across ${deck.timing.length} phases.`,
  });

  // ---- every slide can say why it exists
  const purposeless = slides.filter(s =>
    s.purpose.split(/\s+/).filter(Boolean).length < MIN_PURPOSE_WORDS);
  checks.push(purposeless.length
    ? {
      id: 'purpose', status: 'block', repairable: true,
      slides: purposeless.map(s => s.id),
      title: 'A slide does not say why it exists',
      detail: `${purposeless.length} slide(s) carry no instructional purpose. A slide that does `
        + 'not serve the objective should not be in the lesson.',
    }
    : {
      id: 'purpose', status: 'pass',
      title: 'Every slide states its purpose',
      detail: 'Each slide says what it is for. You can read them in the editor and disagree.',
    });

  // ---- curriculum alignment
  if (!objectives.length) {
    checks.push({
      id: 'coverage', status: 'warn',
      title: 'The lesson names no curriculum objective',
      detail: 'It was built from a topic rather than from the registry, so nothing ties it to the '
        + 'signed-off curriculum.',
    });
  } else {
    // Covered means the class practises it, not that a slide names it. The first
    // real run tagged a second objective on one definition slide and never asked
    // the class to do it; the old check counted that as taught.
    const practised = new Set<number>();
    for (const s of slides) if (hasStudentBlock(s)) for (const i of s.objective_indexes) practised.add(i);
    const uncovered = objectives.map((_, i) => i).filter(i => !practised.has(i));
    const orphans = uncovered.map(i => objectives[i]?.ref ?? `objective ${i + 1}`);
    checks.push(uncovered.length
      ? {
        id: 'coverage', status: 'block', repairable: true,
        title: 'An objective is never practised',
        detail: `${orphans.join(', ')} is not on any slide where the class works on it. The lesson `
          + 'claims an objective it does not teach.',
      }
      : {
        id: 'coverage', status: 'pass',
        title: 'Every objective is practised',
        detail: `${objectives.length} objective(s), each practised by the class on at least one slide.`,
      });

    const fromFile = objectives.filter(o => o.source === 'file');
    if (fromFile.length) {
      checks.push({
        id: 'refs', status: 'warn',
        title: 'An objective came from your file, not the curriculum',
        detail: `${fromFile.length} objective(s) were read out of what you uploaded and did not `
          + 'match a signed-off objective. Check the wording before you teach it.',
      });
    } else {
      checks.push({
        id: 'refs', status: 'pass',
        title: 'The objectives are the curriculum’s own',
        detail: `${deck.objective_refs.length} reference(s), read from the registry and not rewritten.`,
      });
    }
  }

  // ---- tagged, but is it really practised?
  //
  // A model told that every objective needs a practice slide can satisfy the
  // rule by tagging the index onto any practice slide - the first real run put
  // "round to the nearest 10" on an exit ticket about composing 246. The gate
  // cannot judge meaning, but it can see when none of an objective's own
  // distinctive words appear anywhere on the slides claiming it. A warning, not
  // a block: it is a heuristic, and the teacher is the one who can tell.
  if (objectives.length) {
    const nominal = objectives.map((_, i) => i).filter(i => !visiblyPractised(deck, i));
    if (nominal.length) {
      checks.push({
        id: 'practised', status: 'warn',
        slides: slides.filter(s => s.objective_indexes.some(i => nominal.includes(i))).map(s => s.id),
        title: 'An objective is claimed but may not be practised',
        detail: `${nominal.map(i => objectives[i].ref ?? objectives[i].text.slice(0, 40)).join(', ')}: `
          + 'the slides tagged with it never mention its key words. Check the class actually does it.',
      });
    }
  }

  // ---- cognitive load
  const over = slides.filter(s => slideWords(s) > band.maxWordsPerSlide);
  const wayOver = slides.filter(s => slideWords(s) > band.maxWordsPerSlide * LOAD_BLOCK_FACTOR);
  checks.push(wayOver.length
    ? {
      id: 'load', status: 'block', repairable: true,
      slides: wayOver.map(s => s.id),
      title: 'A slide holds far too much for this age',
      detail: `${wayOver.length} slide(s) run well past the ${band.maxWordsPerSlide} words a `
        + `${band.name.toLowerCase()} slide should carry. Projected, that is unreadable.`,
    }
    : over.length
      ? {
        id: 'load', status: 'warn',
        slides: over.map(s => s.id),
        title: 'A slide is wordy for this age',
        detail: `${over.length} slide(s) are a little over ${band.maxWordsPerSlide} words. `
          + 'Shortening them in the editor takes a moment.',
      }
      : {
        id: 'load', status: 'pass',
        title: 'Every slide is readable from the back',
        detail: `No slide exceeds ${band.maxWordsPerSlide} words, which is the limit for `
          + `${band.name.toLowerCase()}.`,
      });

  // ---- one idea per slide
  const crowded = slides.filter(s => s.blocks.length > band.maxBlocksPerSlide);
  checks.push(crowded.length
    ? {
      id: 'one_idea', status: 'warn',
      slides: crowded.map(s => s.id),
      title: 'A slide carries more than one idea',
      detail: `${crowded.length} slide(s) hold more than ${band.maxBlocksPerSlide} block(s).`,
    }
    : {
      id: 'one_idea', status: 'pass',
      title: 'One main idea per slide',
      detail: 'No slide asks the class to hold two things at once.',
    });

  // ---- engagement
  const studentSlides = slides.filter(hasStudentBlock);
  // The same function the blueprint used to write the prompt, so the deck is
  // never refused for missing a number it was never given.
  const composedCount = slides.filter(s => COMPOSED_PHASES.includes(s.phase)).length;
  const wanted = minStudentSlides(slides.length, composedCount, band);
  checks.push(studentSlides.length >= wanted
    ? {
      id: 'interaction', status: 'pass',
      title: 'The class has to do things',
      detail: `${studentSlides.length} of ${slides.length} slides put the class to work: `
        + `thinking, answering, sorting, predicting or discussing.`,
    }
    : {
      id: 'interaction', status: 'block', repairable: true,
      title: 'The lesson is mostly listening',
      detail: `Only ${studentSlides.length} of ${slides.length} slides ask the class to do `
        + `anything. At this age there should be at least ${wanted}.`,
    });

  // longest run of teacher-led slides
  let run = 0; let worstRun = 0;
  for (const s of slides) {
    run = hasStudentBlock(s) ? 0 : run + 1;
    worstRun = Math.max(worstRun, run);
  }
  if (worstRun > band.interactionEvery + 1) {
    checks.push({
      id: 'pacing', status: 'warn',
      title: 'A long stretch with nothing for the class to do',
      detail: `${worstRun} slides in a row are teacher-led. At this age the class needs something `
        + `to do about every ${band.interactionEvery} slides.`,
    });
  } else {
    checks.push({
      id: 'pacing', status: 'pass',
      title: 'The pacing gives the class regular turns',
      detail: `At most ${worstRun} teacher-led slide(s) in a row.`,
    });
  }

  // ---- assessment
  const assessmentSlides = slides.filter(s => s.phase === 'assessment' || s.phase === 'exit');
  const items = deck.assessment ?? [];
  const unlinked = items.filter(a => a.objective_index < 0);
  if (!assessmentSlides.length || !items.length) {
    checks.push({
      id: 'assessment', status: 'block', repairable: true,
      title: 'Understanding is never checked',
      detail: 'The lesson has no question whose answer tells the teacher whether it worked.',
    });
  } else if (unlinked.length) {
    checks.push({
      id: 'assessment', status: 'warn',
      title: 'A question is not tied to an objective',
      detail: `${items.length} question(s) check understanding, but ${unlinked.length} sit on a `
        + 'slide that names no objective, so nothing says what they are checking.',
    });
  } else {
    checks.push({
      id: 'assessment', status: 'pass',
      title: 'Understanding is checked against the objectives',
      detail: `${items.length} question(s), each on a slide tied to an objective.`,
    });
  }

  // ---- answers and misconceptions
  const noAnswer = items.filter(a => !a.answer?.trim());
  const noMisconception = items.filter(a => !a.misconception?.trim());
  checks.push(noAnswer.length
    ? {
      id: 'answers', status: 'warn',
      title: 'A question has no answer for the teacher',
      detail: `${noAnswer.length} of ${items.length} question(s) have nothing to reveal.`,
    }
    : {
      id: 'answers', status: 'pass',
      title: 'Every question has an answer',
      detail: items.length
        ? `${items.length} answer(s), and ${items.length - noMisconception.length} with the `
          + 'misconception behind the wrong answer.'
        : 'No questions to answer.',
    });

  // ---- visual learning
  const visualSlides = slides.filter(hasVisualBlock);
  // The number the prompt asked for (lib/lesson/architecture.ts).
  const wantedVisuals = minVisualSlides(slides.length,
    slides.filter(s => COMPOSED_PHASES.includes(s.phase)).length);
  checks.push(visualSlides.length >= wantedVisuals
    ? {
      id: 'visual', status: 'pass',
      title: 'The lesson shows as well as tells',
      detail: `${visualSlides.length} slide(s) carry a diagram, a chart, a table or a picture.`,
    }
    : {
      id: 'visual', status: 'warn',
      title: 'The lesson is words all the way down',
      detail: `Only ${visualSlides.length} slide(s) show anything. For ${slides.length} slides `
        + `there should be at least ${wantedVisuals}. "Make this more visual" in the editor will `
        + 'draw one.',
    });

  // ---- timing
  const planned = slides.reduce((n, s) => n + s.minutes, 0);
  const target = deck.meta.duration_minutes || planned;
  const drift = target ? Math.abs(planned - target) / target : 0;
  checks.push(drift <= TIMING_TOLERANCE
    ? {
      id: 'timing', status: 'pass',
      title: 'The lesson fits the period',
      detail: `${planned} minutes planned across ${slides.length} slides, for a ${target} minute `
        + 'lesson.',
    }
    : {
      id: 'timing', status: 'warn',
      title: planned > target ? 'The lesson runs over' : 'The lesson is short of the period',
      detail: `${planned} minutes planned for a ${target} minute lesson. The running total in the `
        + 'editor updates as you change it.',
    });

  // ---- age-appropriate language
  const longWinded = slides.filter(s => meanSentenceWords(s) > band.maxSentenceWords);
  checks.push(longWinded.length
    ? {
      id: 'readability', status: 'warn',
      slides: longWinded.map(s => s.id),
      title: 'The language is long-winded for this age',
      detail: `${longWinded.length} slide(s) average more than ${band.maxSentenceWords} words a `
        + `sentence, which is long for ${band.name.toLowerCase()}.`,
    }
    : {
      id: 'readability', status: 'pass',
      title: 'The language suits the year group',
      detail: `Sentences average under ${band.maxSentenceWords} words.`,
    });

  // ---- the teaching guide
  const noSay = slides.filter(s => s.audience === 'teacher_led' && !s.teacher.say?.trim());
  const noExpect = slides.filter(s => hasAnswerBlock(s) && !s.teacher.expect?.trim());
  const guideGaps = noSay.length + noExpect.length;
  checks.push(guideGaps
    ? {
      id: 'notes', status: 'warn',
      slides: [...new Set([...noSay, ...noExpect].map(s => s.id))],
      title: 'The teaching guide has gaps',
      detail: `${noSay.length} slide(s) suggest nothing to say and ${noExpect.length} ask a `
        + 'question without saying what a good answer sounds like.',
    }
    : {
      id: 'notes', status: 'pass',
      title: 'Every slide has a teaching note',
      detail: 'What to say, what to expect and what to watch for, on every slide. It never shows '
        + 'on the screen.',
    });

  // ---- no learner data
  //
  // Two checks, because they deserve different answers. A real email address on
  // a slide identifies somebody and nothing makes that right, so it blocks. A
  // greeting to a named person is usually a model letter or a character in a
  // story - "Dear Mr Banda" in a letter-writing lesson - and only the teacher can
  // tell that from a real learner, so it warns and asks.
  const textOf = (s: Slide) => [s.title, ...s.blocks.flatMap(b => JSON.stringify(b))].join(' ');
  const addressed = slides.filter(s => realAddresses(textOf(s)).length);
  checks.push(addressed.length
    ? {
      id: 'no_addresses', status: 'block',
      slides: addressed.map(s => s.id),
      title: 'A slide carries a real email address',
      detail: `${addressed.length} slide(s) contain an email address that could belong to `
        + 'somebody. Use an example.com address for teaching.',
    }
    : {
      id: 'no_addresses', status: 'pass',
      title: 'No real addresses',
      detail: 'Any email address on these slides is an example one.',
    });

  const greeted = slides.filter(s => namedGreetings(textOf(s)).length);
  checks.push(greeted.length
    ? {
      id: 'no_names', status: 'warn',
      slides: greeted.map(s => s.id),
      title: 'A slide greets someone by name',
      detail: `${greeted.length} slide(s) address a named person (`
        + `${namedGreetings(textOf(greeted[0]))[0]}). Check it is an invented name and not `
        + 'a learner in the class.',
    }
    : {
      id: 'no_names', status: 'pass',
      title: 'Nobody named',
      detail: 'No slide addresses a person by name.',
    });

  return tally(checks);
}

/** Words too common in objectives to tell one from another. */
const COMMON = new Set([
  'about', 'using', 'their', 'there', 'which', 'these', 'those', 'including', 'range',
  'different', 'number', 'numbers', 'understand', 'describe', 'explain', 'identify', 'simple',
  'whole', 'with', 'from', 'into', 'that', 'this', 'when', 'where', 'what', 'show', 'make',
]);

/**
 * Does any slide tagged with this objective, where the class works, mention one
 * of the objective's distinctive words?
 *
 * Distinctive means: at least four letters, not a generic curriculum verb, and
 * not shared with the lesson's other objectives. Compared on the first five
 * letters, so "round" matches "rounding" and "rounded". An objective with no
 * distinctive words at all passes - there is nothing to look for.
 */
export function visiblyPractised(deck: LessonDeck, index: number): boolean {
  const wordsOf = (t: string) => (t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(w => !COMMON.has(w));
  const others = new Set(deck.objectives.flatMap((o, i) => (i === index ? [] : wordsOf(o.text))));
  const keys = [...new Set(wordsOf(deck.objectives[index]?.text ?? ''))]
    .filter(w => !others.has(w)).map(w => w.slice(0, 5));
  if (!keys.length) return true;
  const text = deck.slides
    .filter(s => s.objective_indexes.includes(index) && hasStudentBlock(s))
    .map(s => [s.title, ...s.blocks.flatMap(learnerText), s.teacher.say, s.teacher.expect ?? ''].join(' '))
    .join(' ').toLowerCase();
  return keys.some(k => text.includes(k));
}

function tally(checks: LessonCheck[]): GateResult {
  return {
    checks,
    blocking: checks.filter(c => c.status === 'block').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    passed: checks.filter(c => c.status === 'pass').length,
  };
}

/**
 * The gate as the engine calls it: by id, over the stored deck.
 *
 * Tolerant of migration 0028 not being applied, like every other read in this
 * codebase - a missing table answers "not checked" rather than throwing, so a
 * deploy that lands before the SQL is pasted degrades instead of white-screening.
 */
export async function gateLesson(lessonId: string): Promise<GateResult> {
  try {
    const { data } = await admin().from('lesson').select('content').eq('id', lessonId).single();
    const deck = (data?.content ?? null) as LessonDeck | null;
    if (!deck) {
      return tally([{
        id: 'slides', status: 'block',
        title: 'The lesson could not be read back',
        detail: 'It was saved but its content is missing.',
      }]);
    }
    return checkDeck(deck, bandById(deck.meta?.ageBand));
  } catch (e) {
    return tally([{
      id: 'stored', status: 'warn',
      title: 'The lesson was not checked',
      detail: `The quality check could not run: ${e instanceof Error ? e.message : String(e)}`,
    }]);
  }
}

/**
 * Which slides to spend the one repair call on, and what to tell it.
 *
 * Only blocking checks marked repairable, and only the slides they name - or,
 * for a deck-level failure such as "the lesson is mostly listening", the slides
 * that can most afford to change. Picking those is a judgement: take the
 * teacher-led slides in the phases that are supposed to be interactive first,
 * because a slide in the interaction phase that does not interact is the
 * clearest mistake in the deck.
 */
export function repairRequests(
  deck: LessonDeck, result: GateResult, allowed: SlideBlockType[],
): RepairRequest[] {
  const out = new Map<string, RepairRequest>();
  const byId = new Map(deck.slides.map(s => [s.id, s]));
  const studentTypes = STUDENT_BLOCKS.filter(t => allowed.includes(t));

  const push = (slide: Slide, problem: string, types: SlideBlockType[]) => {
    const existing = out.get(slide.id);
    if (existing) {
      existing.problem += ` Also: ${problem}`;
      existing.types = [...new Set([...existing.types, ...types])];
      return;
    }
    out.set(slide.id, { slideId: slide.id, problem, types: types.length ? types : allowed.slice(0, 6) });
  };

  for (const c of result.checks) {
    if (c.status !== 'block' || !c.repairable) continue;

    if (c.id === 'purpose' || c.id === 'load') {
      for (const id of c.slides ?? []) {
        const s = byId.get(id);
        if (s) push(s, c.detail, s.blocks.map(b => b.type).filter(t => allowed.includes(t)));
      }
      continue;
    }

    if (c.id === 'coverage') {
      // Give the orphaned objectives to the slides in the phases that teach:
      // explanation and guided practice, the ones with room for another example.
      const practisedNow = new Set<number>();
      for (const s of deck.slides) if (hasStudentBlock(s)) for (const i of s.objective_indexes) practisedNow.add(i);
      const orphans = deck.objectives.map((_, i) => i).filter(i => !practisedNow.has(i));
      // A slide where the class already works, in a practice phase - so the fix
      // is a question on the missing objective, not another explanation of it.
      const practicePhases = ['independent', 'interaction', 'guided', 'assessment'];
      const hosts = deck.slides
        .filter(s => practicePhases.includes(s.phase) && hasStudentBlock(s))
        .slice(0, orphans.length || 1);
      // No practice slide to host it: the last teaching slide, never the title or
      // objectives slide, which carry no content of their own.
      const fallback = [...deck.slides].reverse()
        .find(s => !['title', 'objectives', 'summary'].includes(s.phase));
      const targets = hosts.length ? hosts : fallback ? [fallback] : [];
      targets.forEach((s, i) => {
        const o = deck.objectives[orphans[i] ?? orphans[0]];
        push(s, `${c.detail} Make this slide one where the class practises objective `
          + `${o?.ref ?? ''} "${(o?.text ?? '').slice(0, 90)}", and include its index in objective_indexes.`,
        studentTypes);
      });
      continue;
    }

    if (c.id === 'interaction') {
      const interactive: string[] = ['interaction', 'independent', 'assessment', 'retrieval'];
      const candidates = [
        ...deck.slides.filter(s => interactive.includes(s.phase) && !hasStudentBlock(s)),
        ...deck.slides.filter(s => s.phase === 'guided' && !hasStudentBlock(s)),
      ];
      const band = bandById(deck.meta.ageBand);
      const composedNow = deck.slides.filter(s => COMPOSED_PHASES.includes(s.phase)).length;
      const short = minStudentSlides(deck.slides.length, composedNow, band)
        - deck.slides.filter(hasStudentBlock).length;
      for (const s of candidates.slice(0, Math.max(1, short))) {
        push(s, `${c.detail} Make this slide one the class does something on.`, studentTypes);
      }
      continue;
    }

    if (c.id === 'assessment') {
      // An exit or assessment slide if there is one, otherwise the last slide.
      const target = deck.slides.find(s => s.phase === 'exit')
        ?? deck.slides.find(s => s.phase === 'assessment')
        ?? deck.slides[deck.slides.length - 1];
      if (target) {
        push(target, `${c.detail} Put a question on this slide whose answer tells the teacher `
          + 'whether the objective was met, with its answer and the common misconception.',
        [...new Set([
          ...(['exit_ticket', 'mcq', 'question'] as SlideBlockType[]).filter(t => allowed.includes(t)),
          ...studentTypes,
        ])]);
      }
    }
  }

  return [...out.values()];
}

/** The block types a deck's subject may use, for the repair pass. */
export function allowedFor(deck: LessonDeck): SlideBlockType[] {
  const profile = profileFor(deck.meta.subject, deck.meta.subjectName);
  return SLIDE_BLOCKS.filter(t => !profile.avoid.includes(t));
}
