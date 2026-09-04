/**
 * TEMPORARY - a bench for looking at every study pack theme without a database.
 *
 * Delete this route once the themes are signed off. It exists so a change to
 * lib/studypack/themes.ts can be seen in a browser in one request rather than by
 * generating eight packs.
 *
 *   GET /api/theme-preview            - the theme index
 *   GET /api/theme-preview?theme=id   - a sample pack in that theme
 */
import { NextRequest, NextResponse } from 'next/server';
import { renderPackHtml } from '@/lib/studypack/render_html';
import { THEMES } from '@/lib/studypack/themes';
import type { Block, PackV2 } from '@/lib/studypack/schema';

export const runtime = 'nodejs';

function samplePack(themeId: string): PackV2 {
  const notes: Block = {
    type: 'key_notes', span: 'half', columns: 2, cards: [
      { heading: 'Brackets', tile: 'B', body: 'Always first. Work out everything inside them before anything else.' },
      { heading: 'Orders', tile: 'O', body: 'Powers and roots come next, before any multiplying or dividing.' },
      { heading: 'Division', tile: 'D', body: 'Left to right, alongside multiplication.' },
      { heading: 'Addition', tile: 'A', body: 'Left to right, alongside subtraction.' },
    ],
  };
  const worked: Block = {
    type: 'worked_example', span: 'half', examples: [
      { prompt: 'Work out 20 + 3 x (8 - 2)', steps: ['Brackets: 8 - 2 = 6', 'Multiply: 3 x 6 = 18', 'Add: 20 + 18 = 38'], answer: '38' },
    ],
  };
  const diagram: Block = {
    type: 'diagram', span: 'full', kind: 'flow', title: 'How to work through a calculation',
    caption: 'Follow the same four steps every time.',
    nodes: [
      { label: 'Read the question', note: 'twice' },
      { label: 'Pick the method', note: null },
      { label: 'Work it through', note: 'one step a line' },
      { label: 'Check the answer', note: 'units' },
    ],
    headers: [], from: null, to: null, step: null, marks: [], parts: [],
  };
  const line: Block = {
    type: 'diagram', span: 'half', kind: 'number_line', title: 'Negative numbers',
    caption: null, nodes: [], headers: [],
    from: -5, to: 5, step: 1,
    marks: [{ at: -4, label: 'start' }, { at: 2, label: 'end' }],
    parts: [],
  };
  const bar: Block = {
    type: 'diagram', span: 'half', kind: 'bar_model', title: 'Sharing 24 sweets',
    caption: null, nodes: [], headers: [], from: null, to: null, step: null, marks: [],
    parts: [{ label: 'Ama', value: 12 }, { label: 'Ben', value: 8 }, { label: 'Chipo', value: 4 }],
  };
  const practice: Block = {
    type: 'practice', span: 'full', intro: 'Answer in the space provided.', columns: 2,
    questions: [
      { text: 'Work out 12 + 4 x 2', marks: 2, answer_lines: 2 },
      { text: 'Work out (15 - 3) / 4', marks: 2, answer_lines: 2 },
      { text: 'Explain why brackets are worked out first.', marks: 3, answer_lines: 4 },
      { text: 'Write 3,482 in words.', marks: 1, answer_lines: 2 },
    ],
  };
  const quiz: Block = {
    type: 'quiz', span: 'full', questions: [
      { q: 'What does the B in BODMAS stand for?', options: ['Brackets', 'Bases', 'Both'], correct: 0, explain: 'Brackets are worked out first.' },
      { q: 'Which is worked out first, 4 + 2 x 3?', options: ['4 + 2', '2 x 3', 'Either'], correct: 1, explain: 'Multiplication comes before addition.' },
    ],
  };
  const glossary: Block = {
    type: 'glossary', span: 'full', terms: [
      { term: 'product', definition: 'The answer when two numbers are multiplied.' },
      { term: 'quotient', definition: 'The answer when one number is divided by another.' },
      { term: 'estimate', definition: 'A sensible answer found by rounding first.' },
      { term: 'remainder', definition: 'What is left over after a division.' },
    ],
  };

  return {
    version: 2, layout: 'a4-landscape', theme: themeId,
    title: 'CP5 Mathematics Revision Pack',
    subtitle: 'Weeks 1 to 4',
    meta: { subject: 'Mathematics', yearGroup: 'CP5', curriculum: 'Cambridge Primary', span: 'Weeks 1-4' },
    objectives: [
      { ref: '5Ni.03', text: 'Use knowledge of the laws of arithmetic and order of operations to simplify calculations.', source: 'registry' },
      { ref: '5Ni.06', text: 'Estimate, multiply and divide whole numbers up to 1000 by 1-digit whole numbers.', source: 'registry' },
      { ref: '5Nf.02', text: 'Understand that a fraction can be represented as a division of the numerator by the denominator.', source: 'registry' },
    ],
    objective_refs: ['5Nf.02', '5Ni.03', '5Ni.06'],
    pages: [
      {
        id: 'front', eyebrow: 'BEFORE YOU START', title: 'Helpful resources',
        objective_indexes: [], accent: 'forest', role: 'content',
        blocks: [
          {
            type: 'resources', span: 'full', intro: 'Use these first as you work through the pack.',
            groups: [
              { label: 'Number work', items: [{ name: 'Your exercise book', why: 'Your own worked examples from class.', url: null }] },
              { label: 'Practice', items: [{ name: 'Class textbook, chapter 2', why: 'More questions of the same kind.', url: null }] },
            ],
          } as Block,
          { type: 'contents', span: 'full', heading: 'Contents' } as Block,
        ],
      },
      {
        id: 'div1', eyebrow: 'TOPIC 1', title: 'Calculations',
        objective_indexes: [0], accent: 'purple', role: 'divider', blocks: [],
      },
      {
        id: 'p1', eyebrow: 'TOPIC 1 - REMIND', title: 'Order of operations',
        objective_indexes: [0, 1], accent: 'purple', role: 'content',
        blocks: [notes, worked, diagram],
      },
      {
        id: 'p2', eyebrow: 'TOPIC 1 - PRACTISE', title: 'Your turn',
        objective_indexes: [0], accent: 'teal', role: 'content',
        blocks: [practice, quiz],
      },
      {
        id: 'div2', eyebrow: 'TOPIC 2', title: 'Number and fractions',
        objective_indexes: [], accent: 'blue', role: 'divider', blocks: [],
      },
      {
        id: 'p3', eyebrow: 'TOPIC 2 - REMIND', title: 'Models that help',
        objective_indexes: [2], accent: 'blue', role: 'content',
        blocks: [line, bar, glossary],
      },
      {
        id: 'p4', eyebrow: 'FINISH', title: 'Quick revision tips',
        objective_indexes: [], accent: 'gold', role: 'content',
        blocks: [{
          type: 'closing', span: 'full', heading: 'Before the test',
          tips: ['Do three questions a night, not thirty on Sunday.', 'Write the method, not only the answer.', 'Check your units every time.'],
        } as Block],
      },
    ],
  };
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('theme');
  if (id) {
    return new NextResponse(renderPackHtml(samplePack(id)), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const rows = THEMES.map(t =>
    `<li><a href="/api/theme-preview?theme=${t.id}">${t.name}</a>`
    + `<span style="color:#666"> - ${t.cover} cover, ${t.head} head, ${t.card} cards</span></li>`).join('');
  return new NextResponse(
    `<h1>Study pack themes</h1><ul style="font:15px/2 system-ui">${rows}</ul>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
