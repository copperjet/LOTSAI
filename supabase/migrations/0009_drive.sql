-- Drive delivery for approved study packs.
--
-- When a teacher approves the study pack they built, its printable PDF is dropped
-- into the school's own Google Drive folder for that subject and year. Two things
-- this migration adds:
--
--   1. drive_folder — the map from (subject, year, artefact type) to a Google Drive
--      folder id. The school shares each folder with the service account and records
--      its id here; delivery looks the folder up rather than hard-coding it. A row is
--      optional — with none, delivery falls back to DRIVE_DEFAULT_FOLDER_ID, and in
--      MOCK_DRIVE it needs neither.
--
--   2. drive columns on study_pack — the id and link of the file once uploaded, so
--      the app can show "it is in Drive, here" and never upload the same pack twice
--      by accident.
--
-- Everything degrades if this migration has not run yet (the routes catch the
-- missing table), the same tolerance the engine tables have.

create table if not exists drive_folder (
  id             uuid primary key default gen_random_uuid(),
  subject_id     text references subject(id),
  year_group     text,
  academic_year  text not null default '2026-27',
  artefact_type  text not null default 'study_pack',   -- so a folder map can be per-artefact later
  folder_id      text not null,                        -- the Google Drive folder id
  label          text,                                 -- human name, for the UI
  created_at     timestamptz not null default now(),
  unique (subject_id, year_group, academic_year, artefact_type)
);
create index if not exists drive_folder_scope
  on drive_folder (artefact_type, subject_id, year_group, academic_year);

alter table drive_folder enable row level security;
-- Readable by anyone past the gate; a reviewer maintains the map.
create policy drive_folder_read  on drive_folder for select using (current_app_user() is not null);
create policy drive_folder_write on drive_folder for all
  using (is_reviewer()) with check (is_reviewer());

alter table study_pack add column if not exists drive_file_id text;
alter table study_pack add column if not exists drive_link    text;
