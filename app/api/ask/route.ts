import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/supabase';
import { askAboutSchool } from '@/lib/ask';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/ask  { question }
 *
 * What the composer falls back to when no workflow matches. It used to be a flat
 * refusal, which was wrong for anything the school's own calendar or registry
 * answers - see lib/ask.ts for where the line now sits.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  const { question } = await req.json();

  const q = String(question ?? '').trim();
  if (!q) return NextResponse.json({ error: 'question required' }, { status: 400 });

  try {
    const { kind, answer, usage } = await askAboutSchool(q, user);
    return NextResponse.json({ kind, answer, usage });
  } catch (e) {
    // A question that cannot be answered must not look like a question that was
    // refused: the boundary card is a statement about scope, and this is a fault.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[ask] ${message}`);
    return NextResponse.json({ error: 'ask_failed', message }, { status: 502 });
  }
}
