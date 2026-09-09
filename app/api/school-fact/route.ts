import { NextRequest, NextResponse } from 'next/server';
import { admin, currentUser, audit } from '@/lib/supabase';
import { ADMIN_ROLES } from '@/lib/admin';
import { call } from '@/lib/llm';
import { cleanText, MAX_STORED_TEXT } from '@/lib/ingest/source';
import { kindOf, extractFile, MAX_IMAGE_BYTES, tooMuch } from '@/lib/ingest/extract';
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
 * POST /api/school-fact  action=reinstate     { id }   a withdrawn fact, said again
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
/**
 * The most one save may write. A review list is built one read at a time and each read
 * hands back at most MAX_CANDIDATES, so a batch this size is already several documents
 * reviewed in one sitting - and the whole table is meant to be tens of rows. Past this
 * the request is not a person saving what they read, and the cost of being wrong is
 * paid on every question anybody asks.
 */
const MAX_COMMIT = 60;
/** A JSON body past this is not a review list. Checked before it is parsed. */
const MAX_BODY_BYTES = 1_000_000;

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

/** A uuid, and nothing else. What arrives in `replaces` came from a browser. */
const isId = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

interface Writable { topic: string; body: string; source_note: string | null; replaces: string[] }

/**
 * Write a reviewed batch, and withdraw what it replaces, in one transaction.
 *
 * The work is `school_fact_commit` (migration 0019). Migrations here are applied by
 * hand, so a database that has not had 0019 yet falls back to the two-step it used to
 * do - it is the weaker path, and it says so in the log, but a school in the middle of
 * a term does not lose the page over a migration nobody has run.
 */
async function commitFacts(kept: Writable[], userId: string): Promise<{
  saved: { id: string; topic: string }[]; replaced: number; error?: string;
}> {
  const db = admin();

  const { data, error } = await db.rpc('school_fact_commit', {
    p_year: YEAR,
    p_actor: userId,
    p_facts: kept.map(k => ({
      topic: k.topic, body: k.body, source_note: k.source_note, replaces: k.replaces,
    })),
  });

  if (!error) {
    const r = (data ?? {}) as { saved?: { id: string; topic: string }[]; replaced?: number };
    return { saved: r.saved ?? [], replaced: r.replaced ?? 0 };
  }

  // Anything but "that function is not there" is a real failure and must not be
  // retried down a path with weaker guarantees.
  const missing = error.code === 'PGRST202'
    || /could not find the function|does not exist/i.test(error.message ?? '');
  if (!missing) return { saved: [], replaced: 0, error: error.message };

  console.warn('[school-fact] school_fact_commit is not installed - apply migration 0019. '
    + 'Falling back to the non-transactional save.');
  return legacyCommit(kept, userId);
}

