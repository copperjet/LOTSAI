import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { ADMIN_ROLES } from '@/lib/admin';
import { call } from '@/lib/llm';
import { cleanText, MAX_STORED_TEXT } from '@/lib/ingest/source';
import { kindOf, extractFile, MAX_IMAGE_BYTES } from '@/lib/ingest/extract';
import { findDuplicates, type Duplicate, type Fact } from '@/lib/knowledge';
// The same caps lib/ask.ts enforces on the grounding block. Read here so the page can
// show how much of the budget the school has used before it runs into them.
import { MAX_FACTS, MAX_FACT_CHARS } from '@/lib/ask';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET  /api/school-fact                       the live facts, the retired ones, and what they cost
 * POST /api/school-fact  action=read          text or files in, candidates back. Writes nothing.
 * POST /api/school-fact  action=check         { topic, body } in, duplicates back. No model call.
 * POST /api/school-fact  action=commit        { facts: [{topic, body, source_note, replaces?}] }
 * POST /api/school-fact  action=retire        { id }
 *
 * What the school knows about itself that no table holds: the uniform policy, who the
 * safeguarding lead is, how work is marked, when reports go home. lib/ask.ts puts these
 * in the grounding block beside the calendar and the registry, so a teacher asks in the
 * one place they already ask everything else.
 *
 * Two steps, always. `read` extracts candidate facts and hands them back; `commit`
 * writes the ones an administrator kept. Nothing reaches school_fact without a person
 * having seen it first - which is the same shape reconcile() imposes on an uploaded
 * worksheet, and for the same reason: a document is a claim until somebody accepts it.
 *
 * Every candidate is checked against what is already saved (lib/knowledge.ts) before it
 * is shown, because the thing an administrator will actually do next term is upload the
 * same handbook again. A match is reported, never resolved: replacing a policy is a
 * decision, and this route's job is to make sure it is made by a person and recorded.
 * The one thing it decides for itself is refusing a fact already saved word for word -
 * there is no reading of that where a second copy is what somebody meant.
 *
 * Administrators and the principal only. A head of department maintains their
 * curriculum; the school's own policy is not theirs to rewrite.
 */

/** Enough for a staff handbook section, not the handbook. */
const MAX_SUBMITTED = 60_000;
const MAX_FILES = 5;
const MIN_TEXT = 120;
/** More than this from one document is a sign it was split by paragraph, not by fact. */
const MAX_CANDIDATES = 25;

const YEAR = '2026-27';

interface Candidate { topic: string; body: string }

const SYSTEM = `You read a school's own document and separate it into the distinct facts it states.

A fact is one thing a teacher might ask about: the uniform rule, who to report a safeguarding
concern to, how books are marked, when reports go home, what time the school day starts.

For each one give:
  "topic" - two or three words, in the words a teacher would ask it in. "Uniform",
            "Safeguarding", "Marking policy", "Reports to parents".
  "body"  - what the document says about it, copied as closely as the sentence allows.

Rules:
- Use only what the document says. Never add a detail it does not state, never resolve
  something it leaves vague, and never write a name, date, time or figure that is not there.
- One entry per topic, not one per sentence. Everything the document says about marking is
  the marking entry, however many sentences that takes - when it is marked, what the feedback
  must contain, what does not count. Splitting one policy into "Marking frequency", "Marking
  feedback" and "Marking requirements" gives three half-answers to a teacher who asked one
  question. Follow the document's own headings where it has them.
- Split into two entries only when a section genuinely covers two different subjects that a
  teacher would ask about separately.
- Leave out anything that is not a standing fact about the school: greetings, page numbers,
  headers, signatures, "please read carefully", and anything already out of date on its face.
- Leave out anything about a named individual's role - who heads which department, who teaches
  what. The school's own staff records hold those, and a written-down copy goes stale.
- If the document states nothing that qualifies, return an empty list.

Never use an em dash or an en dash. Use a plain hyphen.`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['topic', 'body'],
        properties: { topic: { type: 'string' }, body: { type: 'string' } },
      },
    },
  },
} as const;

