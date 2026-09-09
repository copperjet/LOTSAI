-- The weekly report a head of department owes upward, and who it goes to.
--
-- Every week each HOD hand-types an Excel file - "HOD WEEKLY ACADEMIC REPORT -
-- QUALITATIVE" - and emails it to the Coordinators and the Principal. Six fixed Areas
-- with an evidence column and a follow-up column, four summary boxes, and an overall
-- comment. The Week 2 ICT report is the specimen this table was shaped against.
--
-- Four of that report's six evidence rows said "not done yet" or "not checked", and the
-- curriculum row said there was "a lag ... due to missed classes". Every one of those is
-- a sentence written from memory on a Thursday evening. The counts behind them are
-- already in this database - planners, evaluations, hod_review, homework, and coverage
-- computed in 0002_functions.sql - so the evidence column arrives filled in and the head
-- of department spends the hour on the judgement instead of the recall.
--
-- One table with a jsonb body, not a table plus a rows child table. The six Areas and
-- four summary boxes are a fixed grid defined by a form, not a variable-length
-- collection: a child table would be exactly six rows per report, every one carrying an
-- area value from a closed enum, joined on every read, answering no question a jsonb
-- path cannot. The precedent is homework.content and study_pack.content. planner /
-- lesson_entry is not the precedent - lesson entries vary in count and are individually
-- addressed by PATCH /api/plan/lesson.
--
-- The decisive argument is archival. A report is emailed and then read a year later. It
-- has to render identically then, without joining to a klass table that has since been
-- re-timetabled or to a registry that has been revised. One row that contains the whole
-- document is what makes that true - the same reasoning 0017 gives for storing a study
-- pack revision whole rather than as a diff.
--
-- Carry-forward has no table of its own either. Last week's follow-up commitments and
-- unresolved asks are copied into this week's body when the report is opened, each one
-- carrying the week it was raised, so its age is week_number - raised_week and nobody
-- ever walks the chain. Whether a commitment is closed is a human judgement, in the same
-- category as hod_review.comment and lesson_entry.teacher_comment, both of which 0001
-- marks as never written by a model.
--
-- report_recipient is deliberately not derived from app_user.role. A deputy who should
-- be copied is not a coordinator, and a coordinator on leave should come off the list
-- without their role changing. It is seeded with nothing: an empty list is a refusal
-- with a message, not a silent send.
--
-- Applied by hand in the Supabase SQL editor like every migration here
-- (CONTINUE_HERE.md), so every route that reads these two tables tolerates this file not
-- having been applied. PostgREST answers a missing relation in `error` rather than by
-- throwing, which is what has to be checked - a bare try/catch sees nothing and the
-- agenda 500s for every head of department in the school.
--
-- Safe to re-run.

-- ============================================================
-- the report
-- ============================================================

create table if not exists hod_report (
  id             uuid primary key default gen_random_uuid(),
  academic_year  text not null default '2026-27' references academic_year(id),
  -- app_user.department, free text. It reads the same as subject.department for ICT and
  -- for nothing else yet (0021), which is why the prefill degrades to an honest blank
  -- elsewhere rather than silently reporting a department as having done no work. Not a
  -- foreign key, because there is no departments table to point at.
  department     text not null,
  -- The semester travels with the week number because both semesters have a week 1,
  -- exactly as the agenda's planner payload does.
  semester       smallint not null check (semester in (1, 2)),
  week_number    smallint not null,
  school_week    uuid references school_week(id),
  hod_id         uuid not null references app_user(id),
  -- Row 4 of the sheet. school_week.week_commencing + 4 days when the report is created,
  -- and then stored: a document that has been sent must print the same date next year
  -- even if the calendar it was derived from is later corrected.
  week_ending    date not null,
  -- The whole document. See the column comment below for its shape.
  body           jsonb not null default '{}'::jsonb,
  -- Two states, not five. There is no reviewer here - the report is the review - and a
  -- 'previewed' state would record a fact about somebody's screen rather than about the
  -- school.
  status         text not null default 'draft' check (status in ('draft', 'sent')),
  prefilled_at   timestamptz,
  submitted_at   timestamptz,                        -- 'Date Submitted' on the sheet
  sent_at        timestamptz,
  sent_to        text[] not null default '{}',       -- resolved server-side at send time
  mail_id        text,                               -- the Gmail message id
  storage_path   text,                               -- the rendered .html in the artefacts bucket
  pdf_path       text,                               -- the rendered .pdf, the thing attached
  created_at     timestamptz not null default now(),
  -- One report per department per week. The report belongs to the department, not to the
  -- person: a head changing mid-year continues the series rather than starting a new one.
  unique (academic_year, department, semester, week_number)
);

