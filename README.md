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

### 3. Keys

```bash
cp .env.local.example .env.local
```

Fill in:

| Variable | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com. Server-side only — it never reaches a browser. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page |
| `SUPABASE_SERVICE_ROLE_KEY` | same page. Used only by route handlers and the seed script. |
| `DEMO_USER_EMAIL` | who you are signed in as until Google SSO is switched on |
| `MOCK_CLAUDE` | set to `1` to run every workflow against fixtures — no key, no cost. See below. |

`.env.local` is gitignored. Do not commit it, and do not paste these keys into a chat.

### 4. Load the curriculum

```bash
npm run ingest     # reads ../CURRICULUM OVERVIEWS, writes supabase/seed/
npm run seed       # loads calendar, people, classes and the registry
```

`npm run ingest` needs Python with `python-docx` (`pip install python-docx`).

### 5. Run

```bash
npm run dev
```

Without API credits, run it against fixtures instead:

```bash
MOCK_CLAUDE=1 npm run dev
```

---

## What the ingestion actually found

Run on the school's real folder, 2026-27:

- **172 week rows imported** across the year groups it could read
- **11 of them carry Cambridge syllabus references.** The rest state objectives in prose
- **10 duplicate conflicts** where two files claim the same subject, year and semester
- **10 files excluded** — named `DELETE`, or labelled with a previous academic year
- **63 could not be read** — mostly PDF with no Word version behind it

`supabase/seed/readiness_report.json` is the full breakdown, per subject. It is worth showing to the
Academic Coordinator on its own: it answers a question the school currently cannot answer, which is
whether its curriculum documentation is complete.

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

`MOCK_CLAUDE=1` returns fixtures from `lib/mocks.ts` instead of calling the API, and the Anthropic
client is never constructed, so no key is needed at all. The fixtures are read off the same prompt
the model would have seen — the period count, the objective indexes and the resource inventory — so
mock plans satisfy the real gate rather than tripping it, and `planner_create` still answers in
`objective_indexes` rather than objective text.

The mock writes its `ai_usage` row like any other call, with `model = 'mock'` and zero cost.
Bypassing the meter would mean the one thing promised to the board — a ledger, not an estimate — is
the one thing never exercised.

### Metering

Every call goes through `lib/claude.ts` and writes a row to `ai_usage`: workflow, model, input
tokens, cached tokens, output tokens, cost, latency. No estimate goes to the board — the ledger does.

Model routing is in one place, `TIER` in `lib/claude.ts`. Raising a tier is a one-line change and the
meter will show what it costs.

### Prompt caching

The registry week and the resource inventory are identical for everyone planning that subject and
week, so they sit before the cache breakpoint at a 1-hour TTL — the Friday planning window is bursty
and many teachers hit the same prefix. Class-specific context goes after it.

Watch `cache_read_input_tokens` in `ai_usage`. If it is zero across repeated generations, something
volatile has crept above the breakpoint and the cost model is wrong.

---

## What is not wired yet

| | |
|---|---|
| **Google Workspace SSO** | `currentUser()` in `lib/supabase.ts` reads `DEMO_USER_EMAIL`. Swapping it for the Supabase session is the whole of the auth work — every route already calls it rather than trusting request input. |
| **Drive render** | Approval sets `planner.status` and writes to the bank. Rendering the docx into the existing Drive folder still needs the Google Drive API credential. |
| **Offline sync** | Evaluations queue to `localStorage` when the browser is offline. The flush-on-reconnect job is not written. |
| **Overnight pre-staging** | The batch job that drafts next week at half price. |

---

## Layout

```
app/
  page.tsx              the chat shell — presentation only
  api/
    agenda/             what is outstanding, most urgent first
    plan/match/         search before generate. No model call.
    plan/generate/      create, adapt or reuse, then run the gate
    plan/lesson/        edit one field in place, record it, re-run the gate
    plan/submit/        teacher submits; HOD approves or returns
    evaluate/           the lesson evaluation loop
    review/             queue, bank, registry sign-off, coverage
lib/
  claude.ts             every model call, routed, cached and metered
  planner.ts            the weekly planner workflow
  evaluation.ts         formatting and objective tagging
  gate.ts               the quality gate, deterministic first
  gateContext.ts        everything the gate needs about a planner, in one place
  mocks.ts              fixtures for MOCK_CLAUDE=1
  workkey.ts            the collaborative index
  supabase.ts           two clients: admin (server) and anon (RLS)
supabase/
  migrations/           schema, RLS, and the derived-read functions
scripts/
  ingest_overviews.py   the curriculum importer
  seed.mjs              loads calendar, people, classes, registry
```
