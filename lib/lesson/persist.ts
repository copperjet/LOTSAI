/**
 * Writing a lesson to the bank, reading one back, and describing one to the UI.
 *
 * Migrations here are applied by hand in the Supabase SQL editor, so a
 * deployment routinely runs code that is one migration ahead of its database
 * (CONTINUE_HERE.md). 0028 will be written and unapplied for a while, and
 * everything in this file is built for that gap: an insert that hits a missing
 * table says so in a word the UI can translate, and a read that hits one answers
 * null rather than throwing. The precedent is lib/studypack/persist.ts, which
 * learned it the hard way with 0014.
 */
import { admin } from '@/lib/supabase';
import { ALL_CLASSES_ROLES, REVIEWER_ROLES } from '@/lib/admin';
import type { PackObjective } from '@/lib/studypack/schema';
import type { LessonDeck } from './schema';
import { PHASE_LABEL } from './schema';
import { hasStudentBlock, hasVisualBlock } from './repair';

/** What a caller gets when the table is not there yet. */
export const LESSON_UNAVAILABLE = 'lesson_unavailable';

export interface LessonRow {
  author_id: string;
  class_id: string | null;
  subject_id: string;
  year_group: string;
  academic_year: string;
  semester: number | null;
  week_number: number | null;
  topic: string;
  subtopic: string | null;
  duration_minutes: number;
  approach: string | null;
  title: string;
  content: LessonDeck;
  objective_refs: string[];
  objective_sources: PackObjective[];
  work_key: string;
  theme: string;
  status: string;
  source_upload_id: string | null;
}

/** The columns 0028 adds beyond the obvious ones, dropped if it is unapplied. */
const NEWER_COLUMNS = ['objective_sources', 'source_upload_id', 'approach', 'theme'] as const;

function isMissingColumn(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST204' || error.code === '42703'
    || /could not find the '.*' column|column .* does not exist/i.test(error.message ?? '');
}

function isMissingTable(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST205' || error.code === '42P01'
    || /could not find the table|relation .* does not exist/i.test(error.message ?? '');
}

export async function insertLesson(row: LessonRow): Promise<{ id: string } | null> {
  const db = admin();
  const full = await db.from('lesson').insert(row).select('id').single();
  if (!full.error) return full.data;

  if (isMissingTable(full.error)) {
    console.error('[lesson] the lesson table does not exist - migration 0028 has not been applied.');
    return null;
  }
  if (!isMissingColumn(full.error)) {
    console.error(`[lesson] insert failed: ${full.error.message}`);
    return null;
  }

  // A partial 0028. Store what the database will take; `content` is
  // self-describing and carries everything the renderers actually branch on.
  console.warn('[lesson] the lesson table is missing some 0028 columns; storing without them.');
  const bare = { ...row } as Record<string, unknown>;
  for (const c of NEWER_COLUMNS) delete bare[c];
  const retry = await db.from('lesson').insert(bare).select('id').single();
  if (retry.error) {
    console.error(`[lesson] insert failed: ${retry.error.message}`);
    return null;
  }
  return retry.data;
}

export interface StoredLesson {
  id: string;
  author_id: string;
  class_id: string | null;
  subject_id: string;
  year_group: string;
  academic_year: string;
  week_number: number | null;
  title: string;
  content: LessonDeck;
  status: string;
  approved: boolean;
  work_key: string | null;
  storage_path: string | null;
  pptx_path: string | null;
  render_note: string | null;
  drive_link: string | null;
  reuse_count: number;
  updated_at: string | null;
}

/** Read one lesson. Null when it is not there; null when the table is not there. */
export async function readLesson(id: string): Promise<StoredLesson | null> {
  try {
    const { data, error } = await admin().from('lesson')
      .select('id, author_id, class_id, subject_id, year_group, academic_year, week_number, '
        + 'title, content, status, approved, work_key, storage_path, pptx_path, render_note, '
        + 'drive_link, reuse_count, updated_at')
      .eq('id', id).maybeSingle();
    if (error || !data) return null;
    return data as unknown as StoredLesson;
  } catch {
    return null;
  }
}

/**
 * Write a changed deck back.
 *
 * The title and the objective references are derived from the deck rather than
 * passed in, because a teacher who edits the first slide's title has changed the
 * lesson's name, and a teacher who deletes the only slide addressing an
 * objective has changed what it covers. Keeping the columns in step with
 * `content` is what stops the bank offering a lesson for objectives it no longer
 * teaches.
 */
