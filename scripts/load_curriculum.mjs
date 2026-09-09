/**
 * Load ingested curriculum weeks into `curriculum_week`, one department at a time.
 *
 *   npm run ingest                                    # overviews -> curriculum.json
 *   node --env-file=.env.local scripts/load_curriculum.mjs <file> --subjects COMP,ICT,IT
 *   node --env-file=.env.local scripts/load_curriculum.mjs <file> --subjects COMP,ICT,IT --write
 *
 * scripts/seed.mjs already loads a registry, but it is the demo bootstrap: it rewrites
 * people, classes and the resource inventory alongside it, it hardcodes the four
 * subjects it knows, it takes semester 1 only, and it signs weeks off on the HOD's
 * behalf. None of that is safe or right for bringing a real department into a school
 * that is already using the app.
 *
 * So this does one thing. It writes `curriculum_week` and nothing else:
 *
 *   - Subjects come from the `subject` table, matched on the name the importer emits,
 *     so adding a subject is a migration rather than an edit here.
 *   - Both semesters. The overviews for IGCSE and A Level are written a semester at a
 *     time and the second one is not an afterthought.
 *   - Nothing is signed off. A week that nobody has read is not a week anybody may
 *     generate from, and pretending otherwise is the one thing the sign-off gate
 *     exists to prevent. The HOD signs off in /admin/curriculum.
 *   - Dry run unless --write, and it prints what it would do either way.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const write = args.includes('--write');
const file = args.find(a => !a.startsWith('--')) ?? 'supabase/seed/curriculum.json';
const only = (args.find(a => a.startsWith('--subjects='))?.split('=')[1]
  ?? (args.includes('--subjects') ? args[args.indexOf('--subjects') + 1] : ''))
  .split(',').map(s => s.trim()).filter(Boolean);

const calendar = JSON.parse(
  readFileSync(new URL('../supabase/seed/calendar.json', import.meta.url), 'utf8'));
const YEAR = calendar.academic_year;

/** The last week number each semester actually has. A week the calendar does not
 *  hold is not a week, whatever an overview numbered it. */
const lastWeek = {};
for (const w of calendar.weeks) {
  lastWeek[w.semester] = Math.max(lastWeek[w.semester] ?? 0, w.week);
}

const { data: subjects, error: subjectError } = await db.from('subject').select('id, name');
if (subjectError) {
  console.error(`cannot read subjects: ${subjectError.message}`);
  process.exit(1);
}
// The importer emits subject *names* ('Computing', 'ICT', 'Information Technology'),
// which is why those names are load-bearing in 0020_ict_department.sql. A name it emits
// that no subject row claims is reported, not guessed at.
const idByName = new Map(subjects.map(s => [s.name, s.id]));

const rows = JSON.parse(readFileSync(file, 'utf8'));

const skipped = { unknownSubject: new Map(), pastCalendar: 0, notWanted: 0 };
const weeks = [];
for (const r of rows) {
  const subject_id = idByName.get(r.subject);
  if (!subject_id) {
    skipped.unknownSubject.set(r.subject, (skipped.unknownSubject.get(r.subject) ?? 0) + 1);
    continue;
  }
  if (only.length && !only.includes(subject_id)) { skipped.notWanted++; continue; }
  const semester = r.semester === 2 ? 2 : 1;
  if (r.week > (lastWeek[semester] ?? 0)) { skipped.pastCalendar++; continue; }
  weeks.push({
    academic_year: YEAR,
    year_group: r.year_group,
    subject_id,
    semester,
    week_number: r.week,
    topic_label: r.topic_label,
    objectives: r.objectives,
    activities: r.activities ?? [],
    resources: r.resources ?? [],
    source_file: r.source_file,
  });
}

// One row per week is what the table allows, but an overview may legitimately carry
// two units in the same week - the IGCSE ICT overviews run a theory topic and a
// practical one side by side all year. Those arrive as separate rows and collide on
// the key, so they are merged into the one week they describe.
//
// Two *different files* claiming the same week is a different thing: that is a
// question for the HOD, and picking a winner here would be exactly the confident
// wrongness the sign-off gate exists to catch. Reported, never resolved.
const merged = new Map();
const conflicts = [];
const dedupe = (a, b, of) => {
  const out = [...a];
  for (const item of b) if (!out.some(x => of(x) === of(item))) out.push(item);
  return out;
};

for (const w of weeks) {
  const key = `${w.year_group}|${w.subject_id}|S${w.semester}|${w.week_number}`;
  const seen = merged.get(key);
  if (!seen) { merged.set(key, w); continue; }

  if (seen.source_file === w.source_file) {
    seen.topic_label = seen.topic_label === w.topic_label
      ? seen.topic_label
      : `${seen.topic_label} · ${w.topic_label}`;
    seen.objectives = dedupe(seen.objectives, w.objectives, o => `${o.ref ?? ''}|${o.text}`);
    seen.activities = dedupe(seen.activities, w.activities, String);
    seen.resources = dedupe(seen.resources, w.resources, String);
  } else {
    conflicts.push(`${key}: ${seen.source_file} and ${w.source_file}`);
  }
}

const registry = [...merged.values()].sort((a, b) =>
  a.subject_id.localeCompare(b.subject_id) || a.year_group.localeCompare(b.year_group)
  || a.semester - b.semester || a.week_number - b.week_number);

// ── what this would do ──────────────────────────────────────────────────────
const by = new Map();
for (const w of registry) {
  const k = `${w.subject_id} ${w.year_group} S${w.semester}`;
  const at = by.get(k) ?? { weeks: 0, coded: 0 };
  at.weeks++;
  if (w.objectives.some(o => o.ref)) at.coded++;
  by.set(k, at);
}
for (const [k, v] of [...by].sort()) {
  console.log(`  ${k.padEnd(26)} ${String(v.weeks).padStart(3)} weeks, ${v.coded} carrying references`);
}
console.log(`\n${registry.length} weeks from ${weeks.length} rows`
  + (weeks.length - registry.length ? ` (${weeks.length - registry.length} same-week rows merged)` : ''));

for (const [name, n] of skipped.unknownSubject) {
  console.log(`  ! ${n} rows for "${name}" - no subject row has that name`);
}
if (skipped.pastCalendar) console.log(`  ! ${skipped.pastCalendar} rows past the last week the calendar holds`);
for (const c of conflicts) console.log(`  ! two files claim ${c}`);

if (!write) {
  console.log('\nnothing written. Pass --write to load these.');
  process.exit(0);
}

const { error } = await db.from('curriculum_week')
  .upsert(registry, { onConflict: 'academic_year,year_group,subject_id,semester,week_number' });

if (error) {
  console.error(`\nnot loaded: ${error.message}`);
  process.exit(1);
}

console.log(`\nloaded ${registry.length} weeks, none signed off.`);
console.log('A head of department signs them off in /admin/curriculum. Until then nothing');
console.log('can be planned or generated from them, which is the point.');
