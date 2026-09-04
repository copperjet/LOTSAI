/**
 * The study pack gate, v2.
 *
 * The Reference Guide's five must-haves and the Build Kit's six non-negotiables, as
 * deterministic checks over the stored pack. Structural, so free and instant. Most
 * are met by construction - the generator cannot emit a quiz with a broken answer
 * index - but a gate is what makes that a guarantee rather than a hope, and it is
 * what the Standard's gate_id points at.
 *
 * v1 packs still exist in the bank, so this dispatches on content_version and hands
 * an older pack to the original gate unchanged.
 */
import { admin } from '@/lib/supabase';
import { gateStudyPack } from '@/lib/studypack';
import type { Block, PackV2, Page } from './schema';

export interface GateCheck {
  id: string; status: 'pass' | 'warn' | 'block'; title: string; detail: string;
}

/** A key idea longer than this is a paragraph of notes, which the Reference Guide
 *  explicitly tells teachers to turn into a worked example instead. */
const LONG_IDEA = 220;

/** Blocks that make a page active rather than something merely read. */
const ACTIVE = new Set<Block['type']>(['practice', 'quiz', 'worked_example', 'reflection', 'checklist']);
/** Pages that carry no objectives on purpose: covers, contents, closings. */
const FRONT_MATTER = new Set<Block['type']>(['contents', 'closing', 'resources', 'glossary']);

