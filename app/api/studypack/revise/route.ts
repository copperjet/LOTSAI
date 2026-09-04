import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import * as engine from '@/lib/engine';
import { storeArtefact } from '@/lib/pdf/store';
import { viewUrl } from '@/lib/artefactUrl';
import { reviseStudyPack } from '@/lib/studypack/revise';
import { listAssets } from '@/lib/studypack/assets';
import { gateStudyPackV2 } from '@/lib/studypack/gate';
import type { PackV2 } from '@/lib/studypack/schema';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/studypack/revise
 *   { studyPackId, instruction, material? }   - change the pack
 *   { studyPackId, revertTo: n }              - put it back to revision n
 *
 * The teacher's way of saying "shorten the glossary on page 4" or "add two harder
 * questions to page 6" about a pack that already exists. Before this, the only way to
 * change one word of a pack was to build the whole thing again as a new row.
 *
 * Every version is kept (`study_pack_revision`), including the pack as generated, so
 * a change can always be undone. `study_pack.content` stays the current version and
 * everything that reads a pack reads it unchanged.
 *
 * The founding rule is not touched here. A revision writes blocks; the objective list
 * and every page's objective_indexes are carried over from the stored pack, and the
 * gate runs on the result exactly as it runs on a generated one
 * (lib/studypack/revise.ts).
 */

/** The pack, its revision history, and whether this person may change it. */
async function load(studyPackId: string, userId: string, role: string) {
  const db = admin();
  const { data: pack } = await db.from('study_pack')
    .select('id, content, author_id, status, approved, title')
    .eq('id', studyPackId).maybeSingle();
  if (!pack) return { error: 'Unknown study pack', status: 404 as const };

  const isReviewer = ['hod', 'coordinator', 'principal', 'admin'].includes(role);
  if (pack.author_id !== userId && !isReviewer) {
    return { error: 'Only the pack’s author can change it', status: 403 as const };
  }

  // Approval sent this pack to the school's Drive and entered it in the shared bank.
  // Changing it underneath both would leave a document in a folder that no longer
  // matches the one in the application, which is the failure the planner refuses for
  // a signed-off week (app/api/plan/generate/route.ts).
  if (pack.approved) {
    return {
      error: 'approved',
      status: 400 as const,
      message: 'This pack has been approved and sent to the school Drive, so it cannot be '
        + 'changed. Make a new one for the changes you want.',
    };
  }

  if (Number((pack.content as { version?: unknown })?.version) !== 2) {
    return {
      error: 'not_v2',
      status: 400 as const,
      message: 'This pack was built before changes could be made to one. Build a new pack to change it.',
    };
  }

  return { pack };
}

/**
 * Write the new content, keep the old one, and re-render.
 *
 * Revision 1 is backfilled the first time a pack is changed: it is the pack as
 * generated, and without it the one version that could never be returned to is the
 * original. Pre-0017 the whole trail is skipped rather than failing the change - the
 * teacher gets their revision, they just cannot undo it yet.
 */
async function commit(o: {
  studyPackId: string; before: PackV2; after: PackV2;
  instruction: string | null; revertedFrom?: number | null; userId: string;
}): Promise<{ revision: number | null }> {
  const db = admin();
  let revision: number | null = null;

  // supabase-js reports a missing relation in `error` rather than by throwing, so a
  // try/catch around this sees nothing. Without checking it, a pre-0017 database
  // reported "saved as version 2" and offered an Undo for a row that was never
  // written - the one failure mode a version history must not have.
  try {
    const { data: last, error: read } = await db.from('study_pack_revision')
      .select('n').eq('study_pack_id', o.studyPackId).order('n', { ascending: false }).limit(1);
    if (read) throw new Error(read.message);

    let n = (last?.[0]?.n as number | undefined) ?? 0;

    if (n === 0) {
      const { error } = await db.from('study_pack_revision').insert({
        study_pack_id: o.studyPackId, n: 1, content: o.before,
        instruction: null, author_id: o.userId,
      });
      if (error) throw new Error(error.message);
      n = 1;
    }

    const next = n + 1;
    const { error } = await db.from('study_pack_revision').insert({
      study_pack_id: o.studyPackId, n: next, content: o.after,
      instruction: o.instruction, reverted_from: o.revertedFrom ?? null, author_id: o.userId,
    });
    if (error) throw new Error(error.message);
    revision = next;
  } catch (e) {
    // Pre-0017: the change still happens, the trail does not - and the teacher is
    // told a version number of null rather than one that cannot be returned to.
    console.error(`[studypack-revise] no revision history (apply migration 0017): `
      + `${e instanceof Error ? e.message : String(e)}`);
    revision = null;
  }

  await db.from('study_pack').update({ content: o.after }).eq('id', o.studyPackId);
  return { revision };
}