/** Everything live, in the shape lib/knowledge.ts compares against. Tens of rows, so
 *  it is read whole rather than queried per candidate. */
async function liveFacts(): Promise<Fact[]> {
  const { data } = await admin().from('school_fact')
    .select('id, topic, body')
    .eq('academic_year', YEAR).is('retired_at', null);
  return (data ?? []) as Fact[];
}

/** 404 rather than 403: an administration endpoint should not confirm it exists. */
async function gate() {
  const user = await currentUser();
  if (!ADMIN_ROLES.includes(user.role)) return { user: null };
  return { user };
}

export async function GET() {
  const { user } = await gate();
  if (!user) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const db = admin();
  const [{ data: live }, { data: retired }] = await Promise.all([
    db.from('school_fact')
      .select('id, topic, body, source_note, added_at, app_user:added_by(full_name)')
      .eq('academic_year', YEAR).is('retired_at', null)
      .order('added_at', { ascending: false }),
    db.from('school_fact')
      .select('id, topic, body, source_note, added_at, retired_at, app_user:added_by(full_name)')
      .eq('academic_year', YEAR).not('retired_at', 'is', null)
      .order('retired_at', { ascending: false }).limit(50),
  ]);

  // Every one of these rides the cached prompt prefix on every question anybody asks,
  // so the page shows what the set costs rather than leaving it to be discovered.
  const facts = live ?? [];
  const chars = facts.reduce((n, f) => n + f.topic.length + f.body.length + 4, 0);

  return NextResponse.json({
    facts,
    retired: retired ?? [],
    budget: { facts: facts.length, chars, maxFacts: MAX_FACTS, maxChars: MAX_FACT_CHARS },
  });
}

