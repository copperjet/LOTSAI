-- The artefact engine (main spec §3.2, Addendum C §C2/§C6).
--
-- Everything the planner does today is bespoke code. The point of this migration
-- is to make a workflow a *record* instead: a Standard (the five parts §C2 names)
-- plus a workflow config (§C6). Adding "study pack" or "worksheet" then means
-- writing one of each and registering a renderer — not a new route per artefact.
--
-- What is data and what is code. A Standard's declarative parts live here: the
-- output schema, the non-negotiables a human can check, the model tier, and three
-- string ids — generator_id, gate_id, renderer_id — that name an implementation.
-- The implementations themselves (how a plan is generated, gated, drawn) stay
-- code, registered once in lib/workflows/registry.ts under those ids. "Config not
-- a development cycle" means adding a workflow reuses registered implementations;
-- it never means a quality gate is authored in JSON.

-- ── The Standard: the five parts of §C2, versioned ──────────────────────────
-- Versioned by academic year. An approved artefact pins the version it was built
-- under (Addendum C §C8), so changing a Standard never silently rewrites past work.
create table if not exists standard (
  key              text not null,                 -- 'weekly_planner'
  version          text not null,                 -- 'v1'
  name             text not null,
  schema           jsonb not null,                -- part 1: the artefact's output schema
  non_negotiables  jsonb not null default '[]',   -- part 3: the checkable list, as text
  -- parts 2 and 4 are code, named here (part 5, exemplars, is its own table below)
  generator_id     text not null,                 -- registry key: how it is generated
  gate_id          text not null,                 -- registry key: how it is gated
  renderer_id      text,                          -- registry key: how it is drawn (null = no render yet)
  tier             text not null default 'standard' check (tier in ('small','standard','large')),
  render           jsonb not null default '{}',   -- renderer options (page size, template hints)
  created_at       timestamptz not null default now(),
  primary key (key, version)
);

-- ── The workflow config: the §C6 shape ──────────────────────────────────────
create table if not exists workflow (
  key               text primary key,             -- 'weekly_planner'
  name              text not null,
  roles             text[] not null default '{}', -- who may run it
  inputs            jsonb not null default '{}',   -- { class: class_ref, school_week: week_ref }
  grounding         jsonb not null default '[]',   -- the grounding sources, in order
  collaborative     jsonb not null default '{}',   -- { work_key: [...], on_match: [reuse, adapt] }
  generation        jsonb not null default '{}',   -- { cache_prefix: [...], max_clarifying_questions }
  standard_key      text not null,
  standard_version  text not null,
  approval          jsonb not null default '{}',   -- { submit_to: hod, states: [...] }
  render            jsonb not null default '{}',   -- { on: approved, to: storage }
  created_at        timestamptz not null default now(),
  foreign key (standard_key, standard_version) references standard (key, version)
);

-- ── Part 5: exemplars — approved artefacts promoted as style ground truth ───
-- An HOD promotes an approved planner from the review queue (§C8). Table only in
-- this phase; the promotion UI is a later increment.
create table if not exists exemplar (
  id               uuid primary key default gen_random_uuid(),
  standard_key     text not null,
  standard_version text not null,
  planner_id       uuid references planner(id) on delete cascade,
  promoted_by      uuid not null references app_user(id),
  promoted_at      timestamptz not null default now(),
  foreign key (standard_key, standard_version) references standard (key, version)
);

-- ── The render queue + ledger (shape ported from eScholr's unified pdf_jobs) ─
-- Render is synchronous on approval in this phase — a planner PDF is small and
-- pdf-lib runs in-process, so there is no worker to wait for. This row is the
-- ledger and the retry record: /api/pdf/run reprocesses a failed or queued one.
create table if not exists pdf_jobs (
  id            uuid primary key default gen_random_uuid(),
  doc_type      text not null,                    -- 'planner' (a standard key)
  doc_id        uuid not null,                    -- the planner id
  status        text not null default 'queued'
                check (status in ('queued','running','success','failed')),
  attempts      int not null default 0,
  max_attempts  int not null default 5,
  last_error    text,
  storage_path  text,                             -- bucket path once rendered
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
-- One live job per document, matching eScholr's partial unique index.
create unique index if not exists pdf_jobs_one_active
  on pdf_jobs (doc_type, doc_id) where status in ('queued','running');
create index if not exists pdf_jobs_status on pdf_jobs (status, created_at);

-- ── Uploaded files, and what reconciled against the registry ────────────────
-- The founding rule is that objectives are retrieved, never generated. An
-- uploaded document carries objectives that may be last year's, another school's,
-- or invented — so every reference it names is matched against curriculum_week,
-- and what does not resolve is kept here marked, never accepted as truth.
create table if not exists source_upload (
  id           uuid primary key default gen_random_uuid(),
  uploader     uuid not null references app_user(id),
  filename     text not null,
  kind         text not null,                     -- 'pdf' | 'docx'
  subject_id   text references subject(id),
  year_group   text,
  extracted    jsonb not null default '{}',       -- { text_length, refs_found: [...] }
  reconciled   jsonb not null default '{}',       -- { resolved: [...], unresolved: [...] }
  created_at   timestamptz not null default now()
);

-- ── RLS, mirroring the existing policies (0001) ─────────────────────────────
alter table standard      enable row level security;
alter table workflow      enable row level security;
alter table exemplar      enable row level security;
alter table pdf_jobs      enable row level security;
alter table source_upload enable row level security;

-- Standards and workflow config are readable by everyone past the gate; a
-- reviewer maintains them. (is_reviewer() / current_app_user() defined in 0001.)
create policy standard_read  on standard  for select using (true);
create policy standard_write on standard  for all using (is_reviewer()) with check (is_reviewer());
create policy workflow_read  on workflow  for select using (true);
create policy workflow_write on workflow  for all using (is_reviewer()) with check (is_reviewer());

create policy exemplar_read  on exemplar  for select using (true);
create policy exemplar_write on exemplar  for all using (is_reviewer()) with check (is_reviewer());

-- Jobs are visible to reviewers; writes go through the service role (seed/route).
create policy pdf_jobs_read on pdf_jobs for select using (is_reviewer());

-- An uploader sees their own uploads; a reviewer sees the department's.
create policy upload_read  on source_upload for select
  using (uploader = current_app_user() or is_reviewer());
create policy upload_write on source_upload for all
  using (uploader = current_app_user() or is_reviewer())
  with check (uploader = current_app_user() or is_reviewer());
