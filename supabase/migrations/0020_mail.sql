-- Email: each teacher's own mailbox, connected by that teacher.
--
-- Everything else Google in this codebase goes through one service account
-- (lib/drive.ts) precisely so that nobody has to log in to Google. Mail cannot work
-- that way. A service account can only reach a mailbox through domain-wide
-- delegation, which is one administrator granting one application the right to read
-- every inbox in the school, silently and permanently. That is the wrong shape for a
-- teacher's private correspondence with a parent, and it would not reach the staff
-- whose address is not on the school domain at all (emails.txt has one). So this is
-- the one place where a per-person Google consent is worth what it costs: the teacher
-- sees the scopes, grants them, and can withdraw them from their own Google account
-- without asking anyone here.
--
-- Three tables:
--
--   1. mail_account  — the connection itself, one row per teacher. The refresh token
--      is the whole prize: it is long-lived and it opens the mailbox. It is stored
--      encrypted (lib/mail/crypto.ts, AES-256-GCM, key in MAIL_TOKEN_KEY) so that a
--      database dump, or the service-role key leaking, is not the same event as
--      twenty mailboxes being readable. The column is bytea and named for what it
--      holds so nobody later writes a plaintext token into it by habit.
--
--   2. mail_message  — what triage decided about a message. Not a copy of the
--      mailbox: subject, sender, snippet and the classification, no body. The body
--      stays at Google and is fetched when a teacher opens the message. Keeping this
--      at all is what stops the school paying a model call every time an inbox is
--      re-listed.
--
--   3. mail_action   — what LOTS AI did to a mailbox, and on whose say-so. Every
--      draft, send, label and archive lands here before or as it happens. audit_log
--      records the act; this records the target and the approval, which is what
--      somebody asks about when a parent says they got a reply nobody remembers
--      writing.
--
-- Safe to re-run.

create table if not exists mail_account (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user(id) on delete cascade,
  email           text not null,                 -- the Google account actually connected
  refresh_token   bytea not null,                -- AES-256-GCM, never plaintext
  scopes          text[] not null default '{}',
  history_id      text,                          -- Gmail's cursor, for incremental sync
  last_sync_at    timestamptz,
  connected_at    timestamptz not null default now(),
  revoked_at      timestamptz,
  unique (user_id)
);
create index if not exists mail_account_live on mail_account (user_id) where revoked_at is null;

comment on column mail_account.refresh_token is
  'AES-256-GCM ciphertext (iv || tag || data). Decrypted only in lib/mail/crypto.ts, server-side.';

create table if not exists mail_message (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_user(id) on delete cascade,
  gmail_id      text not null,
  thread_id     text not null,
  from_name     text,
  from_email    text,
  subject       text,
  snippet       text,
  received_at   timestamptz,
  unread        boolean not null default true,
  -- Triage, as lib/mail/triage.ts returns it. Null until classified.
  category      text,       -- parent | student | staff | leadership | admin | external | notice
  urgency       text,       -- now | today | week | none
  summary       text,       -- one line, in the teacher's own terms
  suggested     text,       -- what LOTS AI thinks the next move is
  needs_reply   boolean,
  -- A message that tried to give LOTS AI instructions, or asked for a code, a
  -- password or a forwarding address. Flagged rather than merely refused: the first
  -- one of these is usually the start of a run against the whole staff list.
  suspicious    boolean not null default false,
  classified_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, gmail_id)
);
create index if not exists mail_message_box
  on mail_message (user_id, received_at desc);
create index if not exists mail_message_todo
  on mail_message (user_id, needs_reply, urgency) where needs_reply;
create index if not exists mail_message_flagged
  on mail_message (user_id, received_at desc) where suspicious;

comment on table mail_message is
  'Triage only — headers and a verdict. Message bodies are never stored; they are read from Gmail on demand.';

create table if not exists mail_action (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  kind        text not null,          -- draft | send | archive | read | label | connect | disconnect
  gmail_id    text,
  thread_id   text,
  to_addrs    text[],
  subject     text,
  body        text,                   -- exactly what was drafted or sent, kept verbatim
  approved_by uuid references app_user(id),   -- who pressed the button; never null for send
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists mail_action_recent on mail_action (user_id, created_at desc);

comment on column mail_action.approved_by is
  'The person who authorised this. A send row without it is a bug, not a record.';

alter table mail_account enable row level security;
alter table mail_message enable row level security;
alter table mail_action  enable row level security;

-- A mailbox is one person's. Not the reviewer's, not the administrator's: an
-- administrator who needs to know that mail is being handled reads mail_action
-- through the service role in /admin, and still cannot read the correspondence,
-- because the correspondence is not here.
create policy mail_account_own on mail_account for all
  using (user_id = current_app_user()) with check (user_id = current_app_user());
create policy mail_message_own on mail_message for all
  using (user_id = current_app_user()) with check (user_id = current_app_user());
create policy mail_action_own  on mail_action  for all
  using (user_id = current_app_user()) with check (user_id = current_app_user());
