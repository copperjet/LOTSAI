-- Cambridge's suggested teaching activities, attached to the objectives they belong to.
--
-- lib/planner.ts has had a slot for this since it was written. Its cached block carries
-- "Suggested activities from the overview" straight out of curriculum_week.activities -
-- and 15 of 377 weeks had anything to put in it, all of them CP4 Mathematics. Every
-- other week, the planner invented the teaching activity from the objective text alone.
--
-- The material exists. Cambridge publishes a scheme of work for each syllabus, and each
-- one attaches an activity, its resources and a note about prior knowledge directly to
-- an objective. The school's overviews already say which objectives a week covers. So
-- the two documents join on the objective and nobody has to decide which unit falls in
-- which week - the overview said that a year ago.
--
-- Deliberately not part of curriculum_week. Three reasons:
--
--   1. It is the publisher's material, not the school's. A head of department reading a
--      plan has to be able to tell which suggestion came from the school's own overview
--      and which came from Cambridge, and a column that mixes them cannot.
--   2. It is per objective, not per week. One objective is taught across several weeks
--      and by several year groups; copying its activities into each week would be the
--      same text in a dozen rows, drifting the moment one is edited.
--   3. It outlives the year. curriculum_week is written per academic_year; a scheme of
--      work is the same document next year and the year after.
--
-- Safe to re-run.

create table if not exists objective_activity (
  id             uuid primary key default gen_random_uuid(),
  -- Which framework this came from. Joined to subject_curriculum (0021), which says
  -- which subjects and year groups follow that code and which key it is written against.
  syllabus_code  text not null,
  -- 'ref' or 'topic', and it must agree with subject_curriculum.joins_on for this code.
  -- Carried here as well because a reader has this row in its hand and should not have
  -- to go and ask what shape its own key is.
  key_kind       text not null check (key_kind in ('ref', 'topic')),
  -- '7CT.01' where the syllabus codes its objectives, '4.1' where it numbers its topics.
  key            text not null,
  -- The publisher's wording of the objective. Never used as an objective - the registry
  -- holds those and nothing in this system writes one. It is here so a person checking
  -- the bank can see the activity is attached to what they think it is.
  objective_text text,
  activities     text[] not null default '{}',
  resources      text[] not null default '{}',
  notes          text[] not null default '{}',
  -- 'Cambridge Lower Secondary Computing 0860 Stage 7 Scheme of Work', and the page.
  -- Printed in the planner's prompt, so the model and the reviewer both know whose
  -- suggestion it is.
  source         text not null,
  source_page    int,
  loaded_at      timestamptz not null default now(),
  -- One row per objective per syllabus. A re-import of a revised scheme of work replaces
  -- what it says rather than accumulating two answers.
  unique (syllabus_code, key)
);

-- How the planner reads it: the codes for this class's subject and year group, then the
-- keys this week's objectives carry.
create index if not exists objective_activity_lookup
  on objective_activity (syllabus_code, key);

alter table objective_activity enable row level security;

-- Read by anyone past the gate. It is reference material about the curriculum, the same
-- as the registry itself; it says nothing about any person. Written by a migration and
-- the loader, which run as the service role.
create policy objective_activity_read on objective_activity for select using (true);