/** The pre-0019 save: insert, then retire. Kept only until the migration is applied. */
async function legacyCommit(kept: Writable[], userId: string) {
  const db = admin();
  const { data, error } = await db.from('school_fact').insert(kept.map(k => ({
    academic_year: YEAR,
    topic: k.topic, body: k.body, source_note: k.source_note,
    added_by: userId,
  }))).select('id, topic');

  if (error) return { saved: [], replaced: 0, error: error.message };

  const written = data ?? [];
  await Promise.all(written.map(row =>
    audit(userId, 'school_fact.add', 'school_fact', row.id, { topic: row.topic })));

  // Paired by topic rather than by array position: PostgREST does not promise the
  // insert comes back in the order it was sent, and an audit entry naming the wrong
  // replacement is worse than one naming none.
  let replaced = 0;
  for (const fact of kept) {
    if (!fact.replaces.length) continue;
    const by = written.find(w => w.topic === fact.topic)?.id ?? null;
    const { data: gone } = await db.from('school_fact')
      .update({ retired_at: new Date().toISOString() })
      .in('id', fact.replaces).is('retired_at', null)
      .select('id, topic');
    for (const row of gone ?? []) {
      replaced++;
      await audit(userId, 'school_fact.supersede', 'school_fact', row.id,
        { topic: row.topic, replacedBy: by });
    }
  }

  return { saved: written, replaced };
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
  // `supersedes` is 0019 and is applied by hand like the rest, so a database without
  // it must still serve this page. The column is asked for once; if it is not there
  // the read is repeated without it and the withdrawn list simply says less.
  const liveCols = 'id, topic, body, source_note, added_at, supersedes, app_user:added_by(full_name)';
  let live = await db.from('school_fact').select(liveCols)
    .eq('academic_year', YEAR).is('retired_at', null)
    .order('added_at', { ascending: false });
  if (live.error) {
    live = await db.from('school_fact')
      .select('id, topic, body, source_note, added_at, app_user:added_by(full_name)')
      .eq('academic_year', YEAR).is('retired_at', null)
      .order('added_at', { ascending: false }) as typeof live;
  }

  const { data: retired, error: retiredError } = await db.from('school_fact')
    .select('id, topic, body, source_note, added_at, retired_at, app_user:added_by(full_name)')
    .eq('academic_year', YEAR).not('retired_at', 'is', null)
    .order('retired_at', { ascending: false }).limit(200);

  // A read that failed and a table that is empty look identical to the page, and the
  // page's own words for empty are "LOTS AI answers a policy question by saying the
  // records do not hold it" - which would be a lie about a database that is fine.
  if (live.error || retiredError) {
    console.error(`[school-fact] read failed: ${(live.error ?? retiredError)?.message}`);
    return NextResponse.json({
      error: 'not_read',
      message: 'The saved facts could not be read just now. Nothing is lost - reload the page.',
    }, { status: 500 });
  }

  // Which live fact replaced each withdrawn one. The new row carries the ids it
  // superseded, so the map is built from the live side and costs no extra query.
  const supersededBy: Record<string, { id: string; topic: string }> = {};
  for (const f of live.data ?? []) {
    for (const old of (f as { supersedes?: string[] | null }).supersedes ?? []) {
      supersededBy[old] = { id: f.id, topic: f.topic };
    }
  }

  // Every one of these rides the cached prompt prefix on every question anybody asks,
  // so the page shows what the set costs rather than leaving it to be discovered.
  const facts = live.data ?? [];
  const chars = facts.reduce((n, f) => n + f.topic.length + f.body.length + 4, 0);

  return NextResponse.json({
    facts,
    retired: (retired ?? []).map(f => ({ ...f, replacedBy: supersededBy[f.id] ?? null })),
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

    const heavy = tooMuch(files);
    if (heavy) return NextResponse.json({ error: heavy }, { status: 413 });

    // Classified before any is read, so an unsupported file fails before a model call
    // has been paid for - the same order /api/ingest/upload does it in.
    const jobs = [];
    for (const file of files) {
      const kind = kindOf(file);
      if (!kind) {
        // A .doc is the one unreadable file somebody sends on purpose: it looks like a
        // Word document, it is accepted everywhere else, and mammoth reads only .docx.
        // Saying so is the difference between one Save As and a lost afternoon.
        return NextResponse.json({
          error: file.name.toLowerCase().endsWith('.doc')
            ? `${file.name} is in the old Word format. Open it and save it as .docx, then send it again.`
            : `${file.name} is not a kind of file I can read. Send a PDF, a .docx, or a photograph.`,
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
  // Checked before it is parsed. A review list is a few tens of kilobytes; anything
  // this size is either a mistake or an attempt to make the parser the expensive part.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'That is too much to send at once.' }, { status: 413 });
  }

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
    if (asked.length > MAX_COMMIT) {
      return NextResponse.json({
        error: `That is ${asked.length} facts in one save. Save at most ${MAX_COMMIT} at a time - `
          + 'the whole table is meant to be tens of rows, and every one of them is carried on '
          + 'every question anybody asks.',
      }, { status: 413 });
    }
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
          // Only ids. A candidate built in the browser can carry a `pending-n` placeholder
          // from the in-batch duplicate check, and that is not a row to retire.
          replaces: Array.isArray(r.replaces) ? r.replaces.map(String).filter(isId) : [],
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

    // One transaction (migration 0019): the facts are inserted, the rows they replace
    // are withdrawn, and both audit entries are written, or none of it happens. The
    // two-step version could land the insert and fail the retire, leaving the old
    // wording and the new one both live - two copies of one policy in the grounding
    // block, which is the failure lib/knowledge.ts exists to prevent and the one
    // nobody would see.
    const written = await commitFacts(kept, user.id);

    if (written.error) {
      console.error(`[school-fact] commit failed: ${written.error}`);
      return NextResponse.json({
        error: 'not_stored',
        message: 'They were read, but they could not be saved. Nothing was changed - send them again.',
      }, { status: 500 });
    }

    // What the set costs after the save, so the page can say when the school has gone
    // past what lib/ask.ts will carry rather than leaving it to be discovered by an
    // answer that quietly does not know something.
    const after = await liveFacts();
    const chars = after.reduce((n, f) => n + f.topic.length + f.body.length + 4, 0);

    return NextResponse.json({
      ok: true,
      saved: written.saved.length,
      replaced: written.replaced,
      skipped: skipped.length,
      skippedFacts: skipped,
      facts: written.saved,
      budget: { facts: after.length, chars, maxFacts: MAX_FACTS, maxChars: MAX_FACT_CHARS },
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

  // ── reinstate: a fact withdrawn by mistake ───────────────────────────────
  // Withdrawal is one click behind one confirm, and the wrong one is easy to hit in a
  // list of similar topics. Until now the only way back was to retype the policy from
  // the withdrawn table, which is how a school ends up with a slightly different
  // wording of something it never meant to change. The row is un-retired rather than
  // copied: the fact is the same fact, and the audit says it came back.
  if (action === 'reinstate') {
    const id = String(body?.id ?? '');
    if (!isId(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const { data: row } = await db.from('school_fact')
      .select('id, topic, body').eq('id', id).not('retired_at', 'is', null).maybeSingle();
    if (!row) return NextResponse.json({ ok: true, reinstated: 0 });

    // The same guard the save has. A policy withdrawn and then rewritten is the
    // ordinary reason one of these is in the withdrawn list, and putting the old
    // wording back beside the new one is exactly the duplicate this table must not
    // hold - so it is refused here rather than discovered in an answer.
    const clash = findDuplicates({ topic: row.topic, body: row.body }, await liveFacts())
      .find(d => d.reason === 'same' || d.reason === 'topic');
    if (clash) {
      return NextResponse.json({
        error: `"${clash.topic}" is already saved. Withdraw that one first, or edit it instead `
          + 'of putting this wording back beside it.',
      }, { status: 409 });
    }

    const { error } = await db.from('school_fact')
      .update({ retired_at: null }).eq('id', id).not('retired_at', 'is', null);
    if (error) {
      console.error(`[school-fact] reinstate failed: ${error.message}`);
      return NextResponse.json({ error: 'not_reinstated' }, { status: 500 });
    }

    await audit(user.id, 'school_fact.reinstate', 'school_fact', row.id, { topic: row.topic });
    return NextResponse.json({ ok: true, reinstated: 1, topic: row.topic });
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
  const whole = cleanText(raw).trim();
  const text = whole.slice(0, MAX_SUBMITTED);
  // Five documents are joined before this, so the cap can fall in the middle of the
  // last one. Silently reading four and a half handbooks and reporting nothing is the
  // sort of gap a school finds out about through an answer that does not know a policy.
  const cut = whole.length - text.length;
  if (text.length < MIN_TEXT) {
    return NextResponse.json({
      error: `Only ${text.length} characters could be read out of that. Send the policy as text, or a clearer photograph.`,
    }, { status: 422 });
  }

  // A failed read and a document that states nothing are opposite outcomes with the
  // same shape, and the message for the second one - "nothing in this reads as a
  // standing fact" - sends an administrator back to re-photograph a page that was
  // fine. `call` throws on a provider error or on unparseable JSON; a reply that
  // parses but carries no `facts` array is the same failure one step later.
  let read: { facts?: Candidate[] } | undefined;
  try {
    ({ data: read } = await call<{ facts: Candidate[] }>({
      tier: 'small',
      workflow: 'school_fact_read',
      userId,
      system: SYSTEM,
      // The document is the volatile part - read once - so it is the prompt, not a
      // cached block.
      prompt: `Document:\n\n${text}\n\nSeparate it into the facts it states.`,
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 3000,
    }));
  } catch (e) {
    console.error(`[school-fact] read failed: ${e instanceof Error ? e.message : String(e)}`);
    read = undefined;
  }

  if (!read || !Array.isArray(read.facts)) {
    return NextResponse.json({
      error: 'not_read',
      message: 'That could not be read just now - the fault is here, not in the document. '
        + 'Nothing was saved. Try it again in a moment.',
    }, { status: 502 });
  }
  const data = read;

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
    { from: sourceNote, chars: text.length, truncated: cut, candidates: candidates.length,
      duplicates: candidates.filter(c => c.duplicates.length).length });

  const flagged = candidates.filter(c => c.duplicates.length).length;

  return NextResponse.json({
    candidates,
    source_note: sourceNote,
    textLength: text.length,
    truncated: cut,
    note: (cut
      ? `That is longer than I read in one go, so the last ${cut.toLocaleString()} characters `
        + `were not looked at. Send the rest separately. `
      : '')
      + (candidates.length
        ? `${candidates.length} fact${candidates.length === 1 ? '' : 's'} read from ${sourceNote}. `
          + `${flagged ? `${flagged} of them look like something already saved. ` : ''}`
          + `Nothing has been saved yet - check each one, then save the ones the school stands behind.`
        : `Nothing in ${sourceNote} reads as a standing fact about the school. If the policy is in there, paste just that part.`),
  });
}
