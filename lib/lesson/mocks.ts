/**
 * Fixtures for MOCK_LLM=1, beside the lesson they fake.
 *
 * Same principle as lib/mocks.ts: the point is not a plausible-looking demo, it
 * is to exercise every path a real call exercises without an API key. So these
 * are read off the same prompt the model would have received - the blueprint's
 * phases and slide counts, the indexed objectives, the block types each slide
 * was planned to carry - which means the fixture output goes through the real
 * repair pass and satisfies the real quality gate instead of tripping it.
 *
 * If the gate starts failing on mock output, that is a signal worth having: it
 * means the generator and the gate have drifted apart.
 */
import {
  DIAGRAM_KINDS, SLIDE_BLOCKS, STUDENT_BLOCKS,
  type DiagramKind, type SlideBlock, type SlideBlockType, type TeacherNote,
} from './schema';

/** Objective indexes offered in the cached block, as `  [0] 4Np.03 - ...`. */
function objectiveCount(cached: string): number {
  return Math.max(1, (cached.match(/^\s*\[\d+\]/gm) ?? []).length);
}

/** The blueprint, straight out of the prompt it was written into. */
function phases(prompt: string): { phase: string; minutes: number; slides: number }[] {
  const out: { phase: string; minutes: number; slides: number }[] = [];
  const re = /^\s{2}(.+?) - (\d+) min, (\d+) slides? \(phase id: (\w+)\)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    out.push({ phase: m[4], minutes: Number(m[2]), slides: Number(m[3]) });
  }
  return out.length ? out : [
    { phase: 'title', minutes: 2, slides: 1 },
    { phase: 'objectives', minutes: 2, slides: 1 },
    { phase: 'explanation', minutes: 20, slides: 3 },
    { phase: 'interaction', minutes: 15, slides: 2 },
    { phase: 'assessment', minutes: 10, slides: 1 },
    { phase: 'exit', minutes: 3, slides: 1 },
  ];
}

function minStudent(prompt: string): number {
  const m = prompt.match(/At least (\d+) of them must be student_facing/);
  return m ? Number(m[1]) : 2;
}

/** Which block types this subject was offered, off the cached profile block. */
function allowedTypes(cached: string): SlideBlockType[] {
  const line = cached.match(/Reach for these block types first, in this order: (.+?)\./);
  const preferred = (line?.[1] ?? '').split(',').map(t => t.trim())
    .filter((t): t is SlideBlockType => (SLIDE_BLOCKS as readonly string[]).includes(t));
  return preferred.length ? preferred : ['bullets', 'statement', 'question', 'diagram'];
}

function allowedDiagrams(cached: string): DiagramKind[] {
  const line = cached.match(/Diagram kinds available for this subject: (.+?)\./);
  const kinds = (line?.[1] ?? '').split(',').map(t => t.trim())
    .filter((t): t is DiagramKind => (DIAGRAM_KINDS as readonly string[]).includes(t));
  return kinds.length ? kinds : ['flow'];
}

const STUDENT_PHASES = ['retrieval', 'hook', 'interaction', 'independent', 'assessment', 'exit'];

export function mockLessonOutline(cached: string, prompt: string): unknown {
  const plan = phases(prompt);
  const objectives = objectiveCount(cached);
  const prefer = allowedTypes(cached);
  const wantStudent = minStudent(prompt);

  const slides: unknown[] = [];
  let n = 0;
  let studentSoFar = 0;
  let teacherRun = 0;
  let objectiveCursor = 0;

  for (const p of plan) {
    const per = Math.max(1, Math.round(p.minutes / p.slides));
    for (let i = 0; i < p.slides; i++) {
      const id = `s${String(++n).padStart(2, '0')}`;
      // The title, objectives and summary slides are drawn from the deck itself.
      // Putting a question on one is how the untied-assessment warning was found.
      const composed = p.phase === 'title' || p.phase === 'objectives' || p.phase === 'summary';
      // Interleave rather than clump. A fixture that leaves six teacher-led
      // slides in a row trips the pacing warning on every run, and a warning
      // that is always on is a warning nobody reads.
      const student = !composed
        && (STUDENT_PHASES.includes(p.phase)
          || studentSoFar < wantStudent
          || teacherRun >= 2);
      if (student) { studentSoFar++; teacherRun = 0; } else if (!composed) { teacherRun++; }

      // Every objective gets a slide before any gets a second, so the coverage
      // check passes and the gate is exercised rather than avoided.
      const objective = p.phase === 'title' ? [] : [objectiveCursor % objectives];
      if (p.phase !== 'title' && p.phase !== 'objectives') objectiveCursor++;

      slides.push({
        id,
        phase: p.phase,
        audience: student ? 'student_facing' : 'teacher_led',
        title: titleFor(p.phase, n),
        purpose: `Gives the class ${purposeFor(p.phase)} so the objective is met.`,
        minutes: per,
        objective_indexes: objective,
        block_types: composed ? [] : [blockFor(p.phase, student, prefer, n)],
      });
    }
  }

  return { title: 'A mock lesson', subtitle: 'Generated with MOCK_LLM=1', slides };
}

