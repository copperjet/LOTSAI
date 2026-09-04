# LOTS AI — Continuation Plan

Last worked: 2026-09-04. Everything below is verified working unless marked otherwise.

## Where we are

The **artefact engine** (Phase 1) is built and the **weekly planner** and **study packs**
(Phase 2 slice 1) both run through it end to end against real OpenAI.

- A workflow is a record: `standard` + `workflow` tables (§C6), dispatched by `lib/engine.ts`
  through `lib/workflows/registry.ts` (generator/gate/renderer by string id). Engine falls back
  to built-in config when the DB tables are empty, so the loop never breaks.
- **Planner**: generate → gate → approve → renders a landscape PDF on the school's own template
  (`Weekly Planner Template.docx`) to the private `artefacts` Storage bucket. `pdf_jobs` ledger.
- **Study pack**: match → generate → interactive HTML (Build Kit template + quiz/flashcard engine)
  → approve → tier-1 reuse. Objectives retrieved from registry; pedagogy generated. No URLs in
  schema (models hallucinate them). Its own `study_pack` bank table.
- **Registry**: 125 signed-off weeks, 12 subject×year groups, from reading .docx + .pdf overviews
  (PyMuPDF). `registry_gap` surfaces conflicts/unreadable in-app.
- **Upload → reconcile**: `POST /api/ingest/upload` extracts a .pdf/.docx and matches every
  objective code against the registry; unresolved codes are flagged, never accepted.

Migrations applied through **0010**. **0011 (sign-in) and 0012 (admin views) are written and not
yet applied** — paste `supabase/migrations/APPLY_0011_0012.sql` into the SQL editor.
Storage bucket `artefacts` exists (private).

**0015 (saved threads, homework, `study_pack.render_note`) is written and NOT applied.** Until it
is, three things degrade rather than fail, on purpose:
- the rail shows no *Recent* list and nothing a teacher says is kept past the tab;
- "Set homework" runs as far as the picker and then says the database needs 0015;
- a study pack PDF that fell back to the plain pdf-lib rendering cannot say so.
Paste `supabase/migrations/0015_threads_homework.sql` into the SQL editor to switch them on.

**0017 (study pack revisions and assets) is written and NOT applied** — see the 2026-09-04 section below.

**0016 (`school_fact`) is applied and verified end to end** (2026-09-02). It holds what the school
knows about itself that no other table does - the uniform policy, the safeguarding lead, how work
is marked - and `lib/ask.ts` puts it in the grounding block beside the calendar, so a teacher asks
in the one place they already ask everything else.

`POST /api/school-fact` is `admin`/`principal` only and answers 404 to everyone else. It is always
two steps: `action: 'read'` (pasted text, or a .pdf/.docx/photograph) returns candidate
`{topic, body}` pairs and writes **nothing**; `action: 'commit'` writes the ones an administrator
kept, one `audit_log` row each; `action: 'retire'` soft-deletes via `retired_at`, and a retired
fact stops being served on the next question. The table is deliberately small - tens of rows, all
of them in the cached prefix - so there is no embedding or retrieval step, and none is wanted until
it reaches the hundreds.

The one rule to keep: **a fact with a home is read from its home.** "Mrs Banda heads Science" does
not belong in `school_fact` - `app_user` holds it and `/admin/people` maintains it. The extraction
prompt already refuses facts about named individuals' roles for exactly this reason.

**Staff and classes are now in the grounding block** (`lib/ask.ts`), so "who is the HOD for X",
"who teaches CP4 Maths" and "what does this subject sit under" answer from `app_user`, `klass` and
`subject.department` - live, never a written-down copy. One thing to know: `app_user.department`
and `subject.department` are free text on two different vocabularies right now - staff are in
`Primary`, subjects are in `Mathematics`/`Science`/`English`/`Humanities` - so **no subject
resolves to an HOD**. The model says so rather than guessing, which is right but not useful.
Align the two vocabularies at `/admin/people` to switch that on; no code change is needed.

## 2026-09-04 — study pack design, artefact revision, chat legibility

Five things a teacher raised, all done. Read the first two before touching a pack.

### 1. The printable PDF was a failed render, not a design

`study_pack.render_note` said it outright:

```
The input directory "/var/task/node_modules/@sparticuz/chromium/bin" does not exist.
```

`@sparticuz/chromium` was already in `serverExternalPackages`, which is necessary and was
not sufficient: it unpacks `chromium.br` from its own `bin/` at run time by a path it
builds itself, and a path nothing imports is a path Next's tracer cannot see. So `bin/`
was never copied into the lambda, every print in production fell back to the plain
pdf-lib rendering (`lib/pdf/renderers/studypack_print.ts`), and it worked locally because
a real Chrome is on disk and the package is never asked for its binary at all.

