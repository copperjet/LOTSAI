import { NextResponse } from 'next/server';
import { admin, currentUser, NOT_SIGNED_IN } from '@/lib/supabase';
import { evaluationWindowStart } from '@/lib/evaluation';

export const runtime = 'nodejs';

/**
 * GET /api/agenda
 *
 * Two views of the same facts, from the same queries.
 *
 * `items` is what is outstanding, most urgent first. The opening sentence is
 * composed from it (Addendum D section D5.2): anything overdue leads and owns
 * the primary action, because late work is late whether or not the reader opens
 * a fold.
 *
 * `today` is the standing list in the corner of the screen. Every task in it is
 * derived, and so is every tick — a planner is ticked because it is submitted,
 * not because somebody ticked it (Addendum A section A2, "derive, don't
 * collect"). Nothing here is stored, so nothing here can disagree with the
 * database.
 */

interface AgendaItem {
  id: string; kind: 'late' | 'due' | 'done';
  lead: string; also?: string; act: string; q?: string; alt: string;
  intent: string; payload?: Record<string, unknown>;
  title: string; note: string; when: string;
}

interface TodayTask {
  id: string; label: string; note: string; done: boolean;
  intent?: string; payload?: Record<string, unknown>;
}

const DONE_STATUSES = ['submitted', 'reviewed', 'approved'];

