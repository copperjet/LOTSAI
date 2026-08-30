-- Study packs — the first artefact the engine carries beyond the planner.
--
-- A study pack is an interactive revision tool covering a span of curriculum weeks
-- (Addendum C §C3, the Study Pack Build Kit is its Standard). It is generated
-- content — key ideas, a quiz per topic, a glossary — but its objective codes are
-- retrieved from the registry, never generated, exactly as the planner's are. The
-- generated pedagogy is new; the curriculum grounding is not.
--
-- It has its own table rather than riding shared_artifact, because that bank is
-- planner-shaped (one week, a planner_id). A study pack spans weeks and has no
-- planner. It carries its own bank fields (work_key, approved, reuse_count) so
-- search-before-generate works for it the same way — matching a later teacher to
-- an approved pack before any model runs. Consolidating the two banks is a later
-- refactor, not this one.
create table if not exists study_pack (
  id             uuid primary key default gen_random_uuid(),
  work_key       text not null,                       -- see lib/workkey.ts (artefact_type 'study_pack')
  academic_year  text not null references academic_year(id),
  year_group     text not null,
  subject_id     text not null references subject(id),
  class_id       text references klass(id),           -- who generated it for; null = subject-wide
  week_from      smallint not null,
  week_to        smallint not null,
  title          text not null,
  objective_refs text[] not null default '{}',        -- the union across the span, retrieved
  content        jsonb not null,                      -- {units:[{unit_label, topics:[...]}], glossary:[...]}
  author_id      uuid not null references app_user(id),
  status         text not null default 'draft'
                 check (status in ('draft','submitted','approved','returned')),
  approved       boolean not null default false,
  reuse_count    int not null default 0,
  storage_path   text,                                -- the rendered .html in the artefacts bucket
  created_at     timestamptz not null default now(),
  approved_at    timestamptz
);
create index if not exists study_pack_work_key on study_pack (work_key);
create index if not exists study_pack_scope on study_pack (subject_id, year_group, week_from, week_to);
create index if not exists study_pack_refs on study_pack using gin (objective_refs);

alter table study_pack enable row level security;

-- An approved pack is readable across the department (the point of the bank); a
-- draft is the author's until approved. Same shape as shared_artifact's policy.
create policy study_pack_read on study_pack for select
  using (approved or author_id = current_app_user() or is_reviewer());
create policy study_pack_write on study_pack for all
  using (author_id = current_app_user() or is_reviewer())
  with check (author_id = current_app_user() or is_reviewer());
