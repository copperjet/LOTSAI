/**
 * Search before generate, for lessons.
 *
 * No model call. The bank only ever offers work a named human approved
 * (Addendum B), and the index is exact because objective references are a
 * controlled vocabulary read out of the registry rather than written by a model
 * (lib/workkey.ts). Two teachers taking the same class through the same week
 * should not pay twice for the same lesson, and the one who goes second should
 * see what the one who went first had signed off.
 *
 * The duration is part of the key, which the other artefacts do not need: the
 * same objectives taught in forty minutes and in eighty minutes are two
 * different lessons, and offering one as a reuse of the other would hand a
 * teacher a deck that cannot fit their period.
 */
import { admin } from '@/lib/supabase';
import { overlap, workKey } from '@/lib/workkey';

export function lessonWorkKey(p: {
  subjectId: string; yearGroup: string; academicYear: string;
  weekNumber: number | null; refs: string[]; durationMinutes: number; topic: string;
}): string {
  const base = workKey({
    artefactType: 'lesson',
    subjectId: p.subjectId,
    yearGroup: p.yearGroup,
    academicYear: p.academicYear,
    // A lesson need not sit in a signed-off week - a teacher can build one for a
    // topic. Week 0 is how "no week" is spelled, so the key stays one shape.
    weekNumber: p.weekNumber ?? 0,
    refs: p.refs,
  });
  // A lesson with no objective references would otherwise key only on its
  // subject and year, and every topic in the year would collide.
  const topic = p.refs.length ? '' : `|${slug(p.topic)}`;
  return `${base}|${p.durationMinutes}m${topic}`;
}

function slug(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export interface LessonMatch {
  id: string;
  title: string;
  work_key: string | null;
  objective_refs: string[];
  week_number: number | null;
  duration_minutes: number;
  reuse_count: number;
  author_id: string;
  author: string | null;
  tier: 1 | 4;
  mode: 'reuse' | 'adapt';
  why: string;
}

/** One row as PostgREST returns it, before the cast. */
interface BankRow {
  id: string;
  title: string | null;
  work_key: string | null;
  objective_refs: string[] | null;
  week_number: number | null;
  duration_minutes: number | null;
  reuse_count: number | null;
  author_id: string;
  app_user: { full_name?: string } | null;
}

/** Tier 4 needs this much of the objective set in common, as everywhere else here. */
const ADAPT_THRESHOLD = 0.6;
/** A lesson within this many minutes of the period is close enough to adapt. */
const DURATION_SLACK = 20;

/**
 * Approved lessons for this class and week, best first.
 *
 * Wrapped, because 0028 may not be applied: a bank that cannot be read offers
 * nothing, which is the same thing it offers on the day the school has not
 * approved a lesson yet. That is the right failure - a teacher is never blocked
 * from generating because the search behind the scenes did not work.
 */
export async function findLessonMatches(
  subjectId: string, yearGroup: string, refs: string[],
  durationMinutes: number, excludeId?: string,
): Promise<LessonMatch[]> {
  try {
    const { data } = await admin().from('lesson')
      .select('id, title, work_key, objective_refs, week_number, duration_minutes, '
        + 'reuse_count, author_id, app_user:author_id(full_name)')
      .eq('subject_id', subjectId).eq('year_group', yearGroup).eq('approved', true);

    const want = [...refs].sort().join(',');

    // Cast, as every embedded-relation read in this codebase does: there is no
    // generated Database type, so PostgREST's join widens the row to a union
    // with its own error shape.
    const rows = (data ?? []) as unknown as BankRow[];

    return rows
      .filter(l => l.id !== excludeId)
      .map(l => {
        const theirs = [...(l.objective_refs ?? [])].sort().join(',');
        const sameObjectives = !!want && theirs === want;
        const sameLength = Math.abs((l.duration_minutes ?? 0) - durationMinutes) <= DURATION_SLACK;
        const exact = sameObjectives && sameLength;
        const author = (l.app_user as { full_name?: string } | null)?.full_name ?? null;
        return {
          id: l.id as string,
          title: (l.title ?? 'Untitled lesson') as string,
          work_key: (l.work_key ?? null) as string | null,
          objective_refs: (l.objective_refs ?? []) as string[],
          week_number: (l.week_number ?? null) as number | null,
          duration_minutes: (l.duration_minutes ?? 0) as number,
          reuse_count: (l.reuse_count ?? 0) as number,
          author_id: l.author_id as string,
          author,
          tier: (exact ? 1 : 4) as 1 | 4,
          mode: (exact ? 'reuse' : 'adapt') as 'reuse' | 'adapt',
          why: exact
            ? `The same objectives, for the same length of lesson${author ? `, by ${author}` : ''}`
            : `Most of the same objectives${
              sameLength ? '' : `, but written for ${l.duration_minutes} minutes`}`,
        };
      })
      .filter(l => l.tier === 1 || overlap(refs, l.objective_refs) >= ADAPT_THRESHOLD)
      .sort((a, b) => a.tier - b.tier || b.reuse_count - a.reuse_count);
  } catch {
    return [];   // 0028 not applied, or no bank yet
  }
}

/** One more teacher used this lesson. Silent on failure; it is a counter. */
export async function bumpReuse(lessonId: string): Promise<void> {
  try {
    const db = admin();
    const { data } = await db.from('lesson').select('reuse_count').eq('id', lessonId).maybeSingle();
    await db.from('lesson').update({ reuse_count: (data?.reuse_count ?? 0) + 1 }).eq('id', lessonId);
  } catch {
    /* a counter that did not increment is not worth failing a teacher's request for */
  }
}