/**
 * Re-render the pack's HTML in place, and drop the PDF beside it.
 *
 * Same path, so a tab the teacher already has open shows the new version on reload.
 * The stored PDF is now a rendering of a pack that no longer exists, and it is
 * rendered on demand anyway, so it is cleared rather than left to be handed out.
 */
async function rerender(studyPackId: string): Promise<string | null> {
  const { standard } = await engine.resolveWorkflow('study_pack');
  const stored = await storeArtefact(standard, studyPackId);

  try {
    await admin().storage.from('artefacts').remove([`study_pack/${studyPackId}.pdf`]);
    await admin().from('study_pack').update({ render_note: null }).eq('id', studyPackId);
  } catch { /* no PDF had been made, or pre-0015 */ }

  return stored.ok ? viewUrl('studypack-html', studyPackId) : null;
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  const body = await req.json();
  const studyPackId = String(body?.studyPackId ?? '');
  if (!studyPackId) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });

  const found = await load(studyPackId, user.id, user.role);
  if ('error' in found) {
    return NextResponse.json(
      { error: found.error, message: found.message }, { status: found.status },
    );
  }
  const before = found.pack.content as PackV2;

  // ---- put it back ---------------------------------------------------------
  if (body?.revertTo != null) {
    const n = Number(body.revertTo);
    const { data: row } = await admin().from('study_pack_revision')
      .select('content').eq('study_pack_id', studyPackId).eq('n', n).maybeSingle();
    if (!row) {
      return NextResponse.json({
        error: 'no_revision',
        message: `There is no version ${n} of this pack to go back to.`,
      }, { status: 404 });
    }

    const after = row.content as PackV2;
    const { revision } = await commit({
      studyPackId, before, after, instruction: `Put back to version ${n}.`,
      revertedFrom: n, userId: user.id,
    });
    const url = await rerender(studyPackId);
    await audit(user.id, 'studypack.revert', 'study_pack', studyPackId);

    return NextResponse.json({
      ok: true, revision, url,
      note: `Put back to version ${n}.`,
      changed: [],
    });
  }

  // ---- change it -----------------------------------------------------------
  const instruction = String(body?.instruction ?? '').trim();
  if (!instruction) return NextResponse.json({ error: 'instruction required' }, { status: 400 });

  const assets = await listAssets(studyPackId);

  let result;
  try {
    result = await reviseStudyPack(
      { pack: before, instruction, material: body?.material ?? null, assets },
      user.id,
    );
  } catch (e) {
    console.error(`[studypack-revise] ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({
      error: 'revise_failed',
      message: 'I could not make that change just now. Nothing has been altered - try again in a moment.',
    }, { status: 502 });
  }

  // Nothing to write. The model said why; say it and leave the pack alone rather
  // than storing a revision identical to the one before it.
  if (!result.changedPageIds.length) {
    return NextResponse.json({ ok: true, changed: [], note: result.note, revision: null, url: null });
  }

  const { revision } = await commit({
    studyPackId, before, after: result.content, instruction, userId: user.id,
  });

  // The gate runs on the revised pack, not on the change. A revision can make a page
  // too long or leave a page stating no objective just as a generation can, and the
  // teacher should hear about it in the same words.
  let checks: unknown[] = [];
  try {
    const gate = await gateStudyPackV2(studyPackId);
    checks = (gate as { checks?: unknown[] })?.checks ?? [];
  } catch (e) {
    console.error(`[studypack-revise] gate failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const url = await rerender(studyPackId);
  await audit(user.id, 'studypack.revise', 'study_pack', studyPackId);

  return NextResponse.json({
    ok: true, revision, url, checks,
    note: result.note,
    changed: result.changedPageIds,
    // The sheet numbers the teacher sees, so the reply can name the pages that moved.
    pages: result.changedPageIds
      .map(id => result.content.pages.findIndex(p => p.id === id))
      .filter(i => i >= 0).map(i => i + 2),
  });
}

/** GET /api/studypack/revise?studyPackId=<id> - the versions of this pack. */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  const id = req.nextUrl.searchParams.get('studyPackId');
  if (!id) return NextResponse.json({ error: 'studyPackId required' }, { status: 400 });

  const found = await load(id, user.id, user.role);
  // An approved pack cannot be changed but its history is still worth reading.
  if ('error' in found && found.status !== 400) {
    return NextResponse.json({ error: found.error }, { status: found.status });
  }

  try {
    const { data } = await admin().from('study_pack_revision')
      .select('n, instruction, created_at').eq('study_pack_id', id).order('n');
    return NextResponse.json({ revisions: data ?? [] });
  } catch {
    return NextResponse.json({ revisions: [] });   // pre-0017
  }
}