export async function gateStudyPackV2(studyPackId: string) {
  const db = admin();
  const { data: pack } = await db.from('study_pack')
    .select('content, source_kind').eq('id', studyPackId).single();

  const content = (pack?.content ?? {}) as Partial<PackV2>;
  if (Number(content.version) !== 2) return gateStudyPack(studyPackId);

  const pages = (content.pages ?? []) as Page[];
  const objectives = content.objectives ?? [];
  const blocksOf = (p: Page) => p.blocks ?? [];
  const allBlocks = pages.flatMap(blocksOf);
  const has = (t: Block['type']) => allBlocks.some(b => b.type === t);
  const checks: GateCheck[] = [];

  // 1. There is a pack at all.
  checks.push(pages.length
    ? { id: 'pages', status: 'pass', title: 'The pack has pages', detail: `${pages.length} pages, ${allBlocks.length} blocks.` }
    : { id: 'pages', status: 'block', title: 'The pack has no pages', detail: 'Nothing was generated.' });

  // A divider is a title on a full-bleed field and carries no blocks on purpose
  // (lib/studypack/schema.ts, PageRole). It is the one page that is right to be
  // empty, and counting it as an unfilled page blocked every pack that had one.
  const empty = pages.filter(p => p.role !== 'divider' && !blocksOf(p).length);
  if (empty.length) {
    checks.push({
      id: 'empty_pages', status: 'block', title: 'A page has no content',
      detail: `${empty.length} page(s) were outlined but never filled: ${empty.map(p => p.title).join(', ')}.`,
    });
  }

  // 2. Resources, near the front (Reference Guide must-have 1).
  const resourceAt = pages.findIndex(p => blocksOf(p).some(b => b.type === 'resources'));
  checks.push(
    resourceAt < 0
      ? { id: 'resources', status: 'warn', title: 'No helpful resources', detail: 'The Reference Guide asks for a short list of checked resources at the start of the pack.' }
      : resourceAt > 2
        ? { id: 'resources', status: 'warn', title: 'Resources are not at the front', detail: `They are on page ${resourceAt + 1}; the guide asks for them before the content.` }
        : { id: 'resources', status: 'pass', title: 'Helpful resources are at the front', detail: `On page ${resourceAt + 1}.` },
  );

  // 3. Objectives: stated on every content page, and never invented.
  const contentPages = pages.filter(p =>
    p.role !== 'divider' && blocksOf(p).some(b => !FRONT_MATTER.has(b.type)));
  const unstated = contentPages.filter(p => !(p.objective_indexes?.length));
  checks.push(unstated.length
    ? { id: 'objectives', status: 'warn', title: 'A page states no objective', detail: `${unstated.length} of ${contentPages.length} content pages: ${unstated.map(p => p.title).join(', ')}.` }
    : { id: 'objectives', status: 'pass', title: 'Every content page states its objectives', detail: `${contentPages.length} pages.` });

  const outOfRange = pages.flatMap(p => p.objective_indexes ?? []).filter(i => !objectives[i]);
  if (outOfRange.length) {
    checks.push({
      id: 'objective_refs', status: 'block', title: 'A page cites an objective that is not in the pack',
      detail: `${outOfRange.length} index(es) point past the objective list. A pack must never cite a code the curriculum does not hold.`,
    });
  }

  const fromFile = objectives.filter(o => o.source === 'file');
  const matched = objectives.filter(o => o.source === 'matched');
  if (fromFile.length) {
    checks.push({
      id: 'objective_provenance', status: 'warn', title: 'Some objectives came from the file, not the curriculum',
      detail: `${fromFile.length} objective(s) are the document's own wording with no syllabus code`
        + `${matched.length ? `, and ${matched.length} were matched to the registry by text` : ''}. Confirm them before sharing.`,
    });
  } else if (matched.length) {
    checks.push({
      id: 'objective_provenance', status: 'warn', title: 'Some objectives were matched by text',
      detail: `${matched.length} objective(s) were matched to the registry from the file's wording rather than by code.`,
    });
  } else {
    checks.push({
      id: 'objective_provenance', status: 'pass', title: 'Objectives come from the registry',
      detail: `${objectives.length} objectives, ${(content.objective_refs ?? []).length} with syllabus codes.`,
    });
  }

  // 4. Short key ideas, not notes (Reference Guide must-have 3).
  const longIdeas = allBlocks.flatMap(b =>
    b.type === 'key_ideas' ? b.items
      : b.type === 'key_notes' ? b.cards.map(c => c.body) : [],
  ).filter(t => t.length > LONG_IDEA);
  const badCount = allBlocks.filter(b => b.type === 'key_ideas' && (b.items.length < 3 || b.items.length > 6)).length;
  checks.push(longIdeas.length || badCount
    ? { id: 'key_ideas', status: 'warn', title: 'Key ideas read as notes', detail: `${longIdeas.length} card(s) over ${LONG_IDEA} characters${badCount ? `, ${badCount} list(s) outside 3-6 bullets` : ''}.` }
    : { id: 'key_ideas', status: 'pass', title: 'Key ideas are short', detail: 'Cards and bullets are scannable.' });

  // 5. Something to do on every page (Reference Guide must-have 4).
  const passive = contentPages.filter(p => !blocksOf(p).some(b => ACTIVE.has(b.type)));
  checks.push(passive.length
    ? { id: 'practice', status: 'warn', title: 'A content page has nothing to do', detail: `${passive.length} page(s) with no questions, worked example or checklist: ${passive.map(p => p.title).join(', ')}.` }
    : { id: 'practice', status: 'pass', title: 'Every content page asks the student to do something', detail: 'Questions, a worked example or a checklist on each.' });

  // 6. At least one prompt that goes beyond recall.
  checks.push(has('think') || has('reflection')
    ? { id: 'think', status: 'pass', title: 'The pack stretches beyond recall', detail: 'A thinking prompt or a reflection task is present.' }
    : { id: 'think', status: 'warn', title: 'Nothing goes beyond recall', detail: 'Add a thinking prompt or a reflection task.' });

  // 7. Data that cannot be drawn coherently.
  const brokenQuiz = allBlocks.filter(b => b.type === 'quiz'
    && b.questions.some(q => !(q.correct >= 0 && q.correct < (q.options?.length ?? 0)))).length;
  const brokenTable = allBlocks.filter(b => b.type === 'table'
    && b.rows.some(r => r.cells.length !== b.headers.length)).length;
  const brokenChart = allBlocks.filter(b => b.type === 'chart'
    && b.series.some(s => !Number.isFinite(s.value))).length;
  const broken = brokenQuiz + brokenTable + brokenChart;
  checks.push(broken
    ? { id: 'data', status: 'block', title: 'A block cannot be drawn', detail: `${brokenQuiz} quiz, ${brokenTable} table, ${brokenChart} chart block(s) hold inconsistent data.` }
    : { id: 'data', status: 'pass', title: 'Quizzes, tables and charts are coherent', detail: 'Answer indexes, row widths and values all check out.' });

  // 8. No fabricated links. A pack built from the registry never had a document to
  //    quote a URL from, so any URL on one was written by the model.
  const urls = allBlocks.flatMap(b =>
    b.type === 'resources' ? b.groups.flatMap(g => g.items.map(i => i.url))
      : b.type === 'think' ? [b.resource_url] : [],
  ).filter((u): u is string => !!u);
  // 0014 is applied by hand, so source_kind may not exist on this row yet. The
  // content is self-describing about where its objectives came from, so provenance
  // leads and the column is only a corroborating hint.
  const fromDocument = pack?.source_kind === 'document'
    || objectives.some(o => o.source !== 'registry');
  checks.push(
    urls.length && !fromDocument
      ? { id: 'urls', status: 'block', title: 'The pack carries invented links', detail: `${urls.length} url(s) on a pack built from the curriculum, which had no document to quote them from.` }
      : urls.length
        ? { id: 'urls', status: 'warn', title: 'Links came from the uploaded file', detail: `${urls.length} url(s) were copied from the teacher's document. Open each one before sharing.` }
        : { id: 'urls', status: 'pass', title: 'No invented links', detail: 'Resources are named, not linked.' },
  );

  return {
    checks,
    blocking: checks.filter(c => c.status === 'block').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    passed: checks.filter(c => c.status === 'pass').length,
  };
}
