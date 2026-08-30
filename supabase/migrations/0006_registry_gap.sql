-- What stands between the school's documents and a complete registry.
--
-- The ingest (scripts/ingest_overviews.py) writes a readiness report naming every
-- overview it could not turn into signed-off weeks, and why. Until now that report
-- lived only as a JSON file on the machine that ran the ingest — so the one person
-- who most needs it, the Academic Coordinator, could not see it. This table carries
-- it into the app.
--
-- It is deliberately not modelled like curriculum_week: a gap has no objectives and
-- may name a subject or year group the school has no row for yet (an A-Level subject,
-- an unclassified filename). It is a worklist, not curriculum. So `subject` and
-- `year_group` are free text copied from the ingest, not foreign keys.
--
--   conflict     — two files claim the same subject/year/semester; a human must say
--                  which is current. The importer will not guess (Addendum C §C7).
--   unreadable   — a file was matched to a subject but no week table could be read.
--   unclassified — a filename the importer could not place into a subject/year.
--   excluded     — deliberately skipped (named DELETE, or a prior academic year).
create table if not exists registry_gap (
  id             uuid primary key default gen_random_uuid(),
  academic_year  text not null,
  kind           text not null check (kind in ('conflict','unreadable','unclassified','excluded')),
  year_group     text,
  subject        text,
  semester       smallint,
  detail         text not null,               -- the 'why' / 'needs' from the report
  files          jsonb not null default '[]', -- candidate files, for a conflict
  -- An HOD's decision, when made. The ingest reads these back
  -- (supabase/seed/conflict_resolutions.json) and honours them on the next run, so a
  -- decision recorded once is not asked again. Null until someone decides.
  resolved_file  text,
  resolved_by    uuid references app_user(id),
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists registry_gap_year on registry_gap (academic_year, kind);

alter table registry_gap enable row level security;

-- Everyone past the gate can see what is blocking the registry; only a reviewer
-- records a decision. Same shape as the review policies above it.
create policy registry_gap_read  on registry_gap for select using (true);
create policy registry_gap_write on registry_gap for all
  using (is_reviewer()) with check (is_reviewer());