export async function saveDeck(
  id: string, deck: LessonDeck, extra: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const { error } = await admin().from('lesson').update({
      content: deck,
      title: deck.title,
      objective_refs: deck.objective_refs,
      duration_minutes: deck.meta.duration_minutes,
      updated_at: new Date().toISOString(),
      ...extra,
    }).eq('id', id);
    if (error) {
      console.error(`[lesson] save failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[lesson] save failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Keep a copy of the deck as it was, before this change.
 *
 * The same contract as study_pack_revision: revision 1 is the deck as it was
 * generated, and every revision after it is what the deck looked like before
 * the instruction that produced the next one. That ordering is what makes
 * "revert to 2" mean something. Silent on failure: a teacher's edit must not be
 * refused because the history table is missing.
 */
export async function snapshot(
  lessonId: string, deck: LessonDeck, instruction: string | null, authorId: string,
): Promise<number | null> {
  try {
    const db = admin();
    const { data } = await db.from('lesson_revision')
      .select('n').eq('lesson_id', lessonId).order('n', { ascending: false }).limit(1).maybeSingle();
    const n = (data?.n ?? 0) + 1;
    const { error } = await db.from('lesson_revision').insert({
      lesson_id: lessonId, n, content: deck, instruction, author_id: authorId,
    });
    if (error) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * A snapshot, unless one was taken in the last few minutes.
 *
 * For the small edits - retyping a bullet, fixing a title - where a copy of the
 * whole deck per keystroke-and-blur would fill the history with near-identical
 * rows and bury the one worth going back to. A burst of editing gets one restore
 * point at its start, which is the point a teacher who regrets it wants.
 */
export async function snapshotIfStale(
  lessonId: string, deck: LessonDeck, instruction: string, authorId: string, minutes = 3,
): Promise<number | null> {
  try {
    const { data } = await admin().from('lesson_revision')
      .select('created_at').eq('lesson_id', lessonId)
      .order('n', { ascending: false }).limit(1).maybeSingle();
    const last = data?.created_at ? new Date(data.created_at as string).getTime() : 0;
    if (Date.now() - last < minutes * 60_000) return null;
  } catch {
    /* no history table: snapshot() below will fail quietly as well */
  }
  return snapshot(lessonId, deck, instruction, authorId);
}

/**
 * Who may open a lesson, and who may change it.
 *
 * The same rule a planner follows (app/api/plan/open): one teacher's own work
 * until somebody else needs it, and anyone who can see every class may read it.
 * The difference is approval - once a lesson is approved it is in the bank, and
 * the point of a bank is that a colleague can open what is in it.
 *
 * Seeing every class is deliberately wider than being able to change somebody
 * else's teaching, which is why reading takes ALL_CLASSES_ROLES and writing
 * takes REVIEWER_ROLES (lib/admin.ts says why those two differ).
 */
export function mayRead(row: StoredLesson, user: { id: string; role: string }): boolean {
  return row.approved || row.author_id === user.id || ALL_CLASSES_ROLES.includes(user.role);
}

export function mayEdit(row: StoredLesson, user: { id: string; role: string }): boolean {
  return row.author_id === user.id || REVIEWER_ROLES.includes(user.role);
}

/**
 * The shape every lesson route returns to the UI.
 *
 * Deliberately not the whole deck: the chat card needs to say what was built and
 * how long it runs, and shipping twenty slides of content into a chat turn that
 * is then saved into chat_turn as JSON would put a lesson in every thread.
 */
export function lessonSummary(deck: LessonDeck) {
  const slides = deck.slides ?? [];
  return {
    title: deck.title,
    subtitle: deck.subtitle,
    theme: deck.theme,
    slides: slides.length,
    minutes: slides.reduce((n, s) => n + s.minutes, 0),
    duration: deck.meta.duration_minutes,
    studentSlides: slides.filter(hasStudentBlock).length,
    visualSlides: slides.filter(hasVisualBlock).length,
    questions: (deck.assessment ?? []).length,
    refs: deck.objective_refs ?? [],
    objectives: (deck.objectives ?? []).map(o => ({ ref: o.ref, text: o.text, source: o.source })),
    timing: (deck.timing ?? []).map(t => ({ label: t.label, minutes: t.minutes })),
    outline: slides.map(s => ({
      id: s.id,
      title: s.title,
      phase: PHASE_LABEL[s.phase] ?? s.phase,
      minutes: s.minutes,
      audience: s.audience,
    })),
  };
}

export type LessonSummary = ReturnType<typeof lessonSummary>;
