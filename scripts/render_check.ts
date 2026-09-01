/**
 * Render a study pack that exercises every block type, to a file, with no database
 * and no model. Compile-and-run harness for the renderer only:
 *
 *   npx tsc scripts/render_check.ts lib/studypack/render_html.ts lib/studypack/schema.ts lib/crest.ts \
 *     --outDir .render-check --module commonjs --target es2022 --moduleResolution node --skipLibCheck
 *   node .render-check/scripts/render_check.js
 */
import { writeFileSync } from 'node:fs';
import { renderPackHtml, footerTemplate } from '../lib/studypack/render_html';
import { renderPackPdfV2 } from '../lib/pdf/renderers/studypack_v2';
import { homeworkPack } from '../lib/homework/render_html';
import type { HomeworkContent } from '../lib/homework';
import type { PackV2 } from '../lib/studypack/schema';

const pack: PackV2 = {
  version: 2,
  layout: 'a4-landscape',
  title: 'Sport for all?',
  subtitle: 'Skills focus: Analysis',
  meta: { subject: 'Global Perspectives', yearGroup: 'LS3', curriculum: '1129', span: 'Formative 4' },
  objectives: [
    { ref: '9E.01', text: 'Evaluate sources by checking credibility, purpose and bias.', source: 'registry' },
    { ref: '9E.02', text: 'Evaluate arguments by analysing claims, reasoning and evidence.', source: 'registry' },
    { ref: '9A.02', text: 'Analyse data to identify patterns and trends.', source: 'registry' },
    { ref: null, text: 'Demonstrate by drawing, painting or making in the topics below.', source: 'file' },
  ],
  objective_refs: ['9A.02', '9E.01', '9E.02'],
  pages: [
    {
      id: 'front', eyebrow: 'BEFORE YOU START', title: 'Helpful resources',
      objective_indexes: [], accent: 'forest',
      blocks: [
        {
          type: 'resources',
          intro: 'Look through these before Section A. Come back to them as each section needs them.',
          groups: [
            { label: 'FOR SECTION A - SOURCE EVALUATION', items: [
              { name: 'The CRAAP Test for evaluating sources', why: 'Currency, Relevance, Authority, Accuracy and Purpose - what 9E.01 asks for.', url: null },
            ] },
            { label: 'FOR SECTION C - DATA ANALYSIS', items: [
              { name: 'Academic Phrasebank: describing trends', why: 'Language for saying how data rises, falls or changes.', url: null },
            ] },
          ],
        },
        { type: 'contents', heading: 'Contents' },
      ],
    },
    {
      id: 'consolidate', eyebrow: 'CONSOLIDATE', title: 'Three skills, one topic',
      objective_indexes: [0, 1, 2], accent: 'purple',
      blocks: [
        { type: 'key_ideas', items: [
          'A reliable source is trustworthy, balanced and backed by facts.',
          'An argument is a claim backed by reasons and evidence.',
          'Data reveals patterns that make an argument more convincing.',
        ] },
        { type: 'checklist', columns: [
          { heading: 'Evaluating sources', blurb: 'Check who wrote it, and why.', items: ['I can name the author of a source', 'I can explain a source\'s purpose', 'I can spot a possible bias'] },
          { heading: 'Evaluating arguments', blurb: null, items: ['I can identify the main claim', 'I can find the supporting reasons', 'I can judge strong vs weak evidence'] },
          { heading: 'Reading data', blurb: null, items: ['I can describe a trend in numbers', 'I can say where the change is biggest'] },
        ] },
        { type: 'callout', tone: 'tip', heading: 'Tip', body: 'Describe the trend first, then explain what might be causing it.' },
      ],
    },
    {
      id: 'sectionA', eyebrow: 'SECTION A - OBJECTIVE 9E.01', title: 'Source evaluation',
      objective_indexes: [0], accent: 'teal',
      blocks: [
        { type: 'source_card', sources: [
          { label: 'Source A', text: 'A Paralympic athlete explains how sport builds confidence, discipline and independence.', quick_check: 'First-hand experience, no obvious product to sell.' },
          { label: 'Source B', text: 'A sports equipment company claims every disabled child should join sport.', quick_check: 'Consider what the company gains from the claim.' },
        ] },
        { type: 'practice', intro: null, columns: 1, questions: [
          { text: 'Identify the author of Source A.', marks: 2, answer_lines: 2 },
          { text: 'Explain why Source A may be considered credible.', marks: 4, answer_lines: 3 },
          { text: 'Which source would be more useful for research? Explain.', marks: 8, answer_lines: 6 },
        ] },
      ],
    },
    {
      id: 'sectionB', eyebrow: 'SECTION B - OBJECTIVE 9E.02', title: 'Evaluating arguments',
      objective_indexes: [1], accent: 'blue',
      blocks: [
        { type: 'table', headers: ['Claim', 'Reasons', 'Evidence', 'Verdict'], rows: [
          { cells: ['The main point being argued.', 'Why the claim should be believed.', 'Facts or examples backing the reasons.', 'Strong, or weak - and why.'] },
        ], note: null },
        { type: 'two_column',
          left: { heading: "Some parents' view", body: 'Spend the budget on textbooks instead of sports equipment.' },
          right: { heading: 'Counter-argument', body: 'Participation data shows real, growing benefits from the programme.' } },
        { type: 'quiz', questions: [
          { q: 'What supports a claim in a strong argument?', options: ['Opinion alone', 'Reasons and evidence', 'Repetition'], correct: 1, explain: 'A strong argument gives reasons and backs them with evidence.' },
        ] },
      ],
    },
    {
      id: 'sectionC', eyebrow: 'SECTION C - OBJECTIVE 9A.02', title: 'Data analysis',
      objective_indexes: [2], accent: 'gold',
      blocks: [
        { type: 'chart', kind: 'bar', title: 'Learners in disability-inclusive sports, 2022-2025', unit: 'learners',
          series: [{ label: '2022', value: 15 }, { label: '2023', value: 25 }, { label: '2024', value: 45 }, { label: '2025', value: 60 }],
          aside_heading: 'Useful phrases', aside_items: ['rose steadily', 'the sharpest rise', 'more than doubled', 'a clear upward trend'] },
        { type: 'practice', intro: null, columns: 2, questions: [
          { text: 'Describe the trend.', marks: 4, answer_lines: 3 },
          { text: 'Between which years did participation increase the most?', marks: 4, answer_lines: 2 },
          { text: 'Suggest two reasons for the increase.', marks: 6, answer_lines: 4 },
          { text: 'Explain how the data supports inclusive sports.', marks: 6, answer_lines: 4 },
        ] },
      ],
    },
    {
      id: 'maths', eyebrow: 'TOPIC 7 - PROBABILITY', title: 'Key notes and worked examples',
      objective_indexes: [3], accent: 'purple',
      blocks: [
        { type: 'key_notes', columns: 2, cards: [
          { heading: 'Probability scale', body: 'Impossible (0) - Unlikely - Even chance - Likely - Certain (1).' },
          { heading: 'Probability as a fraction', body: 'P(event) = favourable outcomes / total equally likely outcomes.' },
          { heading: 'Equally likely outcomes', body: 'Each outcome has the same chance: a fair coin, spinner or dice.' },
          { heading: 'Complementary events', body: 'P(event) + P(not event) = 1.' },
        ] },
        { type: 'worked_example', examples: [
          { prompt: 'Bag: 3 red, 5 blue, 2 green balls. Find P(blue).', steps: ['Total = 3 + 5 + 2 = 10', 'P(blue) = 5/10'], answer: '1/2' },
          { prompt: 'P(winning) = 1/4. What is P(NOT winning)?', steps: ['P(not winning) = 1 - 1/4'], answer: '3/4' },
        ] },
        { type: 'think', question: 'Why do some events feel more likely than the numbers say they are?', resource_name: null, resource_url: null },
      ],
    },
    {
      id: 'revision', eyebrow: 'REVISION', title: 'Glossary and reflection',
      objective_indexes: [], accent: 'blue',
      blocks: [
        { type: 'glossary', terms: [
          { term: 'Bias', definition: 'A one-sided view that favours one position.' },
          { term: 'Claim', definition: 'The main point an argument is trying to prove.' },
          { term: 'Trend', definition: 'The overall direction of a change in data.' },
        ] },
        { type: 'reflection', prompt: 'Should schools invest in sports for disabled learners? Use evidence from the sources and data.', marks: 10,
          self_check: ["I've stated a clear position", "I've used a source or the data as evidence", "I've considered the other side"] },
        { type: 'closing', heading: 'Well done', tips: ['Review your notes regularly.', 'Try every question without help first.', 'Show every step of your working.'] },
      ],
    },
  ],
};

