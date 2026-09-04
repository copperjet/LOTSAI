/**
 * Load the school calendar into the database.
 *
 *   npm run calendar
 *
 * Reads supabase/seed/calendar.json - the transcription of the calendar the school
 * publishes - and upserts academic_year, school_week and school_date from it. Idempotent
 * and safe to run against production: it writes the calendar and touches nothing else,
 * which is why it is its own script rather than part of `npm run seed`. Seeding also
 * creates demo people, classes and workflows; a school that only wants next term's weeks
 * should not have to run that.
 *
 * A week already in the table is updated in place, so its id survives and every planner
 * pointing at it stays attached. Nothing is deleted: a week that disappears from the
 * calendar file is reported and left alone, because deleting it would orphan whatever
 * was planned in it.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('x Supabase env vars missing. Run with: node --env-file=.env.local scripts/load_calendar.mjs');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const calendar = JSON.parse(readFileSync(new URL('../supabase/seed/calendar.json', import.meta.url), 'utf8'));
const YEAR = calendar.academic_year;

const ok = (what) => ({ error }) => {
  if (error) { console.error(`  x ${what}: ${error.message}`); process.exitCode = 1; }
  else console.log(`  . ${what}`);
};

console.log(`calendar ${YEAR} -> ${url}`);

await db.from('academic_year')
  .upsert({ id: YEAR, starts_on: calendar.starts_on, ends_on: calendar.ends_on })
  .then(ok('academic year'));

const weeks = calendar.weeks.map(w => ({
  academic_year: YEAR,
  semester: w.semester,
  week_number: w.week,
  week_commencing: w.commencing,
  week_type: w.type,
  note: w.note ?? null,
}));

// school_week.note arrives with migration 0018, which is applied by hand in the SQL
// editor like every other one on this project. The weeks themselves must not wait for
// that: a term nobody can plan is a worse problem than a week whose note is missing.
let { error: weekError } = await db.from('school_week')
  .upsert(weeks, { onConflict: 'academic_year,semester,week_number' });

if (weekError && /note/.test(weekError.message)) {
  console.log('  ! school_week.note is missing - apply supabase/migrations/0018_calendar.sql.');
  console.log('    Loading the weeks without their notes for now.');
  ({ error: weekError } = await db.from('school_week')
    .upsert(weeks.map(({ note, ...w }) => w), { onConflict: 'academic_year,semester,week_number' }));
}

if (weekError) { console.error(`  x weeks: ${weekError.message}`); process.exitCode = 1; }
else console.log(`  . ${weeks.length} weeks`);

// A week the file no longer describes is left where it is. Somebody may have planned in
// it, and a planner whose week vanished is worse than a week that should not be there.
const { data: stored } = await db.from('school_week')
  .select('semester, week_number, week_commencing').eq('academic_year', YEAR);
const wanted = new Set(weeks.map(w => `${w.semester}|${w.week_number}`));
const extra = (stored ?? []).filter(w => !wanted.has(`${w.semester}|${w.week_number}`));
if (extra.length) {
  console.log(`  ! ${extra.length} week(s) in the database are not in the calendar file, and were left alone:`);
  for (const w of extra) console.log(`      semester ${w.semester} week ${w.week_number}, w/c ${w.week_commencing}`);
}

const dates = (calendar.dates ?? []).map(d => ({
  academic_year: YEAR,
  starts_on: d.starts_on,
  ends_on: d.ends_on ?? null,
  kind: d.kind,
  label: d.label,
  note: d.note ?? null,
}));

const { error: dateError } = await db.from('school_date')
  .upsert(dates, { onConflict: 'academic_year,starts_on,label' });

if (dateError) {
  // 0018 is applied by hand in the SQL editor like every other migration on this
  // project, so say which one rather than printing a Postgres code.
  console.log(`  ! ${dates.length} dates not loaded: ${dateError.message}`);
  console.log('    Apply supabase/migrations/0018_calendar.sql and run this again.');
} else {
  console.log(`  . ${dates.length} dates`);
}

const teaching = weeks.filter(w => w.week_type === 'teaching').length;
console.log(`\n${weeks.length} weeks (${teaching} teaching), semesters `
  + `${[...new Set(weeks.map(w => w.semester))].join(' and ')}, `
  + `${calendar.starts_on} to ${calendar.ends_on}.`);
