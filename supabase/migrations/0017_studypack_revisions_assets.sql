-- Talking to LOTS AI about a pack it has already built.
--
-- Until now a study pack was a one-shot: generated, gated, approved, and if a page was
-- wrong the only remedy was to build the whole thing again as a new row. A teacher
-- looking at page 4 and saying "shorten the glossary" or "put this photograph on page
-- 8" had nowhere to say it. Two tables carry that.
--
-- Neither of them moves where a pack lives. `study_pack.content` is still the current
-- version and everything that reads a pack today reads it unchanged; a revision is the
-- trail behind it, and an asset is a file a page can point at.
--
-- Applied by hand in the SQL editor, like every migration here (see CONTINUE_HERE.md).
-- Every route below tolerates this file not having been applied: the revise and asset
-- routes say the database needs 0017 rather than failing at a missing relation.


-- 1 ------------------------------------------------------------------- revisions
--
-- One row per version of a pack's content, including the first. Revision 1 is the
-- pack as generated, which is what makes "put it back how it was" answerable: without
-- it the original is the one version that was never written down.
--
-- The content is stored whole rather than as a diff. A pack is tens of kilobytes of
-- JSON, a teacher makes a handful of revisions, and a diff would have to be replayed
-- correctly by every future reader of this table to be worth anything.
create table if not exists study_pack_revision (
  id            uuid primary key default gen_random_uuid(),
  study_pack_id uuid not null references study_pack(id) on delete cascade,
  n             int  not null,                    -- 1 is the pack as generated
  content       jsonb not null,
  -- What the teacher asked for, in their own words. Null on revision 1: nobody asked
  -- for it, it is where the pack started.
  instruction   text,
  -- Set when this revision restored an earlier one, so the trail says so rather than
  -- looking like the model happened to write the same pack twice.
  reverted_from int,
  author_id     uuid references app_user(id),
  created_at    timestamptz not null default now(),
  unique (study_pack_id, n)
);
create index if not exists study_pack_revision_pack
  on study_pack_revision (study_pack_id, n desc);

alter table study_pack_revision enable row level security;

-- A revision is readable by anyone who may read the pack, and writable by anyone who
-- may write it. Both defer to study_pack's own policy rather than restating it, so
-- the two can never disagree about who owns a pack.
create policy study_pack_revision_read on study_pack_revision for select
  using (exists (select 1 from study_pack p where p.id = study_pack_id));
create policy study_pack_revision_write on study_pack_revision for all
  using (exists (
    select 1 from study_pack p
    where p.id = study_pack_id and (p.author_id = current_app_user() or is_reviewer())))
  with check (exists (
    select 1 from study_pack p
    where p.id = study_pack_id and (p.author_id = current_app_user() or is_reviewer())));


-- 2 ---------------------------------------------------------------------- assets
--
-- A picture a pack holds: one the teacher handed over, or one drawn on request.
--
-- The bytes go to the private `artefacts` bucket like every other rendering, under
-- study_pack_asset/<id>.<ext>. They are inlined into the pack's HTML as data URIs at
-- render time (lib/studypack/render_html.ts) rather than linked, because the headless
-- print has no session and /api/document/view is behind sign-in - a linked image
-- would print as a blank rectangle.
--
-- `alt` is not nullable in practice and the application refuses to write a row
-- without it. A pack is read by children, printed, and sometimes read aloud; a
-- picture nobody can describe is a picture doing no teaching.
create table if not exists study_pack_asset (
  id            uuid primary key default gen_random_uuid(),
  study_pack_id uuid not null references study_pack(id) on delete cascade,
  kind          text not null check (kind in ('upload', 'generated')),
  storage_path  text not null,
  content_type  text not null,
  bytes         int  not null,
  alt           text not null,
  -- What was asked for, on a generated image. Kept so a picture can be redrawn, and
  -- so anybody auditing what this application has spent money on can see why.
  prompt        text,
  author_id     uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index if not exists study_pack_asset_pack on study_pack_asset (study_pack_id);

alter table study_pack_asset enable row level security;

create policy study_pack_asset_read on study_pack_asset for select
  using (exists (select 1 from study_pack p where p.id = study_pack_id));
create policy study_pack_asset_write on study_pack_asset for all
  using (exists (
    select 1 from study_pack p
    where p.id = study_pack_id and (p.author_id = current_app_user() or is_reviewer())))
  with check (exists (
    select 1 from study_pack p
    where p.id = study_pack_id and (p.author_id = current_app_user() or is_reviewer())));
