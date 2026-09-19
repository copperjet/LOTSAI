/**
 * "Improve this slide."
 *
 * One slide, one instruction, one model call. This is the cheapest thing in the
 * feature and the one a teacher will use most: the deck comes back good enough
 * to teach from, and then a teacher who knows their class wants *this* slide
 * simpler, or with a real-world example, or harder, or with a picture instead of
 * three bullets.
 *
 * Each action is a written instruction rather than a free-text box, because the
 * eight things a teacher actually wants are knowable and naming them is faster
 * than typing. A free-text instruction is accepted as well, and goes in beside
 * the action.
 *
 * WHAT IT COSTS. One standard-tier call against a prefix that is already cached
 * from generating the deck (lib/lesson/generate.ts, groundFromDeck), with one
 * slide of volatile context. "Make it more visual" therefore does not redraw
 * anything: it returns a diagram block as data and lib/lesson/visuals.ts draws
 * it for nothing, which is the whole reason diagrams are structure here.
 */
import { call } from '@/lib/llm';
import type { AgeBand } from './ages';
import { groundFromDeck } from './generate';
import {
  IMPROVE_ACTIONS, IMPROVE_LABEL, STUDENT_BLOCKS, VISUAL_BLOCKS, improveSchema,
  type ImproveAction, type LessonDeck, type Slide, type SlideBlock, type SlideBlockType,
} from './schema';
import { accentFor, repairDeck, settleLayout, settleTeacher } from './repair';
import { speakerNotes } from './pptx';

/** The menu itself lives in lib/lesson/schema.ts, which the client can import. */
export { IMPROVE_ACTIONS, IMPROVE_LABEL, type ImproveAction };

/** What each action asks for, and what it must not quietly change. */
const INSTRUCTION: Record<ImproveAction, string> = {
  simpler: 'Make this slide simpler. Use plainer words and shorter sentences, and break the idea '
    + 'into a smaller step. Do not remove the idea itself - a slide that no longer teaches the '
    + 'objective is not simpler, it is emptier.',
  shorter: 'Cut the text on this slide down. Keep every idea; say each one in fewer words. If the '
    + 'text is only long because it is really two ideas, keep the one that serves the objective.',
  visual: 'Show this rather than tell it. Replace the text with a diagram or a chart that carries '
    + 'the same meaning, keeping only the words the picture needs. Pick the diagram kind that '
    + 'matches the structure of the idea, and give it short labels.',
  interactive: 'Turn this into a slide the class does something on. They should think, answer, '
    + 'work out, sort, predict, discuss or decide. Keep the idea it is teaching, and give the '
    + 'answer and the misconception in the teacher note.',
  harder: 'Raise the difficulty. Ask for application, explanation or evaluation rather than '
    + 'recall, use a less familiar case, or add a step. Keep it inside what this year group has '
    + 'been taught.',
  example: 'Add a worked example, or a concrete instance of the idea. Show it, do not describe it.',
  real_world: 'Ground this in something real the class would recognise - a situation in Zambia, in '
    + 'school, or in their own week. The context must carry the idea, not decorate it.',
  explain_differently: 'Explain the same idea another way. Change the representation: a diagram '
    + 'instead of words, an analogy instead of a definition, a concrete case instead of a rule.',
};

/** Which block types each action should be offered, so the schema pushes it the right way. */
function typesFor(action: ImproveAction, slide: Slide, allowed: SlideBlockType[]): SlideBlockType[] {
  const current = slide.blocks.map(b => b.type).filter(t => allowed.includes(t));
  const keep = (list: SlideBlockType[]) =>
    [...new Set([...list.filter(t => allowed.includes(t)), ...current])];

  switch (action) {
    case 'visual':
      return keep(VISUAL_BLOCKS.filter(t => t !== 'image'));
    case 'interactive':
      return keep(STUDENT_BLOCKS);
    case 'example':
      return keep(['worked_example', 'steps', 'definition', 'scenario']);
    case 'real_world':
      return keep(['scenario', 'question', 'chart', 'table']);
    case 'explain_differently':
      return keep(['diagram', 'compare', 'definition', 'statement', 'worked_example']);
    case 'harder':
      return keep(['question', 'task', 'scenario', 'error_spot', 'mcq']);
    default:
      // simpler and shorter keep the slide's own shape; changing the block type
      // would be answering a different question than the one asked.
      return current.length ? current : allowed.slice(0, 6);
  }
}

