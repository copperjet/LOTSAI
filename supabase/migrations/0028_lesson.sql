-- 0028  The lesson: a taught presentation, not a document
--
-- The school's four artefacts so far are all things a teacher hands out or files:
-- a planner their HOD signs, a study pack a learner revises from, a worksheet, a
-- homework. None of them is the lesson itself. Asked to make one, the router in
-- app/page.tsx had nowhere to send the request and it fell through to lib/ask.ts,
-- which answered it as prose in the chat.
--
-- A lesson is a deck of slides plus the teaching guide that goes with them:
-- every slide states why it exists, what it is worth in minutes, which objective
-- it serves, and what the teacher should say, expect and watch for. The guide
-- never appears on the screen. It is all in `content`, which is self-describing
-- (it carries its own `version`), for the same reason study_pack.content is:
-- the renderers branch on what is in the document, not on what the columns say.
--
-- Applied by hand in the Supabase SQL editor, like every migration here. Written
-- idempotently, and every read path in lib/lesson/* tolerates it being unapplied
-- (see lib/lesson/persist.ts) - so a deploy that lands before this is pasted
-- degrades to "not available yet" rather than to a white screen.

-- ---------------------------------------------------------------- the lesson

create table if not exists lesson (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references app_user(id),
  -- text, as klass.id is ('CP4B-MATH') and as every other artefact's class_id is.
  class_id text references klass(id),

  subject_id text not null references subject(id),
  year_group text not null,
  academic_year text not null,
  semester smallint,
  -- Nullable, unlike every other artefact here. A planner is a week; a lesson is
  -- a lesson, and a teacher may build one for a topic that does not sit in a
  -- signed-off week. lib/lesson/match.ts spells "no week" as 0 in the work key.
  week_number smallint,

  topic text not null,
  subtopic text,
  duration_minutes smallint not null default 60,
  approach text,

  title text not null,
  content jsonb not null,
  objective_refs text[] not null default '{}',
  -- Where each objective came from: registry, matched from an upload, or the
  -- file's own words. The gate warns on the last of those.
  objective_sources jsonb not null default '[]',

  work_key text,
  theme text,

  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'returned')),
  approved boolean not null default false,
  approved_at timestamptz,
  reuse_count integer not null default 0,

  -- One row, three renderings. The PowerPoint is the one that matters: it needs
  -- no browser, so it is the export that cannot fail on a cold start.
  storage_path text,
  pdf_path text,
  pptx_path text,
  -- Why a render degraded, when one did. Surfaced in /admin/health.
  render_note text,

  drive_file_id text,
  drive_link text,

  source_upload_id uuid references source_upload(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Re-runnable: a partially applied 0028 gets the rest rather than an error.
alter table lesson add column if not exists approach text;
alter table lesson add column if not exists objective_sources jsonb not null default '[]';
alter table lesson add column if not exists theme text;
alter table lesson add column if not exists pdf_path text;
alter table lesson add column if not exists pptx_path text;
alter table lesson add column if not exists render_note text;
alter table lesson add column if not exists source_upload_id uuid references source_upload(id);

create index if not exists lesson_bank_idx on lesson (subject_id, year_group, approved);
create index if not exists lesson_author_idx on lesson (author_id);
create index if not exists lesson_key_idx on lesson (work_key);
create index if not exists lesson_class_idx on lesson (class_id, week_number);

-- ------------------------------------------------------------- the history

-- Revision 1 is the deck as it was generated; every revision after it is what
-- the deck looked like *before* the instruction that produced the next one.
-- That ordering is what makes "revert to 2" mean something.
create table if not exists lesson_revision (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lesson(id) on delete cascade,
  n integer not null,
  content jsonb not null,
  instruction text,
  reverted_from integer,
  author_id uuid references app_user(id),
  created_at timestamptz not null default now(),
  unique (lesson_id, n)
);

-- -------------------------------------------------------------- the pictures

-- `alt` is not null on purpose: a slide is projected, printed and sometimes read
-- aloud, and a picture nobody can describe is a picture doing no teaching.
create table if not exists lesson_asset (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lesson(id) on delete cascade,
  kind text not null check (kind in ('upload', 'generated')),
  storage_path text not null default '',
  content_type text not null,
  bytes integer not null default 0,
  alt text not null,
  prompt text,
  created_at timestamptz not null default now()
);

create index if not exists lesson_asset_lesson_idx on lesson_asset (lesson_id);

-- ----------------------------------------------------------------- the engine

-- The Standard and the Workflow, so lib/engine.ts resolves `lesson` from the
-- database rather than from its BUILTIN fallback. Same shape as the four rows
-- 0007 defines. Both are tolerated missing: the fallback names the same ids.
insert into standard (key, version, name, schema, non_negotiables, generator_id, gate_id, renderer_id, tier, render)
values (
  'lesson', 'v1', 'Lesson', '{}'::jsonb,
  -- jsonb, as standard.non_negotiables is (0007), not a Postgres text array.
  '[
    "Objectives are retrieved from the registry, never written by the model",
    "Every slide states why it exists",
    "Answers and teaching notes never appear on a slide",
    "The class has something to do at least every few slides",
    "Understanding is checked against a named objective",
    "No learner names and no identifiable data"
  ]'::jsonb,
  'lesson', 'lesson', 'lesson', 'standard',
  '{"format":"html"}'::jsonb
)
on conflict (key, version) do update
  set generator_id = excluded.generator_id,
      gate_id = excluded.gate_id,
      renderer_id = excluded.renderer_id,
      non_negotiables = excluded.non_negotiables;

insert into workflow (key, name, roles, standard_key, standard_version, collaborative, approval, render)
values (
  'lesson', 'Lesson', array['teacher'], 'lesson', 'v1',
  '{"work_key":["artefact_type","subject","year_group","academic_year","school_week","objective_set","duration"],"on_match":["reuse","adapt"]}'::jsonb,
  '{"submit_to":"teacher","states":["draft","approved","returned"]}'::jsonb,
  '{"on":"create","to":"storage","format":"html"}'::jsonb
)
on conflict (key) do update
  set standard_key = excluded.standard_key,
      standard_version = excluded.standard_version,
      collaborative = excluded.collaborative,
      approval = excluded.approval,
      render = excluded.render;

-- --------------------------------------------------------------------- RLS

-- Every route reaches this table with the service-role client, so these policies
-- are the second line of defence - what protects the rows from anything holding
-- only the anon key. The helpers are 0001's: current_app_user() and is_reviewer().
alter table lesson enable row level security;
alter table lesson_revision enable row level security;
alter table lesson_asset enable row level security;

drop policy if exists lesson_read on lesson;
create policy lesson_read on lesson for select
  using (approved or author_id = current_app_user() or is_reviewer());

drop policy if exists lesson_write on lesson;
create policy lesson_write on lesson for all
  using (author_id = current_app_user() or is_reviewer())
  with check (author_id = current_app_user() or is_reviewer());

drop policy if exists lesson_revision_own on lesson_revision;
create policy lesson_revision_own on lesson_revision for all
  using (exists (
    select 1 from lesson l where l.id = lesson_revision.lesson_id
      and (l.author_id = current_app_user() or is_reviewer())))
  with check (exists (
    select 1 from lesson l where l.id = lesson_revision.lesson_id
      and (l.author_id = current_app_user() or is_reviewer())));

drop policy if exists lesson_asset_read on lesson_asset;
create policy lesson_asset_read on lesson_asset for select
  using (exists (
    select 1 from lesson l where l.id = lesson_asset.lesson_id
      and (l.approved or l.author_id = current_app_user() or is_reviewer())));

drop policy if exists lesson_asset_write on lesson_asset;
create policy lesson_asset_write on lesson_asset for all
  using (exists (
    select 1 from lesson l where l.id = lesson_asset.lesson_id
      and (l.author_id = current_app_user() or is_reviewer())))
  with check (exists (
    select 1 from lesson l where l.id = lesson_asset.lesson_id
      and (l.author_id = current_app_user() or is_reviewer())));