Fixed with `outputFileTracingIncludes` in `next.config.mjs`, for the three routes that can
reach `printHtmlToPdf`: `/api/studypack/pdf`, `/api/studypack/approve`, `/api/homework/approve`.
**Verify on the first deploy**: build a pack, press Download printable PDF, and check
`render_note` is null. It adds 67 MB to each of those functions.

The fallback is no longer foreign either: it takes the pack's own two colours, and it
says on its first page that it is the plain rendering.

### 2. Themes

`lib/studypack/themes.ts` is new and carries eight complete looks - palette, type,
cover composition, header band, card treatment, radius. A pack's theme is chosen at
generation from the subject (which fixes a family of three) and the pack's own span
(which moves within it), and stored on `content.theme`. A pack with no theme renders
as `oaktree-forest`, which is the design that existed before, so nothing already in the
bank changes.

`Accent` still reads forest/purple/teal/blue/gold and the model still chooses from those
five - they are slot names now, and the theme decides what a slot looks like. The markup
says `accent-1`..`accent-5`.

`GET /api/theme-preview` renders a sample pack in any theme, and with no query lists them
all. It is a bench for signing off a palette; delete it when nobody is looking at themes.

New page furniture: divider sheets (`Page.role`), lettered tiles on key-notes cards,
an answer bar under a worked example, and a `diagram` block - flow, cycle, number line,
bar model, grid - drawn as SVG the way `chart` already was.

### 3. Talking to a pack

`POST /api/studypack/revise` changes a built pack: it rewrites the BLOCKS on a page and
never the objectives, then re-runs the gate. `POST /api/studypack/asset` takes pictures
and documents for it, and draws a picture on request (`lib/llm.ts` `generateImage`, priced
per image in `IMAGE_PRICE`, metered like everything else). In the UI the pack card carries
a "Change something" box, and once a pack is on the screen the composer routes changes to
it (`LivePack` in `app/page.tsx`).

**Migration 0017 is written and NOT applied.** Until it is, revisions still happen and the
pack still re-renders - what is missing is the version history (the reply says no version
number and offers no Undo) and pictures, which refuse with the store's own error. Paste
`supabase/migrations/0017_studypack_revisions_assets.sql` into the SQL editor.

### 4 and 5. Objectives and chat shape

An objective is stated in words wherever a teacher decides something, with the code after
it, small and quiet (`.code`, not `.pill.ref`). The pack cover still lists every code in
full, because that is what sign-off and coverage read.

`lib/ask.ts` now returns `points` beside `answer`, and `Said` in `app/page.tsx` lays them
out. There is still no markdown parser and there should not be one: structured JSON is how
every other answer in this application travels and it cannot put a model's markup on the
page.

### Two bugs found while verifying, both fixed

- `stripTags` erased any value that was a number and nothing else (`/^[\d,\s]+$/`, meant
  for a stray list of objective indices). A worked example answering "1482" printed ANSWER
  over an empty bar, and quiz options "5", "6", "7" were emptied and then filtered out -
  which moved `correct` and marked the wrong answer right. It now needs three numbers.
- `.print-only` lost the cascade to `.sheet` and `.grid`, so the answer key and the printed
  copy of every glossary were on screen the whole time. A pack a learner opened showed
  them the answers.

## Environment / gotchas (READ FIRST)

- **Real calls**: the Browser preview tool forces `MOCK_LLM=1`. To run real OpenAI, start the
  dev server from a shell: `MOCK_LLM=0 MOCK_CLAUDE=0 LLM_PROVIDER=openai npm run dev`.
  `.env.local` normally holds `MOCK_CLAUDE=1` (fixtures, free) — restore it when done.
- **Migrations are manual**: no DB password locally, so DDL runs in the Supabase SQL editor. The
  seed and routes tolerate a missing table (degrade cleanly) so nothing breaks pre-migration.
- **Site password**: removed. The shared school gate (`SITE_PASSWORD`, `lib/sitegate.ts`,
  `app/gate/`, `app/api/gate/`) is deleted; `/signin` is the only door. The old password was a
  live credential that sat in this repository, so drop it from Vercel and `.env.local` too.
- **Sign-in**: a personal PIN per member of staff (`/signin`). The
  demo user switcher is gone — `POST /api/whoami` let anyone become anyone, which is why nothing
  in `ai_usage` or `audit_log` from before migration 0011 names a real person. Locally,
  `DEMO_USER_EMAIL` still stands in for a session so `npm run dev` and the seed keep working;
  in production it does nothing.
