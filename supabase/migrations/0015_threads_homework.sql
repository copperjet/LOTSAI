-- Saved threads, homework as its own artefact, and a note on degraded renders.
--
-- Three unrelated things in one migration because migrations are applied by hand here
-- (see CONTINUE_HERE.md) and three round trips to the SQL editor is three chances to
-- apply two of them. Nothing below is destructive, and every route tolerates the whole
-- file not having been applied yet.


-- 1 ------------------------------------------------------------------ render_note
--
-- Why a study pack's PDF is the plain pdf-lib rendering rather than the browser print
-- of its own page. storeArtefact records success either way, so a degraded render was
-- indistinguishable from a good one: the headless browser had been failing in
-- production and the first anyone knew of it was a teacher opening a PDF with nothing
-- in it. Null means the browser printed it. See lib/pdf/renderers/studypack_print.ts.
alter table study_pack
  add column if not exists render_note text;


-- 2 ------------------------------------------------------------------ chat threads
--
-- The thread used to live only in the browser tab: turns were React elements, which
-- cannot be serialised, so nothing could be saved and nothing could be returned to.
-- One conversation grew for as long as the tab was open and the only way to clear it
-- was a button that did not say it would.
--
-- A turn is now data - a kind and a payload (app/page.tsx, `Turn`) - so it stores as
-- jsonb and redraws into the same cards, with the same working buttons, because those
-- act on ids the payload carries.
create table if not exists chat_thread (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  -- Written from the first thing that happens in the thread - the teacher's own words,
  -- or the workflow they started. Never asked for.
  title       text not null default 'New task',
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists chat_thread_recent on chat_thread (user_id, updated_at desc)
  where not archived;

create table if not exists chat_turn (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references chat_thread(id) on delete cascade,
  -- Position in the thread, not a timestamp: two turns written in the same millisecond
  -- still have an order, and it is the order they were said in.
  seq         int not null,
  who         text not null check (who in ('user', 'ai')),
  -- null for a teacher's turn; the TurnKind for LOTS AI's own.
  kind        text,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  unique (thread_id, seq)
);
create index if not exists chat_turn_thread on chat_turn (thread_id, seq);

alter table chat_thread enable row level security;
alter table chat_turn enable row level security;

-- A thread is one person's. Not the department's, not a reviewer's: it holds working
-- notes and half-finished questions, and nothing in the product needs anyone else to
-- read it. The bank is where shared work lives.
create policy chat_thread_own on chat_thread for all
  using (user_id = current_app_user())
  with check (user_id = current_app_user());
create policy chat_turn_own on chat_turn for all
  using (exists (select 1 from chat_thread t where t.id = thread_id and t.user_id = current_app_user()))
  with check (exists (select 1 from chat_thread t where t.id = thread_id and t.user_id = current_app_user()));


-- 3 ------------------------------------------------------------------ homework
--
-- The third generated artefact, and the reason for it: asked to "create a homework",
-- LOTS AI answered with one written into the chat as if it were a fact from the
-- school's records, and then refused to put it on a document. It had no homework
-- workflow to route to - only a worksheet, which is a different thing. A worksheet is
-- three tiers of the same task for a lesson; homework is a timed paper a learner does
-- alone, in sections, with marks and an answer key.
--
-- Cloned from `worksheet` (migration 0010), including the bank fields and the drive_*
-- columns, because approval delivers it to the subject's Drive folder by the same
-- path. Consolidating the three artefact banks is still a later refactor.
create table if not exists homework (
  id             uuid primary key default gen_random_uuid(),
  work_key       text not null,                       -- lib/workkey.ts, artefact_type 'homework'
  academic_year  text not null default '2026-27',
  year_group     text not null,
  subject_id     text not null references subject(id),
  class_id       text references klass(id),
  week_number    smallint not null,
  title          text not null,
  objective_refs text[] not null default '{}',        -- retrieved, never generated
  content        jsonb not null,                      -- {title, intro, duration_minutes, sections[], teacher_note}
  author_id      uuid not null references app_user(id),
  status         text not null default 'draft'
                 check (status in ('draft','approved','returned')),
  approved       boolean not null default false,
  reuse_count    int not null default 0,
  storage_path   text,                                -- the rendered .html in the artefacts bucket
  drive_file_id  text,
  drive_link     text,
  created_at     timestamptz not null default now(),
  approved_at    timestamptz
);
create index if not exists homework_work_key on homework (work_key);
create index if not exists homework_scope on homework (subject_id, year_group, week_number);
create index if not exists homework_refs on homework using gin (objective_refs);

alter table homework enable row level security;

-- Approved homework is readable across the department; a draft is the author's. The
-- same policy worksheet and study_pack carry.
create policy homework_read on homework for select
  using (approved or author_id = current_app_user() or is_reviewer());
create policy homework_write on homework for all
  using (author_id = current_app_user() or is_reviewer())
  with check (author_id = current_app_user() or is_reviewer());
