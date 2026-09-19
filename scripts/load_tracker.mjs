/**
 * Fill the registry's empty weeks from the KPI coverage tracker.
 *
 *   python scripts/ingest_tracker.py "<tracker.xlsx>" --out supabase/seed
 *   node --env-file=.env.local scripts/load_tracker.mjs
 *   node --env-file=.env.local scripts/load_tracker.mjs --write
 *
 * The curriculum overviews are the registry's source of truth and this is not a
 * second opinion on them. It writes a week only where the overviews left one empty:
 *
 *   - no row at all for that year group, subject, semester and week  -> insert
 *   - a row whose `objectives` is empty                              -> fill it
 *   - a row that already holds objectives                            -> leave it
 *
 * A week both sources hold, with objectives that differ, is recorded in
 * `registry_gap` as a conflict for the head of department to decide in
 * /admin/curriculum - the same place the overviews' own duplicate files land.
 * Choosing a winner here would be exactly the confident wrongness the sign-off gate
 * exists to catch, and the tracker is only 66% filled in its best term.
 *
 * Nothing is signed off, by this or by anything else that is not a person. Weeks
 * written here carry ref_source = 'hod', because a teacher wrote them into the
 * tracker by hand - which is worth telling apart from what a parser read out of an
 * overview PDF.
 *
 * Dry run unless --write, and it prints what it would do either way.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const write = args.includes('--write');
const file = args.find(a => !a.startsWith('--')) ?? 'supabase/seed/tracker_curriculum.json';

const rows = JSON.parse(readFileSync(file, 'utf8'));
if (!rows.length) {
  console.error(`${file} holds no weeks - run scripts/ingest_tracker.py first`);
  process.exit(1);
}
const YEAR = rows[0].academic_year;

// Subjects come from the table, as in scripts/load_curriculum.mjs. The ingest emits
// ids rather than names here because the tracker's own spelling of a subject differs
// from the overviews' ('Art & Design' against 'Art and Design'), so the mapping is
// made once there rather than guessed at twice.
const { data: subjects, error: subjectError } = await db.from('subject').select('id');
if (subjectError) {
  console.error(`cannot read subjects: ${subjectError.message}`);
  process.exit(1);
}
const known = new Set(subjects.map(s => s.id));

const { data: existing, error: registryError } = await db.from('curriculum_week')
  .select('id, year_group, subject_id, semester, week_number, objectives, source_file')
  .eq('academic_year', YEAR);
if (registryError) {
  console.error(`cannot read the registry: ${registryError.message}`);
  process.exit(1);
}

const had = new Map(existing.map(r =>
  [`${r.year_group}|${r.subject_id}|S${r.semester}|${r.week_number}`, r]));

const insert = [], fill = [], conflicts = [];
const skipped = { unknownSubject: new Map(), alreadyHeld: 0 };

for (const w of rows) {
  if (!known.has(w.subject_id)) {
    skipped.unknownSubject.set(w.subject_id, (skipped.unknownSubject.get(w.subject_id) ?? 0) + 1);
    continue;
  }

  const row = {
    academic_year: YEAR,
    year_group: w.year_group,
    subject_id: w.subject_id,
    semester: w.semester,
    week_number: w.week,
    topic_label: w.topic_label || '(from the coverage tracker)',
    objectives: w.objectives,
    activities: [],
    resources: [],
    source_file: w.source_file,
    ref_source: 'hod',
  };

  const seen = had.get(`${w.year_group}|${w.subject_id}|S${w.semester}|${w.week}`);
  if (!seen) { insert.push(row); continue; }

  const held = Array.isArray(seen.objectives) ? seen.objectives : [];
  if (!held.length) { fill.push({ id: seen.id, row }); continue; }

  // Both hold objectives. Identical is not a disagreement, so it is not reported as
  // one; the tracker is often the overview typed up, and a queue full of weeks that
  // agree is a queue nobody reads.
  const same = held.length === w.objectives.length
    && held.every((o, i) => o.text === w.objectives[i].text
      && (o.ref ?? null) === (w.objectives[i].ref ?? null));
  if (same) { skipped.alreadyHeld++; continue; }

  conflicts.push({
    academic_year: YEAR,
    kind: 'conflict',
    year_group: w.year_group,
    subject: w.subject_id,
    semester: w.semester,
    detail: `Week ${w.week}: the curriculum overview holds ${held.length} objective(s) `
      + `and the coverage tracker holds ${w.objectives.length}. `
      + 'Neither was written; decide which document is current for this week.',
    files: [seen.source_file ?? '(overview)', w.source_file],
  });
  skipped.alreadyHeld++;
}

// ── what this would do ──────────────────────────────────────────────────────
const by = new Map();
for (const w of [...insert, ...fill.map(f => f.row)]) {
  const k = `${w.subject_id} ${w.year_group} S${w.semester}`;
  const at = by.get(k) ?? { weeks: 0, coded: 0 };
  at.weeks++;
  if (w.objectives.some(o => o.ref)) at.coded++;
  by.set(k, at);
}
for (const [k, v] of [...by].sort()) {
  console.log(`  ${k.padEnd(26)} ${String(v.weeks).padStart(3)} weeks, ${v.coded} carrying references`);
}

console.log(`\n${rows.length} weeks read from the tracker`);
console.log(`  ${insert.length} weeks the registry does not hold at all`);
console.log(`  ${fill.length} weeks the registry holds with no objectives`);
console.log(`  ${skipped.alreadyHeld} weeks the registry already holds objectives for, left alone`);
console.log(`  ${conflicts.length} of those disagree and would be raised for a decision`);
for (const [id, n] of skipped.unknownSubject) {
  console.log(`  ! ${n} weeks for subject "${id}" - no such row in the subject table`);
}

if (!write) {
  console.log('\nnothing written. Pass --write to load these.');
  process.exit(0);
}

if (insert.length) {
  const { error } = await db.from('curriculum_week')
    .upsert(insert, { onConflict: 'academic_year,year_group,subject_id,semester,week_number' });
  if (error) { console.error(`\nnot inserted: ${error.message}`); process.exit(1); }
}

let filled = 0;
for (const f of fill) {
  const { error } = await db.from('curriculum_week')
    .update({ objectives: f.row.objectives, ref_source: 'hod',
              topic_label: f.row.topic_label })
    .eq('id', f.id);
  if (error) console.error(`  x ${f.row.subject_id} ${f.row.year_group} W${f.row.week_number}: ${error.message}`);
  else filled++;
}

if (conflicts.length) {
  const { error } = await db.from('registry_gap').insert(conflicts);
  // registry_gap arrived in 0006 and migrations here are applied by hand, so a
  // missing table is a missing worklist rather than a failed load.
  if (error) console.error(`  ! conflicts not recorded: ${error.message}`);
}

console.log(`\ninserted ${insert.length}, filled ${filled}, raised ${conflicts.length} conflicts.`);
console.log('None of it is signed off. A head of department signs a subject off in');
console.log('/admin/curriculum, one semester at a time, and until then nothing can be');
console.log('planned or generated from it - which is the point.');
