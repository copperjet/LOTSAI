-- Where a syllabus reference came from.
--
-- Nothing writes 'model' yet: the enrichment pass waits on the Cambridge
-- Primary frameworks, which the school has not supplied. This column goes in
-- first so that when it does run, a machine-written reference is visibly
-- distinguishable from one the school's own overview carried — and revertible
-- in a single statement:
--
--   update curriculum_week set objectives = ... where ref_source = 'model';
--
-- 'overview' — the code was in the school's document and was copied verbatim
-- 'model'    — proposed by registry_enrich against the framework vocabulary
-- 'hod'      — typed by a person
alter table curriculum_week add column if not exists ref_source text not null default 'overview';
alter table curriculum_week add column if not exists ref_confidence numeric;
