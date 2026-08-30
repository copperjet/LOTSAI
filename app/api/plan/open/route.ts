import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * GET /api/plan/open?plannerId=…
 *
 * Read a planner that already exists, in the shape /api/plan/generate returns,
 * so the same card renders it.
 *
 * This route exists because generation is destructive: it upserts the planner
 * and deletes its lesson rows, which takes the teacher's edits and — through
 * the cascade on lesson_entry — their evaluations with them. Anything that
 * lands on a week that has already been planned must come here instead.
 */
export async function GET(req: NextRequest) {
  const db = admin();
  const user = await currentUser();
  const plannerId = req.nextUrl.searchParams.get('plannerId');
  if (!plannerId) return NextResponse.json({ error: 'plannerId required' }, { status: 400 });

  const { data: planner } = await db.from('planner')
    .select('id, status, origin, teacher_id, class_id').eq('id', plannerId).maybeSingle();
  if (!planner) return NextResponse.json({ error: 'Unknown planner' }, { status: 404 });

  // A teacher sees their own; an HOD sees any, because reviewing is their job.
  if (planner.teacher_id !== user.id && user.role !== 'hod') {
    return NextResponse.json({ error: 'Not yours to open' }, { status: 403 });
  }

  const { data: lessons } = await db.from('lesson_entry')
    .select('*').eq('planner_id', plannerId).order('position');

  const { data: gate } = await db.from('gate_result')
    .select('checks, blocking, warnings').eq('planner_id', plannerId)
    .order('ran_at', { ascending: false }).limit(1).maybeSingle();

  return NextResponse.json({
    plannerId: planner.id,
    mode: planner.origin ?? 'create',
    status: planner.status,
    lessons: lessons ?? [],
    // Never null: the card reads gate.passed directly, and a planner from
    // before the gate existed would otherwise take the page down.
    gate: gate
      ? { ...gate, passed: (gate.checks as { status: string }[]).filter(c => c.status === 'pass').length }
      : { checks: [], blocking: 0, warnings: 0, passed: 0 },
    usage: null,
  });
}