function titleFor(phase: string, n: number): string {
  const titles: Record<string, string> = {
    title: 'Today we are learning',
    objectives: 'What you will be able to do',
    retrieval: 'What we already know',
    hook: 'Why does this matter?',
    concept: 'The idea, named',
    explanation: 'How it works',
    visual: 'The same idea, drawn',
    guided: 'Let us do one together',
    interaction: 'Your turn to decide',
    independent: 'Now do these on your own',
    assessment: 'Have you got it?',
    summary: 'What we did today',
    exit: 'Before you go',
  };
  return titles[phase] ?? `Step ${n}`;
}

function purposeFor(phase: string): string {
  const why: Record<string, string> = {
    title: 'the shape of the lesson',
    objectives: 'the destination before the journey',
    retrieval: 'the prior knowledge this lesson stands on',
    hook: 'a reason to care about the idea',
    concept: 'the name for the thing they are about to use',
    explanation: 'the mechanism, step by step',
    visual: 'the structure of the idea in one picture',
    guided: 'a worked case before they try one',
    interaction: 'a decision to make with the idea',
    independent: 'practice at their own pace',
    assessment: 'evidence of whether it landed',
    summary: 'the lesson pulled back together',
    exit: 'one question that shows what stuck',
  };
  return why[phase] ?? 'a step towards the objective';
}

function blockFor(
  phase: string, student: boolean, prefer: SlideBlockType[], n: number,
): SlideBlockType {
  if (phase === 'exit') return 'exit_ticket';
  if (phase === 'assessment') return 'mcq';
  if (phase === 'independent') return 'task';
  if (phase === 'interaction') return n % 2 ? 'question' : 'discuss';
  if (phase === 'visual') return 'diagram';
  // The audience decides first. A slide planned as the class's turn that comes
  // back with a diagram on it is not the class's turn, and the repair pass will
  // say so - which is how this ordering was found to be the wrong way round.
  if (student) {
    const s = STUDENT_BLOCKS.filter(t => t !== 'exit_ticket');
    return s[n % s.length];
  }
  // Explaining and naming an idea is where a real deck reaches for a picture, and
  // a fixture that never does makes the visual check pass vacuously in one deck
  // and fail in another for reasons that have nothing to do with the code.
  if (phase === 'concept' || phase === 'explanation') {
    return n % 2 ? 'diagram' : (prefer.find(t => t === 'diagram' || t === 'chart') ?? prefer[0] ?? 'bullets');
  }
  return prefer[n % prefer.length] ?? 'bullets';
}

/** The fill pass reads the slide ids and block types straight out of its prompt. */
export function mockLessonFill(cached: string, prompt: string): unknown {
  const diagrams = allowedDiagrams(cached);
  const asked: { id: string; types: SlideBlockType[]; title: string }[] = [];

  // `blocks:` can be empty - that is a composed slide, which still gets a note.
  const re = /^(s\d+) - (.+)\n\s+purpose: .*\n\s+blocks: (.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    asked.push({
      id: m[1],
      title: m[2].trim(),
      types: m[3].split(',').map(t => t.trim())
        .filter((t): t is SlideBlockType => (SLIDE_BLOCKS as readonly string[]).includes(t)),
    });
  }

  return {
    slides: asked.map((a, i) => ({
      id: a.id,
      // No types asked for means a composed slide: the renderer draws it from the
      // deck itself, so it gets a teacher note and nothing else.
      blocks: a.types.map(t => mockBlock(t, a.title, diagrams[i % diagrams.length])),
      teacher: mockTeacher(a.title),
    })),
  };
}

function mockTeacher(title: string): TeacherNote {
  return {
    intention: `Establish "${title}" before moving on.`,
    say: 'Watch what happens when I change one thing, and tell me what you notice.',
    expect: 'They should say that it changes in proportion, in their own words.',
    misconceptions: ['They may say it doubles when it does not.'],
    follow_up: 'Ask them to predict the next case before you show it.',
    timing_note: 'If you are short of time, do one example rather than two.',
  };
}