export async function POST(req: NextRequest) {
  const { user } = await gate();
  if (!user) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const db = admin();
  const contentType = req.headers.get('content-type') ?? '';

  // ── read: files ──────────────────────────────────────────────────────────
  // Multipart is always a read - a file has never been seen by anybody at the point
  // it arrives, so there is no shape of this request that could commit.
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const files = form.getAll('file').filter((f): f is File => f instanceof File);

    if (!files.length) return NextResponse.json({ error: 'No file' }, { status: 400 });
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Up to ${MAX_FILES} files at a time.` }, { status: 413 });
    }

    // Classified before any is read, so an unsupported file fails before a model call
    // has been paid for - the same order /api/ingest/upload does it in.
    const jobs = [];
    for (const file of files) {
      const kind = kindOf(file);
      if (!kind) {
        return NextResponse.json({
          error: `${file.name} is not a kind of file I can read. Send a PDF, a Word document, or a photograph.`,
        }, { status: 415 });
      }
      if (kind === 'image' && file.size > MAX_IMAGE_BYTES) {
        return NextResponse.json({
          error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Photographs must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB - take it again at a lower resolution.`,
        }, { status: 413 });
      }
      jobs.push({ file, kind });
    }

    const texts: string[] = [];
    for (const { file, kind } of jobs) {
      try {
        texts.push(await extractFile(file, kind, user.id));
      } catch (e) {
        console.error(`[school-fact] ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        return NextResponse.json({
          error: `${file.name} could not be read. If it is a photograph, take it again in better light.`,
        }, { status: 422 });
      }
    }

    const from = files.length === 1 ? files[0].name : `${files[0].name} and ${files.length - 1} more`;
    return readCandidates(texts.join('\n\n'), from, user.id);
  }

  // ── read: pasted text, commit, retire ────────────────────────────────────
  const body = await req.json().catch(() => null) as {
    action?: unknown; text?: unknown; source_note?: unknown;
    facts?: unknown; id?: unknown; topic?: unknown; body?: unknown;
  } | null;
  const action = String(body?.action ?? 'read');

  if (action === 'read') {
    const text = cleanText(String(body?.text ?? '')).trim();
    if (text.length < MIN_TEXT) {
      return NextResponse.json({
        error: `That is ${text.length} characters. Send at least ${MIN_TEXT} - the policy itself, or the part of the handbook that states it.`,
      }, { status: 400 });
    }
    return readCandidates(text, String(body?.source_note ?? '').trim() || 'Pasted text', user.id);
  }

  // ── check: does this already exist? No model call, so the type-it-yourself form
  //    can ask on every blur without costing anything.
  if (action === 'check') {
    const candidate = {
      topic: String(body?.topic ?? '').trim(),
      body: cleanText(String(body?.body ?? '')).trim(),
    };
    if (!candidate.topic && !candidate.body) return NextResponse.json({ duplicates: [] });
    return NextResponse.json({ duplicates: findDuplicates(candidate, await liveFacts()) });
  }

  if (action === 'commit') {
    const asked = Array.isArray(body?.facts) ? body.facts as unknown[] : [];
    const wanted = asked
      .map(f => {
        const r = (f ?? {}) as Record<string, unknown>;
        return {
          topic: String(r.topic ?? '').trim().slice(0, 120),
          body: cleanText(String(r.body ?? '')).trim().slice(0, MAX_STORED_TEXT),
          source_note: String(r.source_note ?? '').trim().slice(0, 300) || null,
          // The rows this one replaces. An edit and a re-import of a changed policy are
          // the same act: the old wording is retired, not overwritten, so a teacher who
          // acted on it last term can still be shown what it said.
          replaces: Array.isArray(r.replaces) ? r.replaces.map(String).filter(Boolean) : [],
        };
      })
      .filter(r => r.topic && r.body);

    if (!wanted.length) {
      return NextResponse.json({ error: 'Nothing to save - every entry needs a topic and a body.' }, { status: 400 });
    }

    // The page checks for duplicates too; this is what makes it a guarantee rather than
    // a convenience. A fact already saved word for word is skipped whatever the caller
    // asked for - and a fact that is replacing that row is not, because the replacement
    // is the point. Within the batch as well: one paste can state the same policy twice.
    const live = await liveFacts();
    const kept: typeof wanted = [];
    const skipped: { topic: string; because: string }[] = [];

    for (const fact of wanted) {
      const against = live.filter(f => !fact.replaces.includes(f.id))
        .concat(kept.map((k, i) => ({ id: `pending-${i}`, topic: k.topic, body: k.body })));
      const same = findDuplicates(fact, against).find(d => d.reason === 'same');
      if (same) {
        skipped.push({ topic: fact.topic, because: 'already saved, word for word' });
        continue;
      }
      kept.push(fact);
    }

    if (!kept.length) {
      return NextResponse.json({ ok: true, saved: 0, skipped: skipped.length, skippedFacts: skipped, facts: [] });
    }

    const { data, error } = await db.from('school_fact').insert(kept.map(k => ({
      academic_year: YEAR,
      topic: k.topic, body: k.body, source_note: k.source_note,
      added_by: user.id,
    }))).select('id, topic');

    if (error) {
      console.error(`[school-fact] commit failed: ${error.message}`);
      return NextResponse.json({
        error: 'not_stored',
        message: 'They were read, but they could not be saved. Send them again.',
      }, { status: 500 });
    }

    // One entry each, not one saying "six". Which fact an administrator added is the
    // question a school asks later, the same way it asks who made somebody an HOD.
    const written = data ?? [];
    for (const row of written) {
      await audit(user.id, 'school_fact.add', 'school_fact', row.id, { topic: row.topic });
    }

    // Retire what each new row replaced, after the insert: a failed insert must not
    // leave the school with the old policy withdrawn and no new one in its place.
    let replaced = 0;
    for (let i = 0; i < kept.length; i++) {
      const ids = kept[i].replaces;
      if (!ids.length) continue;
      const { data: gone } = await db.from('school_fact')
        .update({ retired_at: new Date().toISOString() })
        .in('id', ids).is('retired_at', null)
        .select('id, topic');
      for (const row of gone ?? []) {
        replaced++;
        await audit(user.id, 'school_fact.supersede', 'school_fact', row.id,
          { topic: row.topic, replacedBy: written[i]?.id ?? null });
      }
    }

    return NextResponse.json({
      ok: true,
      saved: written.length,
      replaced,
      skipped: skipped.length,
      skippedFacts: skipped,
      facts: written,
    });
  }

  if (action === 'retire') {
    const id = String(body?.id ?? '');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const { data, error } = await db.from('school_fact')
      .update({ retired_at: new Date().toISOString() })
      .eq('id', id).is('retired_at', null)
      .select('id, topic').maybeSingle();

    if (error) {
      console.error(`[school-fact] retire failed: ${error.message}`);
      return NextResponse.json({ error: 'not_retired' }, { status: 500 });
    }
    // Already retired, or never existed. Either way the caller's intent holds.
    if (!data) return NextResponse.json({ ok: true, retired: 0 });

    await audit(user.id, 'school_fact.retire', 'school_fact', data.id, { topic: data.topic });
    return NextResponse.json({ ok: true, retired: 1 });
  }

  return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
}

/**
 * Split a document into candidate facts and hand them back for review.
 *
 * Small tier: this is separation, not authorship, and it is metered like every other
 * call. Nothing is written here - the id-less candidates are the whole response, and
 * an administrator posts back the ones they keep.
 */
async function readCandidates(raw: string, sourceNote: string, userId: string) {
  const text = cleanText(raw).trim().slice(0, MAX_SUBMITTED);
  if (text.length < MIN_TEXT) {
    return NextResponse.json({
      error: `Only ${text.length} characters could be read out of that. Send the policy as text, or a clearer photograph.`,
    }, { status: 422 });
  }

  const { data } = await call<{ facts: Candidate[] }>({
    tier: 'small',
    workflow: 'school_fact_read',
    userId,
    system: SYSTEM,
    // The document is the volatile part - read once - so it is the prompt, not a
    // cached block.
    prompt: `Document:\n\n${text}\n\nSeparate it into the facts it states.`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 3000,
  });

  const live = await liveFacts();
  const seen = new Set<string>();
  const candidates: (Candidate & { duplicates: Duplicate[] })[] = [];
  for (const f of data?.facts ?? []) {
    const topic = String(f?.topic ?? '').trim().slice(0, 120);
    // pdfjs joins each line's text items with a space, so a sentence broken across
    // two lines of the handbook arrives as "end of each  semester". Runs of spaces
    // and tabs collapse; newlines are the shape of the text and stay.
    const body = String(f?.body ?? '').replace(/[ \t]+/g, ' ').trim();
    if (!topic || body.length < 20) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Checked against what is already saved before anybody is asked to read it. The
    // handbook uploaded a second time is the ordinary case, not the exception.
    candidates.push({ topic, body, duplicates: findDuplicates({ topic, body }, live) });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  await audit(userId, 'school_fact.read', 'school_fact', undefined,
    { from: sourceNote, chars: text.length, candidates: candidates.length,
      duplicates: candidates.filter(c => c.duplicates.length).length });

  const flagged = candidates.filter(c => c.duplicates.length).length;

  return NextResponse.json({
    candidates,
    source_note: sourceNote,
    textLength: text.length,
    note: candidates.length
      ? `${candidates.length} fact${candidates.length === 1 ? '' : 's'} read from ${sourceNote}. `
        + `${flagged ? `${flagged} of them look like something already saved. ` : ''}`
        + `Nothing has been saved yet - check each one, then save the ones the school stands behind.`
      : `Nothing in ${sourceNote} reads as a standing fact about the school. If the policy is in there, paste just that part.`,
  });
}
