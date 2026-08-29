-- LOTS AI — what the teacher changed
-- Addendum D section D5 rule 3: the edit is the feedback signal. Without this
-- table the dogfood fortnight produces impressions rather than evidence.

create table edit_event (
  id              uuid primary key default gen_random_uuid(),
  lesson_entry_id uuid not null references lesson_entry(id) on delete cascade,
  planner_id      uuid not null references planner(id) on delete cascade,
  editor_id       uuid not null references app_user(id),
  field           text not null check (field in ('methodology','resources','differentiation')),
  before_text     text not null,
  after_text      text not null,
  -- planner.origin, denormalised on purpose. "Do adapted plans get edited less
  -- than cold ones?" should be one query, not a join through a planner whose
  -- status has since moved on.
  origin          text not null,
  edited_at       timestamptz not null default now()
);
create index on edit_event (planner_id);
create index on edit_event (field, edited_at);

alter table edit_event enable row level security;

create policy edit_own on edit_event for all
  using (editor_id = current_app_user() or is_reviewer())
  with check (editor_id = current_app_user());
