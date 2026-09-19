-- 0024  The subjects the school actually teaches
--
-- `scripts/load_curriculum.mjs` resolves a subject by the *name* the importer emits,
-- so a name no `subject` row claims is a whole subject's overviews skipped with a
-- warning and no error. Four rows existed - Mathematics, Science, English, Global
-- Perspectives - which is why 377 of the 896 parsed weeks are all this registry has
-- ever held.
--
-- The twenty-three below are every subject the school teaches, with the department
-- that teaches it, read from the nine department sheets of the whole-school KPI
-- coverage tracker. `scripts/ingest_overviews.py` emits ten of these names and the
-- rest are taught only at IGCSE and above, where the tracker is the record.
--
-- `subject.name` is load-bearing in both directions: it is what SUBJECT_HINTS in the
-- importer produces and what the loader matches on. Changing a name here without
-- changing it there silently stops that subject importing. So where the importer emits
-- a name it is the importer's spelling that is used - 'Art and Design' and 'Music,
-- Dance and Drama', not the tracker's ampersands - and the tracker loader maps its own
-- spelling onto the id instead.
--
-- `department` matters beyond tidiness: lib/ask.ts answers "who is the head of
-- department for Science?" by matching subject.department against app_user.department.
-- Those have been two unrelated free-text vocabularies since 0001, which is why no
-- subject has ever resolved to a head. This gives one side of it the school's own nine
-- names; staff departments still need the same treatment before the match works.
--
-- COMP, ICT and IT are the rows 0021_ict_department.sql inserts, with the same conflict
-- clause, so applying 0021 afterwards is a no-op rather than a fight.
--
-- Safe to re-run.

insert into subject (id, name, department) values
  ('ACC', 'Accounting', 'Business'),
  ('ART', 'Art and Design', 'Expressive Arts'),
  ('BIO', 'Biology', 'Science'),
  ('BUS', 'Business Studies', 'Business'),
  ('CHEM', 'Chemistry', 'Science'),
  ('COMP', 'Computing', 'ICT'),
  ('ECON', 'Economics', 'Business'),
  ('ENG', 'English', 'English'),
  ('ENGLIT', 'English Literature', 'English'),
  ('FR', 'French', 'Foreign Languages'),
  ('GEOG', 'Geography', 'Humanities and Social Sciences'),
  ('GP', 'Global Perspectives', 'Humanities and Social Sciences'),
  ('HIST', 'History', 'Humanities and Social Sciences'),
  ('ICT', 'ICT', 'ICT'),
  ('IT', 'Information Technology', 'ICT'),
  ('MATH', 'Mathematics', 'Mathematics'),
  ('MDD', 'Music, Dance and Drama', 'Expressive Arts'),
  ('MUS', 'Music', 'Expressive Arts'),
  ('PE', 'Physical Education', 'Physical Education'),
  ('PHYS', 'Physics', 'Science'),
  ('READ', 'Reading', 'English'),
  ('SCI', 'Science', 'Science'),
  ('TEN', 'PE Tennis', 'Physical Education')
on conflict (id) do update
  set name = excluded.name, department = excluded.department;
