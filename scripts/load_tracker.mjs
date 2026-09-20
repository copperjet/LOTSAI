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
 *   - any week the calendar calls a break                            -> skip it
 *
 * A week both sources hold, with objectives that differ, is written to
 * supabase/seed/tracker_conflicts.json with both sets side by side, and nothing is
 * written to the registry for it. Choosing a winner here would be exactly the
 * confident wrongness the sign-off gate exists to catch, and the tracker is only
 * 66% filled in its best term. See `queueConflicts` below for why the report is a
 * file rather than the head of department's worklist.
 *
 * Nothing is signed off, by this or by anything else that is not a person. Weeks
 * written here carry ref_source = 'hod', because a teacher wrote them into the
 * tracker by hand - which is worth telling apart from what a parser read out of an
 * overview PDF.
 *
 * Dry run unless --write, and it prints what it would do either way.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const write = args.includes('--write');
const file = args.find(a => !a.startsWith('--')) ?? 'supabase/seed/tracker_curriculum.json';

/**
 * Where a disagreement between the two documents goes.
 *
 * Not into `registry_gap` by default, which is what this used to do. That table is
 * the head of department's worklist and /admin/curriculum offers a decision against
 * every row in it - but a decision recorded there is read by nothing. The only code
 * that reads a conflict decision is scripts/ingest_overviews.py, through a
 * `conflict_resolutions.json` that nothing writes and that does not exist, and that
 * mechanism is file-level in any case: which of two overview documents is current,
 * not which of two documents is right about week 6. So 341 rows would have arrived
 * in the worklist offering a button that does nothing, burying the ten real
 * file-level conflicts that do have a resolution path.
 *
 * They go to a report instead. The information is worth having - it is every week
 * the school has described twice and differently - and a file can be read without
 * promising an action that is not implemented. `--conflicts` puts them in the queue
 * as well, for whoever builds that resolution loop.
 */
const queueConflicts = args.includes('--conflicts');
const REPORT = 'supabase/seed/tracker_conflicts.json';

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

// Weeks the school does not teach in.
//
// The tracker is a grid, so every class has a row for every week of the term whether
// or not anything happens in it, and a teacher filling the grid down writes the next
// unit into the break week as readily as into any other. The registry's own break
// weeks carry no objectives - scripts/ingest_overviews.py drops the "Mid-Term Break"
// line rather than importing it as something to teach - which would make them look
// exactly like a week waiting to be filled. Eight of them were.
//
// Only 'break' is refused. A revision week revises something and an exam week
// examines something, and both are weeks a teacher plans for.
const { data: calendar, error: calendarError } = await db.from('school_week')
  .select('semester, week_number, week_type').eq('academic_year', YEAR);
if (calendarError) {
  console.error(`cannot read the calendar: ${calendarError.message}`);
  process.exit(1);
}
const notTaught = new Set(calendar.filter(w => w.week_type === 'break')
  .map(w => `S${w.semester}|${w.week_number}`));

// Paged. PostgREST stops at 1000 rows and says nothing about it, and this read is
// what decides whether a week is already held - so capped, it would have called 683
// weeks it could not see "not in the registry" and overwritten the overview's
// objectives with the tracker's on the next run.
const existing = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('curriculum_week')
    .select('*').eq('academic_year', YEAR).range(from, from + 999);
  if (error) {
    console.error(`cannot read the registry: ${error.message}`);
    process.exit(1);
  }
  if (!data.length) break;
  existing.push(...data);
  if (data.length < 1000) break;
}

const had = new Map(existing.map(r =>
  [`${r.year_group}|${r.subject_id}|S${r.semester}|${r.week_number}`, r]));

/**
 * Whether the registry can record where an objective came from.
 *
 * `ref_source` arrives in 0005_objective_provenance.sql, and migrations here are
 * applied by hand in the SQL editor - so the column may simply not be there, and an
 * insert naming it fails the whole batch rather than one row. Nothing in the
 * application reads it today; it is a marker for telling a week a teacher typed into
 * the tracker apart from a week a parser read out of an overview, which matters when
 * somebody later asks why a signed-off week says what it says.
 *
 * So it is written when it exists and skipped when it does not, and the run says
 * which happened rather than failing or quietly dropping provenance.
 */
const hasProvenance = existing.length > 0 && 'ref_source' in existing[0];

/** A week's objectives as one comparable run of text: refs kept, everything that
 *  differs between a PDF and a spreadsheet cell thrown away. */
const flatten = objs => objs
  .map(o => `${o.ref ?? ''} ${o.text}`)
  .join(' ')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const insert = [], fill = [], conflicts = [];
const skipped = { unknownSubject: new Map(), alreadyHeld: 0, notTaught: 0 };

