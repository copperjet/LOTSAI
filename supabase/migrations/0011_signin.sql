-- Sign-in, so that "who did this" stops being a guess.
--
-- Until now currentUser() read DEMO_USER_EMAIL, and POST /api/whoami let anyone
-- past the shared school password become any member of staff, HOD included.
-- Every ai_usage.user_id and every audit_log.actor_id written before this
-- migration therefore names a seat, not a person, and should be read that way.
--
-- This is not Google Workspace SSO. It is a personal PIN behind the school
-- password, which is enough to attribute work and to revoke a device, and is
-- the most that can be built without Google Cloud credentials. When SSO
-- arrives, user_session is what it replaces.

alter table app_user
  add column if not exists pin_hash        text,
  add column if not exists pin_set_at      timestamptz,
  add column if not exists last_seen_at    timestamptz,
  add column if not exists is_active       boolean not null default true,
  add column if not exists failed_attempts int not null default 0,
  add column if not exists locked_until    timestamptz;

comment on column app_user.pin_hash is
  'pbkdf2$iterations$salt$hash, per lib/auth.ts. Null means the PIN has never been set: the next sign-in chooses one.';

-- One row per signed-in device. The token itself is never stored - only its
-- SHA-256 - so a leaked backup of this table cannot be used to sign in.
create table if not exists user_session (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user(id) on delete cascade,
  token_hash   text unique not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days'
);
create index if not exists user_session_user_idx on user_session (user_id, last_seen_at desc);
create index if not exists user_session_expiry_idx on user_session (expires_at);

-- app_user now holds pin_hash, and user_session holds live credentials, so both
-- are locked shut. NEXT_PUBLIC_SUPABASE_ANON_KEY is in the browser bundle by
-- definition, and anything the anon role can read is therefore public.
-- Every route reaches these through the service-role client, which is not
-- subject to RLS, so no policy is needed - only the absence of one.
alter table app_user     enable row level security;
alter table user_session enable row level security;
revoke all on user_session from anon, authenticated;
