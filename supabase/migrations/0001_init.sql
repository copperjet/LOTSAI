-- LOTS AI — v1 schema
-- Product Specification v1.1 section 5, Addendum B section B9, Addendum D section D8.
-- v1 holds no identifiable learner data. Nothing here has a learner name column,
-- and that is deliberate: it keeps the pilot outside the governance gates in
-- Addendum A section A10 until the board has signed those off.

create extension if not exists pgcrypto;

-- ============================================================
-- calendar: the spine everything else references
-- ============================================================
create table academic_year (
  id          text primary key,                        -- '2026-27'
  starts_on   date not null,
  ends_on     date not null
);

create table school_week (
  id              uuid primary key default gen_random_uuid(),
  academic_year   text not null references academic_year(id) on delete cascade,
  semester        smallint not null check (semester in (1, 2)),
  week_number     smallint not null,
  week_commencing date not null,                       -- always a Monday (Addendum A section A9)
  week_type       text not null default 'teaching'
                  check (week_type in ('teaching','break','revision','exam','inset')),
  unique (academic_year, semester, week_number)
);

-- ============================================================
-- people, subjects, classes
-- ============================================================
create table app_user (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  full_name   text not null,
  role        text not null check (role in ('teacher','hod','coordinator','principal','admin')),
  department  text
);

create table subject (
  id        text primary key,                          -- 'MATH'
  name      text not null,                             -- 'Mathematics'
  department text
);

create table klass (
  id              text primary key,                    -- 'CP4B-MATH'
  name            text not null,
  year_group      text not null,                       -- 'CP4'
  subject_id      text not null references subject(id),
  teacher_id      uuid references app_user(id),
  periods_per_week smallint not null check (periods_per_week between 1 and 12)
);

-- ============================================================
-- the registry: what should be taught when
-- Objectives are retrieved from here, never generated (main spec section 4).
-- ============================================================
create table curriculum_week (
  id              uuid primary key default gen_random_uuid(),
  academic_year   text not null references academic_year(id),
  year_group      text not null,
  subject_id      text not null references subject(id),
  semester        smallint not null,
  week_number     smallint not null,
  topic_label     text not null,
  objectives      jsonb not null,                      -- [{ref, text}] — ref may be null
  activities      jsonb not null default '[]',
  resources       jsonb not null default '[]',
  source_file     text,
  signed_off_by   uuid references app_user(id),        -- no sign-off, no generation
  signed_off_at   timestamptz,
  unique (academic_year, year_group, subject_id, semester, week_number)
);

-- Sorted syllabus refs for this week. Null-ref objectives contribute nothing,
-- which is exactly why an uncoded overview cannot be matched (Addendum C section C7).
create or replace function objective_refs(objs jsonb)
returns text[] language sql immutable as $$
  select coalesce(array_agg(r order by r), '{}')
  from (select distinct jsonb_array_elements(objs)->>'ref' as r) x
  where r is not null;
$$;

create index on curriculum_week (academic_year, year_group, subject_id, week_number);

create table resource_inventory (
  id         uuid primary key default gen_random_uuid(),
  subject_id text not null references subject(id),
  year_group text not null,
  label      text not null,
  detail     text
);

-- ============================================================
-- planners
-- ============================================================
create table planner (
  id            uuid primary key default gen_random_uuid(),
  class_id      text not null references klass(id),
  teacher_id    uuid not null references app_user(id),
  school_week   uuid not null references school_week(id),
  status        text not null default 'draft'
                check (status in ('draft','submitted','reviewed','approved','returned')),
  origin        text not null default 'create'
                check (origin in ('create','adapt','reuse')),
  adapted_from  uuid references planner(id),           -- keeps the original author (B8 rule 2)
  drive_file_id text,
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  approved_at   timestamptz,
  unique (class_id, school_week)
);

create table lesson_entry (
  id           uuid primary key default gen_random_uuid(),
  planner_id   uuid not null references planner(id) on delete cascade,
  day_of_week  smallint not null check (day_of_week between 1 and 5),
  lesson_date  date not null,
  objectives   jsonb not null,                          -- [{ref, text}] copied from the registry
  methodology  text not null,
  resources    text not null,
  differentiation text not null,
  is_recap     boolean not null default false,
  teacher_comment text,                                 -- never written by a model
  position     smallint not null default 0
);

create table hod_review (
  id          uuid primary key default gen_random_uuid(),
  planner_id  uuid not null references planner(id) on delete cascade,
  reviewer_id uuid not null references app_user(id),
  comment     text,                                     -- never written by a model
  decision    text not null check (decision in ('approved','returned')),
  reviewed_at timestamptz not null default now()
);

-- ============================================================
-- evaluations: the school's memory of its own teaching
-- ============================================================
create table evaluation (
  id                uuid primary key default gen_random_uuid(),
  lesson_entry_id   uuid not null references lesson_entry(id) on delete cascade,
  teacher_id        uuid not null references app_user(id),
  raw_input         text not null,                      -- what the teacher actually said
  formatted_comment text not null,                      -- written into the planner
  objectives_landed  text[] not null default '{}',
  objectives_flagged text[] not null default '{}',
  captured_at       timestamptz not null default now(),
  synced_at         timestamptz                          -- null while it sat on a phone offline
);

