-- The rest of the school year, and the dates inside it that are not weeks.
--
-- school_week held Semester 1 and nothing else: fifteen rows ending 30 November 2026,
-- so nothing could be planned past that date and a question about Term 2 had no answer.
-- The year is three terms and thirty-nine weeks, and supabase/seed/calendar.json now
-- carries all of it, transcribed from the calendar the school publishes.
--
-- Two things are added here.
--
-- school_week.note - what a week carries besides teaching. "Midterm break, students
-- report back on the 26th" belongs against the week, not in a teacher's memory, and
-- lib/ask.ts reads it into the grounding block with the week itself.
--
-- school_date - the dates that are not weeks. Examination windows, parent conferences,
-- report deadlines, national holidays, sports days. These were on a PNG pinned to a
-- wall and nowhere else, so LOTS AI answered "when do reports go home" by saying the
-- records do not hold it. They are not school_fact: a fact with a home is read from its
-- home, and the calendar is this one's home.
--
-- Safe to re-run.

alter table school_week
  add column if not exists note text;

create table if not exists school_date (
  id            uuid primary key default gen_random_uuid(),
  academic_year text not null references academic_year(id) on delete cascade,
  starts_on     date not null,
  -- Null for a single day. A range is inclusive of both ends, as the printed
  -- calendar states them ("19 to 26 October").
  ends_on       date,
  kind          text not null
                check (kind in ('term','break','inset','exam','assessment','conference','report','holiday','event')),
  label         text not null,
  -- Anything a teacher needs alongside the date: which year groups it applies to,
  -- that school ends at 1pm, that the printed calendar contradicts itself.
  note          text,
  unique (academic_year, starts_on, label)
);

create index if not exists school_date_year on school_date (academic_year, starts_on);

alter table school_date enable row level security;

-- Everyone past the door reads the calendar; only a reviewer changes it. The same
-- shape as registry_gap (0006) and school_fact (0016), and the same reason: the
-- anon key is in the browser bundle, so read is the only thing it may do.
create policy school_date_read  on school_date for select using (true);
create policy school_date_write on school_date for all
  using (is_reviewer()) with check (is_reviewer());
