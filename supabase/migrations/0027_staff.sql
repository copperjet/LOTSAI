-- 0027  The people who work here
--
-- Deliberately empty in the repository.
--
-- This migration inserts the school's staff list - every teacher's name and email
-- address - into app_user, so that staff can sign in by school address. The
-- repository is public, and a list of real names and addresses does not belong in
-- it (emails.txt is ignored for the same reason).
--
-- The real migration lives at supabase/local/0027_staff.sql, which .gitignore keeps
-- out of git. Apply that file by hand in the Supabase SQL editor, as with every
-- other migration. Its header covers the details: everybody is inserted as
-- 'teacher', no PIN is set, and it is safe to re-run.
--
-- On a checkout without that file, staff are added one at a time in /admin/people.

select 1;