/**
 * `--stress` pads the pack until it cannot fit its own pages: thirty-three objectives,
 * so the cover has to set them in columns, and a section carrying a full drill plus a
 * grid of notes, so the paginator has something real to split. A pack that fits proves
 * nothing about either.
 */
if (process.argv.includes('--stress')) {
  for (let i = pack.objectives.length; i < 33; i++) {
    pack.objectives.push({
      ref: `4Rv.${String(i).padStart(2, '0')}`,
      text: 'Comment on the impact of figurative language in texts, including alliteration and similes.',
      source: 'registry',
    });
  }
  pack.objective_refs = pack.objectives.map(o => o.ref).filter((r): r is string => !!r);
  pack.pages.push({
    id: 'stress', eyebrow: 'WEEK 10', title: 'Non-fiction, discussion and punctuation',
    objective_indexes: [0, 1, 2, 3, 4, 5, 6, 7, 8], accent: 'gold',
    blocks: [
      { type: 'key_notes', columns: 3, cards: Array.from({ length: 6 }, (_, i) => ({
        heading: `Card ${i + 1}`,
        body: 'Non-fiction gives real information. It may be a report, explanation, instructions or a letter, and its punctuation carries the meaning.',
      })) },
      { type: 'practice', intro: 'Answer in full sentences where you can.', columns: 2,
        questions: Array.from({ length: 10 }, (_, i) => ({
          text: `Explain how commas, verbs and voice can help a listener understand meaning (${i + 1}).`,
          marks: 6, answer_lines: 5,
        })) },
    ],
  });
}