export interface ImproveResult {
  slide: Slide;
  /** One line for the teacher saying what changed. */
  note: string;
  usage: { cost: number; model: string; ms: number };
}

export async function improveSlide(o: {
  deck: LessonDeck;
  slideId: string;
  action: ImproveAction;
  instruction?: string | null;
  userId: string;
  band: AgeBand;
}): Promise<ImproveResult | null> {
  const slide = o.deck.slides.find(s => s.id === o.slideId);
  if (!slide) return null;

  const g = groundFromDeck(o.deck);
  const types = typesFor(o.action, slide, g.allowed);
  const extra = String(o.instruction ?? '').trim();

  const res = await call<{
    title: string; purpose: string; audience: string; minutes: number;
    blocks: SlideBlock[]; teacher: unknown; note: string;
  }>({
    tier: 'standard',
    workflow: 'lesson_improve',
    userId: o.userId,
    system: IMPROVE_SYSTEM,
    cached: g.cached,
    prompt: [
      `Improve slide ${slide.id} of this lesson.`,
      '',
      `WHAT TO DO: ${INSTRUCTION[o.action]}`,
      extra ? `THE TEACHER ALSO SAID: ${extra}` : '',
      '',
      'THE SLIDE AS IT STANDS:',
      `  phase: ${slide.phase}    audience: ${slide.audience}    minutes: ${slide.minutes}`,
      `  objectives: [${slide.objective_indexes.join(',')}]`,
      `  title: ${slide.title}`,
      `  purpose: ${slide.purpose}`,
      `  content: ${JSON.stringify(slide.blocks)}`,
      `  teacher note: ${JSON.stringify(slide.teacher)}`,
      '',
      'Return the whole slide, improved. Keep the objectives it addresses and roughly its minutes.',
      'Finish with one line for the teacher saying what you changed and why.',
    ].filter(Boolean).join('\n'),
    schema: improveSchema(types),
    maxTokens: 4000,
  });

  const d = res.data;
  slide.title = String(d.title ?? slide.title).trim() || slide.title;
  slide.purpose = String(d.purpose ?? slide.purpose).trim() || slide.purpose;
  slide.audience = d.audience === 'student_facing' ? 'student_facing' : 'teacher_led';
  if (Number.isFinite(d.minutes) && d.minutes > 0) slide.minutes = Math.round(d.minutes);
  if (Array.isArray(d.blocks) && d.blocks.length) slide.blocks = d.blocks;
  slide.teacher = settleTeacher(d.teacher as never);
  slide.accent = accentFor(slide.phase);

  // The whole deck is repaired, not just this slide: changing one slide's minutes
  // changes the running total, and changing its blocks changes the assessment
  // list and the objective coverage the gate reads.
  repairDeck(o.deck, o.band);
  const fixed = o.deck.slides.find(s => s.id === o.slideId);
  if (fixed) fixed.layout = settleLayout(fixed);

  return {
    slide: fixed ?? slide,
    note: String(d.note ?? '').trim() || IMPROVE_LABEL[o.action],
    usage: { cost: res.usage.cost, model: res.usage.model, ms: res.usage.ms },
  };
}

const IMPROVE_SYSTEM = `You improve one slide of a lesson for Lusaka Oaktree School, a Cambridge
primary and secondary school in Zambia.

You are given the whole lesson for context and one slide to change. Change only that slide.

The rules that made the lesson still hold:
- Objectives are supplied indexed. Never write, reword or invent one; keep the ones this slide
  already addresses.
- The slide states its purpose: one sentence saying why it exists and what it does for the
  objective.
- One main idea per slide. It is read by a room from four metres away.
- Any question you ask has an answer, and where there is one, the misconception behind the wrong
  answer. Both go in the teacher note, never on the slide.
- The teacher note is what the teacher reads and the class never sees.

Do what you were asked and nothing else. A teacher who asked for a slide to be simpler and got a
different slide has lost the one they had.

Any email address in teaching content uses the example.com domain; any person named is invented.

Never use an em dash or an en dash. Use a plain hyphen.`;

/** The notes as the editor shows them, so the panel and the PowerPoint agree. */
export function notesPreview(deck: LessonDeck, slide: Slide): string {
  const i = deck.slides.findIndex(s => s.id === slide.id);
  return speakerNotes(deck, slide, Math.max(0, i), deck.slides.length);
}
