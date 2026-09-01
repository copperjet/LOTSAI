import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * GET /api/threads/<id>   — a saved thread, in the order it was said
 * PUT /api/threads/<id>   — { turns?, title?, archived? }
 *
 * PUT replaces the thread's turns rather than appending. The client holds the whole
 * conversation in state and is the only writer, so a replace cannot lose a turn to a
 * race the way an append could - and a thread is tens of rows, not thousands.
 *
 * Ownership is checked here as well as in RLS: these routes go through the service
 * key, so the policy in migration 0015 is not what is protecting them.
 */

/** A thread longer than this is not a thread any more. Keeps one runaway conversation
 *  from becoming a row nobody can load. */
const MAX_TURNS = 400;

interface StoredTurn { who: 'user' | 'ai'; kind?: string | null; data?: Record<string, unknown> }

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  const { id } = await ctx.params;
  const db = admin();

  try {
    const { data: thread } = await db.from('chat_thread')
      .select('id, title, user_id').eq('id', id).single();
    if (!thread || thread.user_id !== user.id) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const { data: turns } = await db.from('chat_turn')
      .select('who, kind, data').eq('thread_id', id).order('seq');

    return NextResponse.json({
      id: thread.id, title: thread.title,
      turns: (turns ?? []).map(t => t.who === 'user'
        ? { who: 'user', text: String((t.data as { text?: string })?.text ?? '') }
        : { who: 'ai', kind: t.kind, data: t.data }),
    });
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  const { id } = await ctx.params;
  const body = await req.json() as { turns?: StoredTurn[]; title?: string; archived?: boolean };
  const db = admin();

  try {
    const { data: thread } = await db.from('chat_thread').select('id, user_id').eq('id', id).single();
    if (!thread || thread.user_id !== user.id) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 120);
    if (typeof body.archived === 'boolean') patch.archived = body.archived;
    await db.from('chat_thread').update(patch).eq('id', id);

    if (body.turns) {
      await db.from('chat_turn').delete().eq('thread_id', id);
      const rows = body.turns.slice(0, MAX_TURNS).map((t, seq) => ({
        thread_id: id, seq, who: t.who,
        kind: t.who === 'ai' ? (t.kind ?? null) : null,
        data: t.data ?? {},
      }));
      if (rows.length) await db.from('chat_turn').insert(rows);
    }

    return NextResponse.json({ ok: true });
  } catch {
    // Pre-0015, or a write that lost: the conversation on screen is unaffected.
    return NextResponse.json({ ok: false });
  }
}