/**
 * `--homework` renders a homework instead: the same document, composed from the
 * homework content model (lib/homework/render_html.ts). It is here rather than in its
 * own harness because it is the same renderer, and a change to the pack's page is a
 * change to the homework's.
 */
const HOMEWORK: HomeworkContent = {
  title: 'Factors and multiples',
  intro: 'Work on your own. Show your working where a question asks for it.',
  duration_minutes: 45,
  teacher_note: 'If a learner cannot get started, reduce section 2 to the first two factor pairs.',
  objective_refs: ['4Nc.03', '4Nc.04'],
  sections: [
    {
      heading: 'Quick check', instructions: 'Answer these from memory.',
      objectives: [{ ref: '4Nc.03', text: 'Recognise multiples of 2, 5 and 10.' }],
      questions: [
        { text: 'Write the multiples of 4 up to 40.', marks: 3, answer_lines: 2, answer: '4, 8, 12, 16, 20, 24, 28, 32, 36, 40' },
        { text: 'Write the first six multiples of 6.', marks: 2, answer_lines: 2, answer: '6, 12, 18, 24, 30, 36' },
      ],
    },
    {
      heading: 'Factors', instructions: 'Use a factor pair table if it helps.',
      objectives: [{ ref: '4Nc.04', text: 'Understand factors and factor pairs of whole numbers.' }],
      questions: [
        { text: 'Find all the factors of 12, 18 and 24.', marks: 6, answer_lines: 4, answer: '12: 1,2,3,4,6,12. 18: 1,2,3,6,9,18. 24: 1,2,3,4,6,8,12,24' },
        { text: 'Circle the common factors of 18 and 24.', marks: 4, answer_lines: 2, answer: '1, 2, 3, 6' },
        { text: 'Complete the factor pairs of 20 and of 30.', marks: 6, answer_lines: 5, answer: '20: 1x20, 2x10, 4x5. 30: 1x30, 2x15, 3x10, 5x6' },
      ],
    },
    {
      heading: 'Reasoning', instructions: 'Answer in full sentences.',
      objectives: [{ ref: '4Nc.03', text: 'Recognise multiples of 2, 5 and 10.' }],
      questions: [
        { text: 'A number is a multiple of 6 and is less than 40. List all the possible numbers.', marks: 5, answer_lines: 4, answer: '6, 12, 18, 24, 30, 36' },
        { text: 'Explain how you know you have found them all.', marks: 5, answer_lines: 6, answer: 'Counting up in sixes until the next one passes 40.' },
      ],
    },
  ],
};

if (process.argv.includes('--homework')) {
  Object.assign(pack, homeworkPack(HOMEWORK, {
    subject: 'Mathematics', yearGroup: 'CP4', curriculum: '0845', weekNumber: 5,
  }));
}

const out = process.argv[2] ?? 'render-check.html';
const paged = process.argv.includes('--paged');
writeFileSync(out, renderPackHtml(pack, { paged }), 'utf-8');
if (paged) writeFileSync(out + '.footer.html', footerTemplate(pack), 'utf-8');
console.log(`wrote ${out} (${pack.pages.length} pages${paged ? ', paged' : ''})`);

// The plain pdf-lib fallback, from the same pack. It is what a teacher gets when no
// headless browser can be started, so it is checked from the same harness.
if (process.argv.includes('--pdf')) {
  renderPackPdfV2(pack, { subject: pack.meta.subject, yearGroup: pack.meta.yearGroup, weeks: pack.meta.span ?? '-' })
    .then(bytes => {
      writeFileSync(out.replace(/\.html$/, '') + '.pdf', bytes);
      console.log(`wrote ${out.replace(/\.html$/, '')}.pdf (${bytes.length} bytes)`);
    });
}
