-- 0026  Who teaches a class, and the lead teacher role
--
-- `klass.teacher_id` is a single nullable column, so a class has exactly one teacher
-- and a teacher cannot be added to a class somebody else already holds. That was
-- survivable while six CP4 classes were assigned by hand in /admin/classes. It stops
-- being survivable the moment teachers pick their own classes at first sign-in: two
-- teachers choosing the same class would not both be recorded, the second would
-- silently replace the first, and the first would lose their agenda without being
-- told. Co-teaching and cover have never been representable at all.
--
-- So the allocation moves to a table of its own. `klass.teacher_id` stays for now,
-- unread, because dropping a column and moving every read of it in one change leaves
-- nothing to compare against if a read is missed. It is dropped in a later migration
-- once /admin/classes and the four "my classes" queries have run on this for a while.
--
-- Note this is allocation, not authorship. `planner.teacher_id` and
-- `evaluation.teacher_id` say who wrote a thing and are deliberately untouched: a
-- planner written by a teacher who has since left the class is still theirs.
--
-- Safe to re-run.

create table if not exists class_teacher (
  class_id  text not null references klass(id) on delete cascade,
  user_id   uuid not null references app_user(id) on delete cascade,
  -- The teacher who owns the class, as against somebody co-teaching or covering it.
  -- Nothing branches on it yet; it is here because recording a cover arrangement as
  -- though it were an appointment is the thing this table exists to stop.
  is_lead   boolean not null default true,
  added_at  timestamptz not null default now(),
  primary key (class_id, user_id)
);

create index if not exists class_teacher_user on class_teacher (user_id);

-- Everything the six existing rows already said. Without this the people currently
-- using the application lose their classes the moment the reads move over.
insert into class_teacher (class_id, user_id, is_lead)
select id, teacher_id, true from klass where teacher_id is not null
on conflict (class_id, user_id) do nothing;

alter table class_teacher enable row level security;

-- Read is open past the door: "who teaches CP6B French" is a question a teacher asks
-- in order to go and speak to somebody, and lib/ask.ts already answers it. Writing is
-- your own row or a reviewer's - a teacher may pick up a cover class without asking,
-- and may not quietly assign a colleague to one. The same shape as registry_gap (0006)
-- and school_date (0018), for the same reason: the anon key is in the browser bundle.
create policy class_teacher_read  on class_teacher for select using (true);
create policy class_teacher_write on class_teacher for all
  using (user_id = current_app_user() or is_reviewer())
  with check (user_id = current_app_user() or is_reviewer());

-- ── the lead teacher role ──────────────────────────────────────────────────
/**
 * A lead teacher sees every class in the school, and signs nothing off.
 *
 * The two are separate on purpose. lib/admin.ts keeps ALL_CLASSES_ROLES apart from
 * REVIEWER_ROLES for this row: looking across the school is what the job needs, and
 * approving what the school publishes is a named authority that goes with heading a
 * department. Adding the role to the reviewer list would have handed them the second
 * in order to give them the first.
 */
alter table app_user drop constraint if exists app_user_role_check;
alter table app_user add constraint app_user_role_check
  check (role in ('teacher','lead_teacher','hod','coordinator','principal','admin'));
