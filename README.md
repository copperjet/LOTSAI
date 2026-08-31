# LOTS AI

Weekly planning and lesson evaluation for Lusaka Oaktree School, grounded in the school's own
curriculum, calendar and formats.

Built to the specification in the folder above:
`LOTS_AI_Product_Spec_v1.md` and Addenda A–D.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Supabase

Create a project at supabase.com, then in the SQL editor run, in order:

- `supabase/migrations/0001_init.sql`
- `supabase/migrations/0002_functions.sql`
- `supabase/migrations/0003_edits.sql`
- `supabase/migrations/0004_usage_provider.sql`
- `supabase/migrations/0005_objective_provenance.sql`
- `supabase/migrations/0006_registry_gap.sql`
- `supabase/migrations/0007_artefact_engine.sql`

Then create a **private Storage bucket** named `artefacts` (Storage → New bucket), where rendered
PDFs are written. `npm run seed` creates it automatically if the service role can; creating it by
hand is harmless.

### 3. Keys

```bash
cp .env.local.example .env.local
```

Fill in:

| Variable | Where it comes from |
|---|---|
| `LLM_PROVIDER` | `openai` or `anthropic`. Defaults to `anthropic` when unset. |
| `OPENAI_API_KEY` | platform.openai.com. Server-side only — it never reaches a browser. |
| `ANTHROPIC_API_KEY` | console.anthropic.com. Same rule. Only needed when `LLM_PROVIDER=anthropic`. |
| `OPENAI_MODEL_SMALL` / `_STANDARD` / `_LARGE` | optional. Override the pinned model for a tier. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page |
| `SUPABASE_SERVICE_ROLE_KEY` | same page. Used only by route handlers and the seed script. |
| `DEMO_USER_EMAIL` | who you are signed in as until Google SSO is switched on |
| `SITE_PASSWORD` | shared password for a deployed site. Unset locally, required in production. |
| `MOCK_LLM` | set to `1` to run every workflow against fixtures — no key, no cost. See below. `MOCK_CLAUDE` is the old name and still works. |

`.env.local` is gitignored. Do not commit it, and do not paste these keys into a chat.

### 4. Load the curriculum

```bash
npm run ingest     # reads ../CURRICULUM OVERVIEWS, writes supabase/seed/
npm run seed       # loads calendar, people, classes and the registry
```

`npm run ingest` needs Python with `python-docx` and `pymupdf`
(`pip install python-docx pymupdf`). Without PyMuPDF it still reads every `.docx` and reports each
PDF as unreadable, rather than failing to start.

### 5. Deploying

The target is **lotsai.dennysepiso.com** on Vercel, functions pinned to Cape Town. Steps, environment
variables and the shared-password gate that stands in for sign-in are in [DEPLOY.md](DEPLOY.md).

### 6. Run

```bash
npm run dev
```

Without API credits, run it against fixtures instead:

```bash
MOCK_LLM=1 npm run dev
```

---

## What the ingestion actually found

Run on the school's real folder, 2026-27:

- **895 distinct curriculum weeks imported** across every year group it could read, EY to A Level
- **203 of them carry Cambridge syllabus references** across **21 subject/year groups**. The rest
  state objectives in prose
- **10 duplicate conflicts** where two files claim the same subject, year and semester
- **10 files excluded** — named `DELETE`, or labelled with a previous academic year
- **2 could not be read** — a table the extractor could not find; each needs a human look

Three parser fixes account for most of that reach, and they share one lesson. **The column mapping:**
`header_map` took the first header matching `objective | topic | unit`, and several overviews run
`UNIT / TOPIC | STRAND / FOCUS | LEARNING OBJECTIVES` — so it locked onto Unit and filed a document
carrying 140 references as topic-only; the headers are scored now. **The strand pattern:** the
reference regex allowed one capital letter for the strand, so all 34 of CP4 English's Speaking &
Listening objectives (`4SLp`, `4SLm`, `4SLg` …) imported uncoded; it takes one or two now. **The
PDF reader:** 43 overviews existed only as PDF and were reported unreadable — they carry the same
week table, so a PDF is extracted to the same cell grid and read by the same rules (PyMuPDF; columns
found by content, because a PDF places the `WEEK` header in a different column from its values).

The lesson generalises, and is worth keeping: **before concluding the school's documentation is
missing something, check that the parser can represent what it is reading.** Each fix was verified
against the full corpus before it changed anything — the strand widening, for instance, added exactly
16 references and no false positives.

`supabase/seed/readiness_report.json` is the full breakdown, per subject, and it is loaded into the
`registry_gap` table so an HOD sees it in the app — the conflicts to decide, the files still to read.
It answers a question the school currently cannot answer: whether its curriculum documentation is
complete.