for (const w of rows) {
  if (!known.has(w.subject_id)) {
    skipped.unknownSubject.set(w.subject_id, (skipped.unknownSubject.get(w.subject_id) ?? 0) + 1);
    continue;
  }

  if (notTaught.has(`S${w.semester}|${w.week}`)) { skipped.notTaught++; continue; }

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
    ...(hasProvenance ? { ref_source: 'hod' } : {}),
  };

  const seen = had.get(`${w.year_group}|${w.subject_id}|S${w.semester}|${w.week}`);
  if (!seen) { insert.push(row); continue; }

  const held = Array.isArray(seen.objectives) ? seen.objectives : [];
  if (!held.length) { fill.push({ id: seen.id, row }); continue; }

  // Both hold objectives. Identical is not a disagreement, so it is not reported as
  // one; the tracker is often the overview typed up, and a report full of weeks that
  // agree is a report nobody reads.
  //
  // Compared as one run of text rather than item by item. The two documents break
  // the same objectives in different places - the overview puts the strand on its own
  // line and the tracker runs it into the sentence, so "Experiencing" + "E.01
  // Encounter, sense, experiment with..." meets "Experiencing E.01 Encounter, sense,
  // experiment with..." - and item-by-item called every one of those a disagreement.
  // Punctuation and case go too, because they differ between a PDF and a spreadsheet
  // cell for reasons that have nothing to do with what is taught.
  if (flatten(held) === flatten(w.objectives)) { skipped.alreadyHeld++; continue; }

  conflicts.push({
    year_group: w.year_group,
    subject_id: w.subject_id,
    semester: w.semester,
    week: w.week,
    overview: { source: seen.source_file ?? '(overview)', objectives: held },
    tracker: { source: w.source_file, objectives: w.objectives },
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
console.log(`  ${skipped.notTaught} weeks falling in a break, skipped - the school teaches nothing then`);
if (!hasProvenance) {
  console.log('  ! curriculum_week has no ref_source column, so these weeks will not be');
  console.log('    marked as tracker-written. Apply 0005_objective_provenance.sql and re-run');
  console.log('    to record it. Nothing else depends on it.');
}
console.log(`  ${conflicts.length} of those disagree - written to the report, not to the queue`);
for (const [id, n] of skipped.unknownSubject) {
  console.log(`  ! ${n} weeks for subject "${id}" - no such row in the subject table`);
}

// ── the disagreements ───────────────────────────────────────────────────────
//
// Written whatever else this run does, including a dry run: reading them is the
// point, and reading them should not cost a write to anything.
if (conflicts.length) {
  const bySubject = new Map();
  for (const c of conflicts) {
    const k = `${c.subject_id} ${c.year_group} S${c.semester}`;
    bySubject.set(k, [...(bySubject.get(k) ?? []), c.week].sort((a, b) => a - b));
  }

  writeFileSync(REPORT, JSON.stringify({
    academic_year: YEAR,
    generated_at: new Date().toISOString(),
    note: 'Weeks the curriculum overview and the coverage tracker both describe, '
      + 'differently. Nothing was written for any of them and the overview stands, '
      + 'because choosing between two documents is a decision for the head of '
      + 'department. Each entry carries both sets of objectives so they can be read '
      + 'side by side without opening either document.',
    weeks: conflicts.length,
    by_subject: Object.fromEntries([...bySubject].sort()),
    conflicts,
  }, null, 1));

  console.log(`\n  disagreements, by subject - full text in ${REPORT}:`);
  for (const [k, weeks] of [...bySubject].sort().slice(0, 12)) {
    console.log(`    ${k.padEnd(26)} week${weeks.length === 1 ? '' : 's'} ${weeks.join(', ')}`);
  }
  if (bySubject.size > 12) console.log(`    ... and ${bySubject.size - 12} more subjects`);
}

if (!write) {
  console.log('\nnothing loaded into the registry. Pass --write to load these.');
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
    .update({ objectives: f.row.objectives, topic_label: f.row.topic_label,
              ...(hasProvenance ? { ref_source: 'hod' } : {}) })
    .eq('id', f.id);
  if (error) console.error(`  x ${f.row.subject_id} ${f.row.year_group} W${f.row.week_number}: ${error.message}`);
  else filled++;
}

if (queueConflicts && conflicts.length) {
  const { error } = await db.from('registry_gap').insert(conflicts.map(c => ({
    academic_year: YEAR,
    kind: 'conflict',
    year_group: c.year_group,
    subject: c.subject_id,
    semester: c.semester,
    detail: `Week ${c.week}: the curriculum overview holds ${c.overview.objectives.length} `
      + `objective(s) and the coverage tracker holds ${c.tracker.objectives.length}. `
      + 'Neither was written; decide which document is current for this week.',
    files: [c.overview.source, c.tracker.source],
  })));
  // registry_gap arrived in 0006 and migrations here are applied by hand, so a
  // missing table is a missing worklist rather than a failed load.
  if (error) console.error(`  ! conflicts not recorded: ${error.message}`);
}

console.log(`\ninserted ${insert.length}, filled ${filled}, raised ${conflicts.length} conflicts.`);
console.log('None of it is signed off. A head of department signs a subject off in');
console.log('/admin/curriculum, one semester at a time, and until then nothing can be');
console.log('planned or generated from it - which is the point.');
