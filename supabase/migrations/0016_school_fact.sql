-- School facts: what the school knows about itself that no other table holds.
--
-- lib/ask.ts grounds every question in the calendar, the registry, the subjects and
-- (since this migration's companion change) the staff list. Those answer "when does
-- school open", "what does CP4 Maths cover in week 3" and "who is the HOD for Science"
-- because each is a row somewhere. A whole class of ordinary question is not:
--
--   what is the uniform policy
--   who is the safeguarding lead
--   how is work marked
--   when are reports sent home
--
-- Nothing in the schema holds these, so the model correctly answered that the records
-- are silent - which is right, and useless. This table is where they go.
--
-- It is deliberately NOT a knowledge base in the retrieval sense. A school has tens of
-- these, not thousands: the whole set joins the cached prefix in schoolBlock() the same
-- way the calendar does, and no embedding, index or similarity search is involved. If
-- it ever reaches the hundreds, that is the point to reconsider - not before.
--
-- What must never happen here is a fact that duplicates a table. "Mrs Banda is the Head
-- of Science" does not belong in this table: app_user holds it, /admin/people maintains
-- it, and a written-down copy goes stale the day somebody is promoted while still
-- reading as authoritative. The rule is the one the registry already follows - a fact
-- with a home is read from its home.
--
-- Safe to re-run.

create table if not exists school_fact (
  id            uuid primary key default gen_random_uuid(),
  academic_year text not null,
  -- What the fact is about, in the words a teacher would ask it in: "Uniform",
  -- "Safeguarding", "Marking policy". It is what the model matches the question to.
  topic         text not null,
  body          text not null,
  -- Where it came from, for a person deciding whether it is still true - "Staff
  -- handbook 2026, p4", "Principal's email 12 Aug". Never shown to the asker; it is
  -- for the administrator reviewing the list a year later.
  source_note   text,
  added_by      uuid references app_user(id),
  added_at      timestamptz not null default now(),
  -- Soft delete. A withdrawn policy must stop being served immediately, but the
  -- record of having said it has to survive - a teacher who acted on last year's
  -- uniform rule needs the school to be able to see what it was telling them.
  retired_at    timestamptz
);

-- The read schoolBlock() does on every question: this year's live facts, in a stable
-- order so the cached prefix is byte-identical between calls and actually caches.
create index if not exists school_fact_live
  on school_fact (academic_year, topic)
  where retired_at is null;

-- ── RLS, mirroring the existing policies (0001, 0007) ───────────────────────
alter table school_fact enable row level security;

-- Everyone past the gate reads them - that is the point of them. Only an
-- administrator or the principal writes, which /api/school-fact enforces as well;
-- is_reviewer() is wider than that (it includes HODs and coordinators), so the
-- route is the tighter of the two guards and the one that decides.
create policy school_fact_read  on school_fact for select using (true);
create policy school_fact_write on school_fact for all
  using (is_reviewer()) with check (is_reviewer());