After seeding, **125 weeks are signed off and plannable** across CP4–CP6, LS1–LS3 and beyond. The
rest stay blocked because their overviews genuinely carry no codes, and inventing one is the single
thing this system must never do. A conflict, once an HOD decides which file is current, is recorded in
`supabase/seed/conflict_resolutions.json` and honoured on the next ingest — never guessed.

**This is the critical path, not the app.** Only weeks with syllabus references can be matched
between teachers or counted toward coverage, so `npm run seed` signs off only those and leaves
everything else visibly blocked. That is deliberate — see the sign-off gate below.

---

## How it works

### Search before generate

`POST /api/plan/match` runs before any model call and costs nothing. It builds a work key from the
week's syllabus references — a controlled vocabulary, because objectives are retrieved from the
registry rather than written by a model — and looks for an approved plan that matches.

```
planner | MATH | CP4 | 2026-27 | W4 | 4Np.03,4Np.05
```

Set arithmetic over integers. No embeddings, no vector store, and it works offline against a cached
index. Matching relaxes through five tiers before giving up (`lib/workkey.ts`).

Three outcomes: **reuse** (free, no model call), **adapt** (writes only the difference), **create**.
At three streams per year group, most requests are the first two.

### The sign-off gate

`curriculum_week.signed_off_at` is null until a named HOD signs that subject off. Until then
`/api/plan/match` refuses to generate and says why. This is the only defence against a confident,
well-formatted plan built on last year's file, and it is enforced in the route rather than in a
policy document.

### Objectives are retrieved, never generated

The model's output schema (`lib/planner.ts`) contains `objective_indexes`, not objective text. It
chooses which of the supplied objectives each lesson covers. It cannot reword, renumber or invent
one, because there is nowhere in the schema for it to put one.

### The quality gate

`lib/gate.ts`, two passes. The deterministic pass is free and instant and does all the compliance
work — references resolve, dates match the calendar, lesson count matches the timetable, no learner
names. Only what a rule cannot judge goes to a small model call. A blocked plan never reaches the
model at all, because it cannot be submitted either way.

The machine does compliance so the HOD can do judgement.

### Editing the plan, and what that records

The three text fields — methodology, resources, differentiation — are edited in place in the table,
saved on blur or Ctrl/Cmd+Enter. There is no save button and no confirm step (Addendum D §D5 rule 6).
Objectives are not editable: they are retrieved from the registry, and changing them would break both
coverage counting and the work key the shared bank is built on.

`PATCH /api/plan/lesson` does three things per edit:

1. writes an `edit_event` row — before, after, field, and the planner's `origin`
2. updates the lesson
3. re-runs the quality gate and stores a fresh `gate_result`, so the fold and the submit button
   update without a reload

Only a `draft` or `returned` planner is editable. A submitted or approved one is a record, and the
route answers 409 with a plain sentence rather than silently accepting the change.

`edit_event` is the point of the dogfood fortnight. It is what turns "the drafts felt about right"
into a query:

```sql
select origin, field, count(*) from edit_event group by 1, 2 order by 3 desc;
```

If adapted plans are edited less than cold ones, the search-before-generate design is paying for
itself. `origin` is stored on the row rather than joined from the planner, because the planner's
status has usually moved on by the time anyone asks.

### Today, in the corner

The box top-right lists the day's work and ticks each line when it is done. Every row and every tick
is derived in `/api/agenda` — a planner is ticked because its status is `submitted`, an evaluation
line is ticked because no taught lesson is missing a note. There is nothing to tick by hand and no
table behind it, so it cannot disagree with the database (Addendum A §A2, "derive, don't collect").

An unticked row starts the same workflow its agenda button would. The box refreshes whenever the
agenda does — on load, and after a submission, an evaluation, an approval or a sign-off — so a tick
appears the moment the work lands. A session left open across midnight keeps yesterday's list until
the next load; there is no timer.

### Running without credits

`MOCK_LLM=1` returns fixtures from `lib/mocks.ts` instead of calling the API, and neither provider
client is constructed, so no key is needed at all. (`MOCK_CLAUDE=1` is the old name for the same
switch and is still honoured, so a deployment holding production on fixtures does not change
behaviour mid-rename.) The fixtures are read off the same prompt
the model would have seen — the period count, the objective indexes and the resource inventory — so
mock plans satisfy the real gate rather than tripping it, and `planner_create` still answers in
`objective_indexes` rather than objective text.

The mock writes its `ai_usage` row like any other call, with `model = 'mock'` and zero cost.
Bypassing the meter would mean the one thing promised to the board — a ledger, not an estimate — is
the one thing never exercised.

### Metering

Every call goes through `lib/llm.ts` and writes a row to `ai_usage`: workflow, provider, model, input
tokens, cached tokens, output tokens, cost, latency. `cached_tokens` means the same thing on both
providers — OpenAI folds cache reads into its input count and `lib/providers/openai.ts` subtracts them
back out, so a cached token is never billed twice. No estimate goes to the board — the ledger does.

