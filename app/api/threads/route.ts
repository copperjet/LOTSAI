import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * GET  /api/threads          — the teacher's recent threads, newest first
 * POST /api/threads          — start one, returns its id
 *
 * A thread is one person's conversation with LOTS AI, saved so it survives the tab.
 * Before this the thread lived only in browser memory: turns were React elements,
 * which cannot be serialised, so one conversation grew for as long as the tab was
 * open and nothing could be returned to. Turns are data now (app/page.tsx, `Turn`),
 * which is what made this possible at all.
 *
 * Degrades to nothing if migration 0015 has not been applied: the rail shows no
 * Recent list and the thread behaves exactly as it did before. Migrations are applied
 * by hand here, and the product must not stop working between writing one and running
 * it.
 */

/** How many threads the rail offers. Enough to find this week's work in. */
const RECENT = 15;

export async function GET() {
  const user = await currentUser();
  try {
    const { data, error } = await admin().from('chat_thread')
      .select('id, title, updated_at')
      .eq('user_id', user.id).eq('archived', false)
      .order('updated_at', { ascending: false }).limit(RECENT);
    if (error) throw error;
    return NextResponse.json({ threads: data ?? [] });
  } catch {
    return NextResponse.json({ threads: [] });
  }
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  const { title } = await req.json().catch(() => ({ title: null }));
  try {
    const { data, error } = await admin().from('chat_thread')
      .insert({ user_id: user.id, title: title || 'New task' })
      .select('id, title').single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch {
    // No table yet. The client carries on with an unsaved thread rather than failing.
    return NextResponse.json({ id: null, title: title || 'New task' });
  }
}
