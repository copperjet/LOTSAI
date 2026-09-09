-- The ICT department, and the Cambridge code that says which framework a subject
-- follows at each stage.
--
-- LOTS AI answers, plans and generates only from the school's own registry. ICT had
-- nothing in it - no subject, no weeks, no classes - so an ICT teacher opening the app
-- had no class to plan and nothing to plan from, while the department's Cambridge
-- documents sat outside the system entirely.
--
-- Three subjects, not one. The department is one department under one head, but the
-- syllabus changes identity across it, and so does what a teacher calls the subject:
--
--   Computing               CP1-CP6 (0059) and LS1-LS3 (0860)
--   ICT                     IGCSE 1-2 (0417)
--   Information Technology  AS and A Level (9626)
--
-- Computing spans two codes and stays one subject because it is one continuum with one
-- objective vocabulary - a stage 4 objective and a stage 7 objective are the same kind
-- of thing, written 4CS.05 and 7CT.01. IGCSE and A Level are not: they drop the coded
-- objective entirely and organise by numbered syllabus topic, they are examined, and a
-- teacher who has both has two subjects rather than one that changed shape.
--
-- `subject.name` is what scripts/ingest_overviews.py emits and what the loader matches
-- on, so these three names are load-bearing: 'Computing', 'ICT', 'Information
-- Technology'. Changing one here without changing SUBJECT_HINTS there silently stops
-- that subject's overviews importing.
--
-- Safe to re-run.

insert into subject (id, name, department) values
  ('COMP', 'Computing',              'ICT'),
  ('ICT',  'ICT',                    'ICT'),
  ('IT',   'Information Technology', 'ICT')
on conflict (id) do update
  set name = excluded.name, department = excluded.department;

-- ── which framework, at which stage ────────────────────────────────────────
/**
 * A syllabus code belongs to a subject *at a stage band*, not to a subject.
 *
 * Computing is 0059 at Cambridge Primary and 0860 at Lower Secondary - same subject,
 * same teachers, different published framework. Putting the code on `subject` would
 * force the split into two subjects to hold two codes, which is the wrong shape for
 * every other reason.
 *
 * This table is what lets a Cambridge document be routed without anything having to
 * guess. "0059 Computing Stage 4 Scheme of Work.pdf" carries its code in the filename,
 * its stage in the title, and 4CS.05 in its body - all three resolve here to COMP/CP4,
 * and a document whose three answers disagree is refused rather than filed somewhere
 * plausible.
 *
 * `joins_on` is the column that earns the table. It says which key attaches Cambridge's
 * suggested teaching activities to the school's own week:
 *
 *   'ref'    the objective code, verbatim in both documents - 7CT.01 in the school's
 *            LS1 overview and 7CT.01 in Cambridge's stage 7 scheme of work
 *   'topic'  the numbered syllabus topic, because 0417 and 9626 have no objective
 *            codes - "4.1 Networks" in the scheme of work, "4. Networks and the
 *            effects of using them" in the overview and in the syllabus
 *
 * Neither needs anybody to decide which unit falls in which week: the school's overview
 * already says which objectives a week covers, and this says what to do with them.
 */
create table if not exists subject_curriculum (
  subject_id     text not null references subject(id) on delete cascade,
  -- The stage band this code covers, in the vocabulary curriculum_week already uses.
  -- 'AS', not 'AS Level' - the registry has held 'AS' since the first import and a row
  -- written the other way can never be found for an AS class.
  year_groups    text[] not null,
  syllabus_code  text not null,
  framework_name text not null,
  -- The edition, as the document states it. A framework is revised and the school will
  -- one day hold two - the code alone does not say which one a week was written against.
  framework_year text,
  joins_on       text not null check (joins_on in ('ref', 'topic')),
  primary key (subject_id, syllabus_code)
);

comment on table subject_curriculum is
  'Which Cambridge framework a subject follows at each stage band, and which key joins '
  'the publisher''s material to the school''s own weeks.';

insert into subject_curriculum
  (subject_id, year_groups, syllabus_code, framework_name, framework_year, joins_on) values
  ('COMP', '{CP1,CP2,CP3,CP4,CP5,CP6}', '0059',
   'Cambridge Primary Computing Curriculum Framework', '2021', 'ref'),
  ('COMP', '{LS1,LS2,LS3}', '0860',
   'Cambridge Lower Secondary Computing Curriculum Framework', '2021', 'ref'),
  ('ICT', '{"IGCSE 1","IGCSE 2"}', '0417',
   'Cambridge IGCSE Information and Communication Technology', '2023', 'topic'),
  ('IT', '{AS,"A Level"}', '9626',
   'Cambridge International AS & A Level Information Technology', '2025', 'topic')
on conflict (subject_id, syllabus_code) do update
  set year_groups    = excluded.year_groups,
      framework_name = excluded.framework_name,
      framework_year = excluded.framework_year,
      joins_on       = excluded.joins_on;

alter table subject_curriculum enable row level security;

-- Read by anyone past the gate, the same as `subject` itself - it is a fact about the
-- curriculum, not about a person. Written by an administrator only, through a migration.
create policy subject_curriculum_read on subject_curriculum for select using (true);

-- ── the head of department ─────────────────────────────────────────────────
-- One account, promoted, rather than a second one created. A second row would split
-- what this person has already done in the app across two identities, and the address
-- it would have been created under differs from the one that exists by an underscore.
--
-- `department` here has to read the same as `subject.department` above or nothing
-- joins: staff departments and subject departments have been two separate free-text
-- vocabularies since 0001, which is why no subject has ever resolved to a head. This
-- fixes it for ICT only. The other four subjects and their staff are left exactly as
-- they are - reconciling those needs somebody to say which department each teacher is
-- in, and a guess would be worse than the gap.
update app_user
   set role = 'hod', department = 'ICT'
 where email = 'dennysepiso@gmail.com';