-- ============================================================
-- the shared bank (Addendum B)
-- ============================================================
create table shared_artifact (
  id            uuid primary key default gen_random_uuid(),
  work_key      text not null,                          -- see lib/workkey.ts
  artefact_type text not null default 'planner',
  academic_year text not null,
  year_group    text not null,
  subject_id    text not null references subject(id),
  week_number   smallint not null,
  objective_refs text[] not null default '{}',
  planner_id    uuid references planner(id) on delete cascade,
  author_id     uuid not null references app_user(id),
  visibility    text not null default 'department'
                check (visibility in ('department','school','private')),
  approved      boolean not null default false,
  reuse_count   int not null default 0,
  adapt_count   int not null default 0,
  created_at    timestamptz not null default now()
);
create index on shared_artifact (work_key);
create index on shared_artifact (subject_id, year_group, week_number);
create index on shared_artifact using gin (objective_refs);

create table reuse_event (
  id                 uuid primary key default gen_random_uuid(),
  shared_artifact_id uuid not null references shared_artifact(id) on delete cascade,
  reusing_user_id    uuid not null references app_user(id),
  class_id           text not null references klass(id),
  mode               text not null check (mode in ('reuse','adapt')),
  occurred_at        timestamptz not null default now()
);

-- A claim, not a lock (Addendum B section B5). Expiry is what makes it safe.
create table work_claim (
  work_key   text primary key,
  user_id    uuid not null references app_user(id),
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);

-- landed_rate is derived, never stored: the proportion of objectives that
-- actually landed across every lesson taught from this artefact.
create or replace view shared_artifact_ranked as
select sa.*,
       coalesce(u.full_name, 'Unknown') as author_name,
       stats.evaluations,
       case when stats.total > 0
            then round(100.0 * stats.landed / stats.total)::int end as landed_rate
from shared_artifact sa
left join app_user u on u.id = sa.author_id
left join lateral (
  select count(*)                                        as evaluations,
         sum(cardinality(e.objectives_landed))           as landed,
         sum(cardinality(e.objectives_landed) + cardinality(e.objectives_flagged)) as total
  from evaluation e
  join lesson_entry le on le.id = e.lesson_entry_id
  where le.planner_id = sa.planner_id
) stats on true;

-- ============================================================
-- metering and audit (Addendum D section D8, main spec section 8)
-- ============================================================
create table ai_usage (
  id            uuid primary key default gen_random_uuid(),
  workflow      text not null,
  model         text not null,
  user_id       uuid references app_user(id),
  input_tokens  int not null default 0,
  cached_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd      numeric(10,6) not null default 0,
  latency_ms    int,
  created_at    timestamptz not null default now()
);
create index on ai_usage (created_at);

create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references app_user(id),
  action      text not null,
  entity_type text,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

-- Quality gate results travel with the planner into the HOD queue
create table gate_result (
  id         uuid primary key default gen_random_uuid(),
  planner_id uuid not null references planner(id) on delete cascade,
  checks     jsonb not null,          -- [{id, status, title, detail}]
  blocking   int not null default 0,
  warnings   int not null default 0,
  ran_at     timestamptz not null default now()
);

-- ============================================================
-- row level security
-- A teacher sees their own classes; an HOD their department; everyone reads
-- the registry and the shared bank (Addendum B rule 5: department by default).
-- ============================================================
alter table planner        enable row level security;
alter table lesson_entry   enable row level security;
alter table evaluation     enable row level security;
alter table shared_artifact enable row level security;
alter table hod_review     enable row level security;

create or replace function current_app_user() returns uuid language sql stable as $$
  select id from app_user where email = auth.jwt() ->> 'email';
$$;

create or replace function is_reviewer() returns boolean language sql stable as $$
  select exists (select 1 from app_user
                 where email = auth.jwt() ->> 'email'
                   and role in ('hod','coordinator','principal','admin'));
$$;

create policy planner_own on planner for all
  using (teacher_id = current_app_user() or is_reviewer())
  with check (teacher_id = current_app_user() or is_reviewer());

create policy lesson_own on lesson_entry for all
  using (exists (select 1 from planner p where p.id = planner_id
                 and (p.teacher_id = current_app_user() or is_reviewer())));

create policy eval_own on evaluation for all
  using (teacher_id = current_app_user() or is_reviewer())
  with check (teacher_id = current_app_user());

-- The bank is readable across the department by default; only the author
-- can change their own entry, and a private artefact leaves the index.
create policy bank_read on shared_artifact for select
  using (visibility <> 'private' or author_id = current_app_user());
create policy bank_write on shared_artifact for all
  using (author_id = current_app_user() or is_reviewer())
  with check (author_id = current_app_user() or is_reviewer());

create policy review_read on hod_review for select using (true);
create policy review_write on hod_review for all
  using (is_reviewer()) with check (is_reviewer());