comment on column hod_report.body is
  'version; '
  'areas{curriculum_coverage|lesson_plans|class_observations|teacher_coaching|'
  'homework_record|book_check}{findings, action, prefill, edited}; '
  'carried[]{id, kind, area, text, raised_week, raised_on, status, note}; '
  'summary{positives, concerns, priorities, support}; '
  'overall; '
  'evidence{} - the counts each prefill sentence was computed from, kept so a disputed '
  'sentence can be recomputed rather than argued about. `prefill` holds what the records '
  'said and `edited` says whether a person has since touched `findings`, which is what '
  'lets the report be reopened without clobbering what was typed into it.';

comment on column hod_report.sent_to is
  'The addresses it actually went to, resolved from report_recipient at send time. Stored '
  'because that list is editable, and the question asked later is who received this '
  'report - not who would receive one today.';

-- Exactly the carry-forward read: the previous report in this department's series.
create index if not exists hod_report_series
  on hod_report (department, academic_year, semester, week_number desc);

alter table hod_report enable row level security;

-- is_reviewer() is deliberately not used here. It includes every hod, and one head of
-- department has no business reading another's account of their teachers. The readers
-- upward are the coordinator and the principal.
create policy hod_report_read on hod_report for select
  using (hod_id = current_app_user()
         or exists (select 1 from app_user u
                    where u.id = current_app_user()
                      and u.role in ('coordinator', 'principal', 'admin')));

create policy hod_report_write on hod_report for all
  using (hod_id = current_app_user())
  with check (hod_id = current_app_user());

-- ============================================================
-- who it goes to
-- ============================================================

create table if not exists report_recipient (
  id            uuid primary key default gen_random_uuid(),
  -- Null means every department. A row naming a department does not override the null
  -- rows; both apply, and resolution is the union.
  department    text,
  email         text not null,
  full_name     text not null,                       -- shown in the card before the send
  kind          text not null default 'to' check (kind in ('to', 'cc')),
  is_active     boolean not null default true,       -- off for a term, without losing the row
  note          text,
  created_at    timestamptz not null default now(),
  -- Named departments. The null-department case needs its own index, below: Postgres
  -- treats nulls as distinct in a unique constraint, so this one alone would happily
  -- allow the same address twice for every-department at once. drive_folder (0009) has
  -- that trap open; this table does not.
  unique (department, email)
);

create unique index if not exists report_recipient_all_departments
  on report_recipient (email) where department is null;

comment on table report_recipient is
  'Recipients of the HOD weekly report. A null department applies to every department; a '
  'named one adds to it. Resolution is the union, deduplicated on email, with to winning '
  'over cc where a person appears in both. Maintained at /admin/reports. Deliberately not '
  'derived from app_user.role: a deputy who should be copied is not a coordinator, and a '
  'coordinator on leave should come off the list without their role changing.';

alter table report_recipient enable row level security;

-- Read by anyone past the gate: a head of department has to be shown who their report
-- will go to before they send it, and seeing that list is not the same as changing it.
create policy report_recipient_read on report_recipient for select using (true);

create policy report_recipient_write on report_recipient for all
  using (exists (select 1 from app_user u
                 where u.id = current_app_user() and u.role in ('principal', 'admin')))
  with check (exists (select 1 from app_user u
                      where u.id = current_app_user() and u.role in ('principal', 'admin')));
