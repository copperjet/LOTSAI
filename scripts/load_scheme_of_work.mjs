/**
 * Load a parsed scheme of work into `objective_activity`.
 *
 *   python scripts/ingest_scheme_of_work.py "<folder>" --out supabase/seed
 *   node --env-file=.env.local scripts/load_scheme_of_work.mjs                 # dry run
 *   node --env-file=.env.local scripts/load_scheme_of_work.mjs --write
 *
 * Checks two things before it writes, because both would fail silently otherwise:
 *
 *   - Every syllabus code is one `subject_curriculum` knows (migration 0021). A bank of
 *     activities under a code no subject follows is a bank nothing will ever read.
 *   - `key_kind` agrees with that row's `joins_on`. If the parser says a code is keyed
 *     by topic and the routing table says by reference, one of the two is wrong and the
 *     lookup would come back empty for every week - which reads exactly like a scheme of
 *     work that simply has no suggestions.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const write = args.includes('--write');
const file = args.find(a => !a.startsWith('--')) ?? 'supabase/seed/scheme_of_work.json';

const rows = JSON.parse(readFileSync(file, 'utf8'));

const { data: routing, error: routingError } = await db
  .from('subject_curriculum').select('subject_id, syllabus_code, joins_on');
if (routingError) {
  console.error(`cannot read subject_curriculum - apply migration 0021 first (${routingError.message})`);
  process.exit(1);
}
const joinsOn = new Map(routing.map(r => [r.syllabus_code, r.joins_on]));

const problems = [];
const keep = [];
for (const r of rows) {
  const expected = joinsOn.get(r.syllabus_code);
  if (!expected) {
    problems.push(`${r.syllabus_code} is not in subject_curriculum - no subject follows it`);
    continue;
  }
  if (expected !== r.key_kind) {
    problems.push(`${r.syllabus_code} is keyed by ${r.key_kind} here and ${expected} in subject_curriculum`);
    continue;
  }
  keep.push({
    syllabus_code: r.syllabus_code,
    key_kind: r.key_kind,
    key: r.key,
    objective_text: r.objective_text || null,
    activities: r.activities ?? [],
    resources: r.resources ?? [],
    notes: r.notes ?? [],
    source: r.source,
    source_page: r.source_page ?? null,
  });
}

const by = new Map();
for (const r of keep) {
  const at = by.get(r.syllabus_code) ?? { keys: 0, withActivities: 0 };
  at.keys++;
  if (r.activities.length) at.withActivities++;
  by.set(r.syllabus_code, at);
}
for (const [code, at] of [...by].sort()) {
  const subjects = routing.filter(r => r.syllabus_code === code).map(r => r.subject_id).join(', ');
  console.log(`  ${code}  ${String(at.keys).padStart(4)} objectives, ${at.withActivities} with activities  -> ${subjects}`);
}
for (const p of [...new Set(problems)]) console.log(`  ! ${p}`);

if (!write) {
  console.log(`\n${keep.length} rows ready. Nothing written. Pass --write to load them.`);
  process.exit(0);
}

const { error } = await db.from('objective_activity')
  .upsert(keep, { onConflict: 'syllabus_code,key' });

if (error) {
  console.error(`\nnot loaded: ${error.message}`);
  process.exit(1);
}
console.log(`\nloaded ${keep.length} objectives' worth of suggested activities.`);