- **/admin** is the technical dashboard — spend, models, cache-hit ratio, latency, every user,
  failed renders. Gated to `role in (admin, principal)` in `app/admin/layout.tsx`, answering
  `notFound()` to everyone else. Nothing in the teacher UI links to it. `npm run seed` now
  creates `admin@lusakaoaktree.school`; its PIN is chosen at first sign-in.
- **pdfjs/mammoth**: `serverExternalPackages` in next.config.mjs — do not bundle them.
- Supabase signed URLs force download disposition, so to *view* an HTML artefact in the browser
  pane, copy it into `public/` and open via localhost (delete after).

## Next: Phase 2 slice 2 — finish study packs (recommended order)

### 1. UI front door (highest value — nothing is reachable in the app yet)
- `app/page.tsx` is the chat shell. Add a "Create a study pack" path alongside the planner flow:
  pick class + week range → `POST /api/studypack/match` → show existing (reuse) or generate →
  `POST /api/studypack/generate` → offer the rendered HTML (signed URL via
  `GET /api/studypack/generate?studyPackId=`). Follow the calm §D5.2 rules (one action per turn).
- Also surface the planner PDF: after approval the response carries `render.path`; add a link
  via `GET /api/pdf/run?plannerId=`.
- Study pack routes already exist: `/api/studypack/{match,generate,approve}`.

### 2. "Turn this PDF into a study pack"
- Extend `/api/ingest/upload` (or a new route) to, after reconcile, feed the resolved objectives
  into `generateStudyPack`. Only resolved refs seed the pack; unresolved ones are shown to the
  user and never used. This is the founding-rule guard already half-built in
  `lib/ingest/reconcile.ts`.

### 3. Study pack PDF render (printable companion)
- Add a `studypack-pdf` renderer in `lib/pdf/renderers/` using the pdf-lib layer
  (`lib/pdf/layout.ts` + `branding.ts`, including `sanitizeWinAnsi`). Render quizzes as printable
  questions with a separate answer key. Register it; `storeArtefact` already picks content-type by
  renderer id (add a `studypack-pdf` entry to its `FORMAT` map).

## Later phases (each is now just a Standard + workflow + registered renderer)

- **Phase 3 — Worksheets** (75% of staff asked). Write its Standard first (§C2 hard rule: all five
  parts), then a workflow row + renderer. The planner's three differentiation tiers become three
  worksheet variants.
- **Phase 4 — KPI tracking**. Syllabus Coverage (18%) + Lesson Planning (12%) already derive from
  the planner/evaluation data (`class_coverage` RPC exists). Render the department tracker + school
  roll-up on the pdf-lib engine. Compliance and outcome in separate panels (§A6, hard rule).
- **Consolidate the two banks**: `shared_artifact` (planner) and `study_pack` duplicate bank
  fields. A generic artefact bank is the eventual refactor — not urgent.
- **Google Workspace SSO + Drive docx render**: the two big "not wired" items (README).

## Verify the current state quickly

```bash
# from lots-ai/, real server in a shell:
MOCK_LLM=0 MOCK_CLAUDE=0 LLM_PROVIDER=openai npm run dev
# gate + become teacher, then:
#   POST /api/studypack/match    {classId:"CP4A-MATH",weekFrom:2,weekTo:4}
#   POST /api/studypack/generate {classId:"CP4A-MATH",weekFrom:2,weekTo:4}
#   GET  /api/studypack/generate?studyPackId=<id>   -> signed HTML url
npx tsc --noEmit      # clean
npx next build        # clean
```

## Key files

- Engine: `lib/engine.ts`, `lib/workflows/registry.ts`
- Planner: `lib/planner.ts`, `lib/gate.ts`, `app/api/plan/{generate,match,submit,lesson}/route.ts`
- Study pack: `lib/studypack.ts`, `lib/studypack_html.ts`, `lib/studypack_render.ts`,
  `app/api/studypack/{match,generate,approve}/route.ts`
- Render: `lib/pdf/{layout,branding,store}.ts`, `lib/pdf/renderers/planner.ts`, `app/api/pdf/run/`
- Ingest: `scripts/ingest_overviews.py`, `lib/ingest/reconcile.ts`, `app/api/ingest/upload/route.ts`
- Seed: `scripts/seed.mjs` (loads calendar, people, classes, registry, gaps, standards, workflows,
  creates the `artefacts` bucket)
- Migrations: `supabase/migrations/0001`–`0008`
- Spec: `../LOTS_AI_Product_Spec_v1.md` + Addenda A–D; build plan artifact:
  https://claude.ai/code/artifact/2d4a9ca1-1121-4915-893b-a29f1dde8eb3
