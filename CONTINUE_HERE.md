# LOTS AI — Continuation Plan

Last worked: 2026-08-30. Everything below is verified working unless marked otherwise.

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

## Environment / gotchas (READ FIRST)

- **Real calls**: the Browser preview tool forces `MOCK_LLM=1`. To run real OpenAI, start the
  dev server from a shell: `MOCK_LLM=0 MOCK_CLAUDE=0 LLM_PROVIDER=openai npm run dev`.
  `.env.local` normally holds `MOCK_CLAUDE=1` (fixtures, free) — restore it when done.
- **Migrations are manual**: no DB password locally, so DDL runs in the Supabase SQL editor. The
  seed and routes tolerate a missing table (degrade cleanly) so nothing breaks pre-migration.
- **Site password**: in `SITE_PASSWORD` in `.env.local`, and nowhere else. It used to be written
  out in this file; it is a live production credential and should be rotated, since it has been
  in the repository. POST it to `/api/gate` (form-encoded, `next=/`) for the gate cookie.
- **Sign-in**: past the gate there is now a personal PIN per member of staff (`/signin`). The
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
