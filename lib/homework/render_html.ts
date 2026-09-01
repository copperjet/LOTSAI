/**
 * Render homework to the same document the study pack is rendered to.
 *
 * There is no third page design here on purpose. lib/studypack/render_html.ts already
 * carries the school's page furniture - the crest on every sheet, the objective strip,
 * the accent band, ruled answer space, the paginator, and an answer key that prints at
 * the back so a paper can be worked before the answers are seen. A homework needs every
 * one of those and nothing else, so it is composed as a PackV2 and handed over.
 *
 * That is also the answer to the request that started this: "put it on a document, make
 * it interactive and colourful" is what renderPackHtml does, and it does it the same
 * way for all three artefacts, so a fix to one page is a fix to every page.
 *
 * The homework's own content model (lib/homework.ts) stays what it is - sections,
 * marks, answers, a duration. This is a projection of it onto blocks, not a second
 * store of it.
 */
import { renderPackHtml } from '@/lib/studypack/render_html';
import type { Block, PackObjective, PackV2, Page } from '@/lib/studypack/schema';
import type { HomeworkContent } from '@/lib/homework';

export interface HomeworkMeta {
  subject: string; yearGroup: string; curriculum: string | null; weekNumber: number;
}

/** Section colours, in order, so a three section paper does not print three identical
 *  pages. Taken from the pack's own accents. */
const ACCENTS = ['forest', 'teal', 'blue', 'purple', 'gold'] as const;

export function homeworkPack(content: HomeworkContent, meta: HomeworkMeta): PackV2 {
  // The objective list the pages index into. Every one came from the registry by way
  // of lib/homework.ts, which is the founding rule; nothing here can add to it.
  const objectives: PackObjective[] = [];
  const indexOf = new Map<string, number>();
  for (const sec of content.sections ?? []) {
    for (const o of sec.objectives ?? []) {
      const seen = `${o.ref ?? ''}|${o.text}`;
      if (indexOf.has(seen)) continue;
      indexOf.set(seen, objectives.length);
      objectives.push({ ref: o.ref ?? null, text: o.text, source: 'registry' });
    }
  }

  const marks = (content.sections ?? []).flatMap(s => s.questions ?? [])
    .reduce((n, q) => n + (q.marks || 0), 0);

  const pages: Page[] = [];
  const sections = content.sections ?? [];

  /**
   * One page per section, and nothing else the learner has to turn past.
   *
   * There used to be a brief page in front of these - the duration, a checklist and a
   * contents page - which made a two-section homework four sheets before the answer
   * key. A homework is not a booklet: what a learner needs before they start is one
   * line, and it belongs at the top of the first question page. So the brief is a
   * callout on page one, the hand-in checklist closes the last page, and the contents
   * page is gone.
   *
   * A section too long for a page still runs on to a continuation sheet - the pack's
   * paginator does that - which is why lib/homework.ts caps the questions rather than
   * trusting the model to.
   */
  sections.forEach((sec, i) => {
    const blocks: Block[] = [];
    const first = i === 0, last = i === sections.length - 1;

    if (first) {
      blocks.push({
        type: 'callout', tone: 'note', span: 'full',
        heading: `${content.duration_minutes} minutes${marks ? ` - ${marks} marks` : ''}`,
        body: content.intro || 'Work through every section. Show your working where a question asks for it.',
      });
    }
    if (sec.instructions?.trim()) {
      blocks.push({ type: 'callout', tone: 'tip', span: 'full', heading: null, body: sec.instructions });
    }
    blocks.push({
      type: 'practice', span: 'full', intro: null, columns: 1,
      questions: (sec.questions ?? []).map(q => ({
        text: q.text, marks: q.marks || null, answer_lines: q.answer_lines || 2,
      })),
    });
    if (last) {
      blocks.push({
        type: 'checklist', span: 'half',
        columns: [{
          heading: 'Before you hand it in',
          blurb: null,
          items: [
            'I have answered every question.',
            'I have shown my working where it was asked for.',
            'I have read my answers back once.',
          ],
        }],
      });
    }

    pages.push({
      id: `section-${i + 1}`,
      eyebrow: first ? `WEEK ${meta.weekNumber} HOMEWORK` : `SECTION ${i + 1}`,
      title: sec.heading || `Section ${i + 1}`,
      objective_indexes: (sec.objectives ?? [])
        .map(o => indexOf.get(`${o.ref ?? ''}|${o.text}`))
        .filter((n): n is number => n != null),
      accent: ACCENTS[i % ACCENTS.length],
      blocks,
    });
  });

  // The answer key. The pack builds one automatically from quiz blocks only, and
  // homework has no quiz, so the answers are written out as a page of their own -
  // marked for the teacher, and last, so the paper can be worked before it is seen.
  const answers = sections.flatMap((sec, si) =>
    (sec.questions ?? []).map((q, qi) => ({
      heading: `${si + 1}.${qi + 1}${q.marks ? `  [${q.marks}]` : ''}`,
      body: q.answer || 'Accept any reasonable answer.',
    })));

  if (answers.length) {
    pages.push({
      id: 'key',
      eyebrow: 'FOR THE TEACHER',
      title: 'Answer key',
      objective_indexes: [],
      accent: 'gold',
      blocks: [
        ...(content.teacher_note?.trim()
          ? [{ type: 'callout', tone: 'note', span: 'full', heading: 'If a learner cannot get started',
               body: content.teacher_note } as Block]
          : []),
        { type: 'key_notes', span: 'full', columns: 2, cards: answers },
      ],
    });
  }

  return {
    version: 2,
    layout: 'a4-landscape',
    kind: 'Homework',
    title: content.title,
    subtitle: `Homework - ${content.duration_minutes} minutes${marks ? `, ${marks} marks` : ''}`,
    meta: {
      subject: meta.subject, yearGroup: meta.yearGroup,
      curriculum: meta.curriculum, span: `Week ${meta.weekNumber}`,
    },
    objectives,
    pages,
    objective_refs: content.objective_refs ?? [],
  };
}

/** The homework as one self-contained HTML document. No cover: a two page paper
 *  handed to a learner should be two pages, not a cover and two pages. */
export function renderHomeworkHtml(content: HomeworkContent, meta: HomeworkMeta): string {
  return renderPackHtml(homeworkPack(content, meta), { cover: false });
}