export async function GET() {
  const db = admin();

  let user;
  try {
    user = await currentUser();
  } catch (e) {
    if (e instanceof Error && e.message === NOT_SIGNED_IN) {
      return NextResponse.json({ error: NOT_SIGNED_IN }, { status: 401 });
    }
    throw e;
  }
  const today = new Date().toISOString().slice(0, 10);

  const items: AgendaItem[] = [];
  const tasks: TodayTask[] = [];

  if (user.role === 'teacher') {
    const { data: classes } = await db.from('klass')
      .select('*, subject:subject_id(name)').eq('teacher_id', user.id);

    // Lessons already taught with no note against them, within the window that is
    // still worth writing one for (lib/evaluation.ts). Unbounded, this was a term of
    // history that could never be cleared.
    const since = await evaluationWindowStart(today);
    const { data: taught } = await db.from('lesson_entry')
      .select('id, planner!inner(teacher_id)')
      .eq('planner.teacher_id', user.id).lte('lesson_date', today).gte('lesson_date', since);
    const ids = (taught ?? []).map(l => l.id);
    const { data: done } = ids.length
      ? await db.from('evaluation').select('lesson_entry_id').in('lesson_entry_id', ids)
      : { data: [] };
    const outstanding = ids.length - new Set((done ?? []).map(e => e.lesson_entry_id)).size;

    if (outstanding > 0) items.push({
      id: 'evaluate', kind: 'late',
      lead: `${outstanding} lesson${outstanding === 1 ? '' : 's'} ${outstanding === 1 ? 'is' : 'are'} still unevaluated`,
      also: `${outstanding} lesson${outstanding === 1 ? '' : 's'} ${outstanding === 1 ? 'is' : 'are'} also still unevaluated`,
      act: 'Evaluate them', alt: 'Do the evaluations first', intent: 'evaluate',
      title: `${outstanding} lessons taught, not evaluated`,
      note: 'About thirty seconds each', when: 'Overdue',
    });

    tasks.push({
      id: 'evaluate',
      label: 'Evaluate the lessons already taught',
      note: outstanding > 0
        ? `${outstanding} still waiting, about thirty seconds each`
        : 'Every taught lesson has a note against it',
      done: outstanding === 0,
      intent: 'evaluate',
    });

    // The next teaching week without a planner.
    const { data: nextWeek } = await db.from('school_week').select('*')
      .eq('academic_year', '2026-27').eq('week_type', 'teaching')
      .gte('week_commencing', today).order('week_commencing').limit(1).maybeSingle();

    if (nextWeek) {
      // One query for every class, rather than one per class inside the loop.
      const classIds = (classes ?? []).map(k => k.id);
      const { data: planners } = classIds.length
        ? await db.from('planner').select('id, class_id, status')
            .in('class_id', classIds).eq('school_week', nextWeek.id)
        : { data: [] };
      const byClass = new Map((planners ?? []).map(p => [p.class_id, p]));

      const firstUnplanned = (classes ?? []).find(k => !byClass.has(k.id));
      if (firstUnplanned) items.push({
        id: `plan-${firstUnplanned.id}`, kind: 'due',
        lead: `Week ${nextWeek.week_number} for ${firstUnplanned.name} is due Friday`,
        also: `Week ${nextWeek.week_number} is also due Friday`,
        act: 'Start it', q: 'Shall I start it?', alt: `Plan Week ${nextWeek.week_number} first`,
        // The semester travels with the week number, because both semesters have a
        // week 1 and the registry is keyed on the pair.
        intent: 'plan',
        payload: { classId: firstUnplanned.id, weekNumber: nextWeek.week_number, semester: nextWeek.semester },
        title: `${firstUnplanned.name} - Week ${nextWeek.week_number} planner`,
        note: 'Not started. Due Friday, before the week begins.', when: 'Due Fri',
      });

      for (const k of classes ?? []) {
        const status = byClass.get(k.id)?.status ?? null;
        tasks.push({
          id: `plan-${k.id}`,
          label: `Week ${nextWeek.week_number} planner - ${k.name}`,
          note: status === null ? 'Not started. Due Friday.'
              : status === 'draft' ? 'Drafted, not submitted yet'
              : status === 'returned' ? 'Returned by your HOD'
              : status === 'approved' ? 'Approved'
              : status === 'reviewed' ? 'Reviewed'
              : 'Submitted for review',
          done: !!status && DONE_STATUSES.includes(status),
          intent: 'plan',
          payload: { classId: k.id, weekNumber: nextWeek.week_number, semester: nextWeek.semester },
        });
      }
    }

    // Anything the HOD sent back. A planner returned earlier today stays in the
    // list once it has been fixed, so the teacher sees it tick rather than sees
    // it disappear.
    const { data: returnedNow } = await db.from('planner')
      .select('id, status, class_id').eq('teacher_id', user.id).eq('status', 'returned');
    const { data: returnedEarlier } = await db.from('hod_review')
      .select('planner_id, planner:planner_id(id, status, class_id, teacher_id)')
      .eq('decision', 'returned').gte('reviewed_at', today);

    const returned = new Map<string, { id: string; status: string; class_id: string }>();
    for (const p of returnedNow ?? []) returned.set(p.id, p);
    for (const r of returnedEarlier ?? []) {
      const p = r.planner as unknown as { id: string; status: string; class_id: string; teacher_id: string } | null;
      if (p && p.teacher_id === user.id) returned.set(p.id, { id: p.id, status: p.status, class_id: p.class_id });
    }

    for (const p of returned.values()) {
      const k = (classes ?? []).find(c => c.id === p.class_id);
      tasks.push({
        id: `fix-${p.id}`,
        label: `Fix the returned planner${k ? ` - ${k.name}` : ''}`,
        note: p.status === 'returned' ? 'Your HOD sent it back with a comment' : 'Fixed and sent back',
        done: p.status !== 'returned',
      });
    }

    items.push({
      id: 'bank', kind: 'done',
      lead: 'Nothing is outstanding - next week’s drafts are already waiting',
      act: 'See what your year group has made', alt: 'See the shared bank', intent: 'bank',
      title: 'Shared bank', note: 'Everything your colleagues have had approved', when: 'Live',
    });
  } else {
    const { data: queue } = await db.from('planner')
      .select('id, klass:class_id(name), app_user:teacher_id(full_name)').eq('status', 'submitted');

    const { data: unsigned } = await db.from('curriculum_week')
      .select('year_group, subject_id').is('signed_off_at', null).limit(200);
    const blocked = new Set((unsigned ?? []).map(r => `${r.year_group} ${r.subject_id}`));

    if (blocked.size) items.push({
      id: 'registry', kind: 'late',
      lead: `${blocked.size} subject${blocked.size === 1 ? '' : 's'} ${blocked.size === 1 ? 'is' : 'are'} waiting on your curriculum sign-off`,
      also: `${blocked.size} subject${blocked.size === 1 ? '' : 's'} still need your curriculum sign-off`,
      act: 'Resolve them', alt: 'Sort the curriculum first', intent: 'registry',
      title: `${blocked.size} subjects not signed off`,
      note: 'Nobody can plan these until you sign them off', when: 'Blocking',
    });

    if (queue?.length) items.push({
      id: 'review', kind: 'due',
      lead: `${queue.length} planner${queue.length === 1 ? '' : 's'} ${queue.length === 1 ? 'is' : 'are'} waiting for you`,
      also: `${queue.length} planner${queue.length === 1 ? '' : 's'} ${queue.length === 1 ? 'is' : 'are'} also waiting`,
      act: 'Open it', q: 'Shall I open it?', alt: 'Review the planner first', intent: 'review',
      title: `${queue.length} planners awaiting review`,
      note: 'Checks already done', when: 'Today',
    });

    tasks.push({
      id: 'review',
      label: 'Review the submitted planners',
      note: queue?.length
        ? `${queue.length} waiting, checks already done`
        : 'The queue is clear',
      done: !queue?.length,
      intent: 'review',
    });

    tasks.push({
      id: 'registry',
      label: 'Sign off the curriculum',
      note: blocked.size
        ? `${blocked.size} subject${blocked.size === 1 ? '' : 's'} still blocking planning`
        : 'Every subject is signed off',
      done: blocked.size === 0,
      intent: 'registry',
    });

    items.push({
      id: 'coverage', kind: 'done',
      lead: 'Coverage is current and nothing is outstanding',
      act: 'See coverage', alt: 'See coverage', intent: 'coverage',
      title: 'Coverage', note: 'Computed from planners and evaluations', when: 'Live',
    });
  }

  return NextResponse.json({
    user: { name: user.full_name, role: user.role },
    items,
    today: tasks,
    date: today,
  });
}
