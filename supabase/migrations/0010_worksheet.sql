-- Worksheets — the second generated artefact the engine carries (Phase 3).
--
-- A worksheet is a printable set of differentiated tasks for one class in one week
-- (Addendum C §C2, five-part Standard; the Study Pack Build Kit is the working
-- model). Its objective codes are retrieved from the registry, never generated,
-- exactly as the planner's and study pack's are; the tasks, the three tiers
-- (support/core/extension) and the answers are generated.
--
-- Its own table, like study_pack — it carries the bank fields (work_key, approved,
-- reuse_count) so search-before-generate can be added for it later, and the drive_*
-- columns because an approved worksheet is delivered to the subject's Drive folder
-- (the same path study packs take). Consolidating the artefact banks is a later
-- refactor, not this one.
--
-- Degrades if not yet applied: the routes tolerate the missing table, as the engine
-- tables do.
create table if not exists worksheet (
  id             uuid primary key default gen_random_uuid(),
  work_key       text not null,                       -- see lib/workkey.ts (artefact_type 'worksheet')
  academic_year  text not null default '2026-27',
  year_group     text not null,
  subject_id     text not null references subject(id),
  class_id       text references klass(id),           -- who it was generated for; null = subject-wide
  week_number    smallint not null,
  title          text not null,
  objective_refs text[] not null default '{}',        -- retrieved, the set the tasks address
  content        jsonb not null,                      -- {title, intro, tasks:[{core,support,extension,answer,objectives}]}
  author_id      uuid not null references app_user(id),
  status         text not null default 'draft'
                 check (status in ('draft','approved','returned')),
  approved       boolean not null default false,
  reuse_count    int not null default 0,
  storage_path   text,                                -- the rendered .pdf in the artefacts bucket
  drive_file_id  text,
  drive_link     text,
  created_at     timestamptz not null default now(),
  approved_at    timestamptz
);
create index if not exists worksheet_work_key on worksheet (work_key);
create index if not exists worksheet_scope on worksheet (subject_id, year_group, week_number);
create index if not exists worksheet_refs on worksheet using gin (objective_refs);

alter table worksheet enable row level security;

-- An approved worksheet is readable across the department; a draft is the author's.
-- Same shape as study_pack's policy.
create policy worksheet_read on worksheet for select
  using (approved or author_id = current_app_user() or is_reviewer());
create policy worksheet_write on worksheet for all
  using (author_id = current_app_user() or is_reviewer())
  with check (author_id = current_app_user() or is_reviewer());