/** One block of each type, shaped so the repair pass and the gate both have work to do. */
function mockBlock(type: SlideBlockType, title: string, diagram: DiagramKind): SlideBlock {
  switch (type) {
    case 'statement':
      return { type, text: `${title} is the idea this slide carries.`, attribution: null };
    case 'bullets':
      return { type, heading: null, items: ['The first point', 'The second point', 'The third point'] };
    case 'definition':
      return { type, term: 'Mock term', meaning: 'What the term means, in one line.', example: 'An example of it.' };
    case 'steps':
      return { type, heading: null, steps: ['Do this first', 'Then this', 'Then check it'] };
    case 'worked_example':
      return { type, prompt: 'Work out 24 x 3', steps: ['20 x 3 = 60', '4 x 3 = 12', '60 + 12'], answer: '72', reveal: true };
    case 'compare':
      return {
        type, heading: null,
        columns: [
          { heading: 'One way', points: ['Faster', 'Less accurate'] },
          { heading: 'The other', points: ['Slower', 'More accurate'] },
        ],
      };
    case 'table':
      return { type, headers: ['Thing', 'Value'], rows: [{ cells: ['First', '10'] }, { cells: ['Second', '20'] }], note: null };
    case 'code':
      return { type, language: 'python', lines: ['total = 0', 'for n in numbers:', '    total = total + n'], caption: null };
    case 'diagram':
      return {
        type, kind: diagram, title: 'How it works', caption: null,
        nodes: [{ label: 'Input', note: null }, { label: 'Process', note: null }, { label: 'Output', note: null }],
        headers: [], from: 0, to: 10, step: 1,
        marks: [{ at: 4, label: 'here' }],
        parts: [{ label: 'Part A', value: 3 }, { label: 'Part B', value: 7 }],
      };
    case 'chart':
      return {
        type, kind: 'bar', title: 'Some figures', unit: null,
        series: [{ label: 'Mon', value: 4 }, { label: 'Tue', value: 7 }, { label: 'Wed', value: 5 }],
        note: null,
      };
    case 'image':
      return { type, asset_id: '', alt: 'A picture', caption: null };
    case 'question':
      return { type, question: `What would happen to ${title} if we changed it?`, prompt: 'Think first, hands down.', answer: 'It would change in proportion.', misconception: 'They often say it doubles.' };
    case 'mcq':
      return {
        type, question: 'Which of these is correct?',
        options: ['The right one', 'A tempting wrong one', 'A careless wrong one'],
        correct: 0,
        why_wrong: ['', 'They used the wrong operation.', 'They stopped one step early.'],
        explain: 'The first is right because the steps were followed in order.',
      };
    case 'true_false':
      return { type, statements: [{ text: 'This is always true', is_true: false, why: 'It only holds in one case.' }, { text: 'This is sometimes true', is_true: true, why: 'It depends on the starting value.' }] };
    case 'predict':
      return { type, setup: 'We double the first number.', question: 'What happens to the answer?', answer: 'It doubles too.', misconception: 'Some will say it squares.' };
    case 'sort':
      return { type, instruction: 'Put each of these in the right column.', categories: ['Yes', 'No'], items: [{ text: 'First item', category: 0 }, { text: 'Second item', category: 1 }] };
    case 'error_spot':
      return { type, instruction: 'Find the mistake in this working.', work: ['24 x 3', '= 20 x 3 + 4 x 3', '= 60 + 7'], wrong_line: 2, error: 'Four threes were added as seven, not twelve.', correction: '= 60 + 12 = 72' };
    case 'scenario':
      return { type, context: 'A shop sells bags of maize at three different prices.', task: 'Which is the best value, and how do you know?', prompts: ['What do you need to work out first?'] };
    case 'discuss':
      return { type, prompt: 'Which method would you use, and why?', structure: 'think_pair_share', minutes: 3, share_back: 'One pair explains their method.' };
    case 'task':
      return { type, instruction: 'Work through these in your book.', questions: [{ text: 'Work out 16 x 4', marks: 2 }, { text: 'Explain your method', marks: 3 }], support: 'Use the grid if you need it.', extension: 'Try it with a three-digit number.' };
    case 'exit_ticket':
      return { type, question: 'Write down one thing you can do now that you could not this morning.', answer: 'Any accurate statement of the objective.', success_criteria: ['It names the method', 'It gives an example'] };
    default:
      return { type: 'bullets', heading: null, items: ['Mock content'] };
  }
}

/** The repair pass: whole replacement slides, with something for the class to do. */
export function mockLessonRepair(cached: string, prompt: string): unknown {
  const diagrams = allowedDiagrams(cached);
  const ids = [...prompt.matchAll(/^(s\d+)$/gm)].map(m => m[1]);
  const objectives = objectiveCount(cached);

  return {
    slides: (ids.length ? ids : ['s01']).map((id, i) => ({
      id,
      title: 'Your turn to work it out',
      purpose: 'Puts the class to work on the objective rather than watching it explained.',
      audience: 'student_facing',
      minutes: 5,
      objective_indexes: [i % objectives],
      blocks: [mockBlock('question', 'the idea', diagrams[0])],
      teacher: mockTeacher('the idea'),
    })),
  };
}

/** One improved slide. */
export function mockLessonImprove(cached: string, prompt: string): unknown {
  const diagrams = allowedDiagrams(cached);
  const visual = /Show this rather than tell it/.test(prompt);
  const interactive = /Turn this into a slide the class does something on/.test(prompt);
  const type: SlideBlockType = visual ? 'diagram' : interactive ? 'question' : 'bullets';

  return {
    title: 'An improved slide',
    purpose: 'Carries the same idea in a form the class can act on.',
    audience: interactive ? 'student_facing' : 'teacher_led',
    minutes: 4,
    blocks: [mockBlock(type, 'the idea', diagrams[0])],
    teacher: mockTeacher('the idea'),
    note: 'Rewritten as asked, keeping the objective it addresses.',
  };
}
