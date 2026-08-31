/**
 * Re-import curriculum objectives from a corrected parse.
 *
 * scripts/ingest_overviews.py took every line PyMuPDF handed back as its own
 * objective, so a PDF overview's wrapped text imported in pieces: "Research: Gather /
 * information from a range of / reliable sources" became three objectives, and the
 * short pieces were dropped outright by the 12-character floor. LS3 GP's four weeks
 * reached the study pack as 125 fragments and its cover printed them mid-sentence.
 *
 * The ingest now rejoins wrapped lines before that floor applies (unwrap), so the
 * pieces that were dropped exist again only in a fresh parse - not in the stored rows.
 * This replaces the objectives of already-seeded weeks from supabase/seed/curriculum.json
 * rather than trying to stitch the damaged rows back together.
 *
 *   npm run ingest                                                   # re-parse first
 *   node --env-file=.env.local scripts/repair_objectives.mjs         # dry run
 *   node --env-file=.env.local scripts/repair_objectives.mjs --write # apply
 *
 * Only `objectives` is touched. Sign-off, topics and everything else stay as they are.
 * --write saves the previous objectives to supabase/seed/objectives_backup.json first.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';

const write = process.argv.includes('--write');
const YEAR = '2026-27';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: subjects } = await db.from('subject').select('id,name');
const idByName = new Map((subjects ?? []).map(s => [s.name, s.id]));

const parsed = JSON.parse(readFileSync('supabase/seed/curriculum.json', 'utf8'));

// Same shape the seed builds: semester 1, known subjects, weeks 1-15, and the two
// parallel units an overview can run in one week merged into that one week.
const merged = new Map();
for (const r of parsed) {
  const subject_id = idByName.get(r.subject);
  if (r.semester !== 1 || !subject_id || r.week > 15) continue;
  const key = `${r.year_group}|${subject_id}|${r.week}`;
  const seen = merged.get(key);
  if (!seen) { merged.set(key, { subject_id, year_group: r.year_group, week_number: r.week, objectives: [...r.objectives], source_file: r.source_file }); continue; }
  if (seen.source_file !== r.source_file) continue;  // a conflict the seed reports; leave it alone
  for (const o of r.objectives) {
    if (!seen.objectives.some(x => `${x.ref ?? ''}|${x.text}` === `${o.ref ?? ''}|${o.text}`)) seen.objectives.push(o);
  }
}

const { data: rows, error } = await db.from('curriculum_week')
  .select('id,year_group,subject_id,semester,week_number,objectives')
  .eq('academic_year', YEAR);
if (error) throw error;

const changed = [];
let unmatched = 0;
for (const row of rows) {
  const fresh = merged.get(`${row.year_group}|${row.subject_id}|${row.week_number}`);
  if (!fresh) { unmatched++; continue; }
  const before = row.objectives ?? [];
  const same = before.length === fresh.objectives.length
    && before.every((o, i) => o.text === fresh.objectives[i].text && (o.ref ?? null) === (fresh.objectives[i].ref ?? null));
  if (!same) changed.push({ row, before, after: fresh.objectives });
}

console.log(`${rows.length} seeded weeks; ${changed.length} differ from the corrected parse; ${unmatched} have no parsed week to compare`);
const objBefore = changed.reduce((n, c) => n + c.before.length, 0);
const objAfter = changed.reduce((n, c) => n + c.after.length, 0);
console.log(`objectives on those weeks: ${objBefore} -> ${objAfter}`);
for (const c of changed.slice(0, 3)) {
  console.log(`\n  ${c.row.subject_id} ${c.row.year_group} W${c.row.week_number}: ${c.before.length} -> ${c.after.length}`);
  console.log(`    was: ${c.before.slice(0, 3).map(o => o.text.slice(0, 44)).join(' / ')}`);
  console.log(`    now: ${c.after.slice(0, 2).map(o => o.text.slice(0, 88)).join(' / ')}`);
}

if (!write) { console.log('\ndry run - nothing written. Pass --write to apply.'); process.exit(0); }

writeFileSync('supabase/seed/objectives_backup.json',
  JSON.stringify(changed.map(c => ({ id: c.row.id, objectives: c.before })), null, 1));
console.log('\nprevious objectives saved to supabase/seed/objectives_backup.json');

let done = 0;
for (const c of changed) {
  const { error: e } = await db.from('curriculum_week').update({ objectives: c.after }).eq('id', c.row.id);
  if (e) console.error(`  x ${c.row.subject_id} ${c.row.year_group} W${c.row.week_number}: ${e.message}`);
  else done++;
}
console.log(`repaired ${done}/${changed.length} weeks`);