Model routing is in one place, `TIER` in `lib/llm.ts`, per provider. Raising a tier is a one-line change and the
meter will show what it costs.

### Prompt caching

The registry week and the resource inventory are identical for everyone planning that subject and
week, so they go first: Anthropic gets an explicit breakpoint at a 1-hour TTL, OpenAI gets a stable
`prompt_cache_key` and 24-hour retention. Either way the Friday planning window is bursty and many
teachers hit the same prefix. Class-specific context goes after it.

Watch `cached_tokens` in `ai_usage`. If it is zero across repeated generations on Anthropic, something
volatile has crept above the breakpoint and the cost model is wrong.

On OpenAI it is zero for a different reason, measured rather than assumed: a full CP4 planner prompt
is around 750 input tokens, and OpenAI only caches prefixes of 1024 tokens or more. Nothing in v1 is
long enough to cache at all. That is not worth padding a prompt to reach — but it does mean the §D8
cost model must not assume a cache discount while `LLM_PROVIDER=openai`.

### The artefact engine

A workflow is a record, not a route (main spec §3.2, Addendum C §C6). Two tables carry it: a
`standard` (the five parts §C2 names — schema, non-negotiables, and the ids of a generator, gate and
renderer, versioned by academic year) and a `workflow` (the §C6 config — grounding, collaborative
keying, approval states, render trigger). The planner runs through this today: its routes call
`lib/engine.ts`, which loads the workflow and dispatches generation, gating and rendering through
`lib/workflows/registry.ts`.

The **declarative** parts of a Standard are data; the **imperative** parts (how a plan is generated,
gated, drawn) are code, registered once under the ids the Standard names. Adding "study pack" is a
Standard record, a workflow row, and a registered renderer — never a new route. The engine falls back
to a built-in `weekly_planner` config when the tables are empty, so the loop behaves identically
before and after `0007` is applied.

On approval, the planner is **rendered to a PDF** on the LOTS template (`lib/pdf/`, pdf-lib in-process,
logic ported from eScholr — including `sanitizeWinAnsi`, which every model-authored document needs) and
written to the private `artefacts` bucket. The `pdf_jobs` row is the ledger; `POST /api/pdf/run`
re-renders a failed one, `GET /api/pdf/run?plannerId=` returns a signed URL. Render is synchronous —
there is no worker to drain — and never blocks approval if it fails, because the artefact is already
banked and a PDF is only a rendering of it (main spec §4).

`POST /api/ingest/upload` takes a `.pdf`/`.docx`, extracts its text, and **reconciles every objective
code it carries against the registry** (`lib/ingest/reconcile.ts`). Anything that does not resolve is
returned marked, never accepted — the founding rule that objectives are retrieved, never generated,
enforced on the way in. This is the foundation the v2 "turn this into a study pack" path stands on.

---

## What is not wired yet

| | |
|---|---|
| **Google Workspace SSO** | `currentUser()` in `lib/supabase.ts` reads `DEMO_USER_EMAIL`. Swapping it for the Supabase session is the whole of the auth work — every route already calls it rather than trusting request input. |
| **Drive + docx render** | Approval renders a **PDF** to the `artefacts` bucket. The docx into the existing Drive folder still needs the Google Drive API credential; the render layer that produces it is in place. |
| **Offline sync** | Evaluations queue to `localStorage` when the browser is offline. The flush-on-reconnect job is not written. |
| **Overnight pre-staging** | The batch job that drafts next week at half price. |

---

## Layout

```
app/
  page.tsx              the chat shell — presentation only
  Ambience.tsx          the drifting-dot canvas, off below 880px and under reduced motion
  api/
    agenda/             what is outstanding, most urgent first
    calendar/           every teaching week, and what each class already has against it
    whoami/             demo user switching, until Google Workspace SSO lands
    plan/match/         search before generate. No model call.
    plan/generate/      create, adapt or reuse, then run the gate
    plan/lesson/        edit one field in place, record it, re-run the gate
    plan/submit/        teacher submits; HOD approves or returns
    evaluate/           the lesson evaluation loop
    review/             queue, bank, registry sign-off, coverage
lib/
  llm.ts                every model call, routed, cached and metered
  providers/            anthropic.ts, openai.ts — only what differs per vendor
  claude.ts             a re-export of llm.ts, so older imports still resolve
  planner.ts            the weekly planner workflow
  evaluation.ts         formatting and objective tagging
  gate.ts               the quality gate, deterministic first
  gateContext.ts        everything the gate needs about a planner, in one place
  mocks.ts              fixtures for MOCK_LLM=1
  workkey.ts            the collaborative index
  supabase.ts           two clients: admin (server) and anon (RLS)
supabase/
  migrations/           schema, RLS, and the derived-read functions
scripts/
  ingest_overviews.py   the curriculum importer
  models.mjs            lists the models the OpenAI key can reach, so tiers are pinned from fact
  seed.mjs              loads calendar, people, classes, registry
```
