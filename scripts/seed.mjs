/**
 * Seeds a Supabase project from the school's own ingested overviews.
 *
 *   npm run ingest     # reads ../CURRICULUM OVERVIEWS -> supabase/seed/curriculum.json
 *   npm run seed       # loads calendar, people, classes and that curriculum
 *
 * Only subjects whose registry a HOD has signed off can be planned. This script
 * signs off exactly one — CP4 Mathematics, the one overview that actually carries
 * Cambridge references — so the sign-off gate is real from the first run rather
 * than something switched on later.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const YEAR = '2026-27';

// Semester 1 2026/27. Mondays, from the school calendar (Addendum A section A9):
// 11 teaching weeks, then revision, then two examination weeks.
const WEEKS = [
  [1, '2026-08-24', 'teaching'], [2, '2026-08-31', 'teaching'], [3, '2026-09-07', 'teaching'],
  [4, '2026-09-14', 'teaching'], [5, '2026-09-21', 'teaching'], [6, '2026-09-28', 'teaching'],
  [7, '2026-10-05', 'teaching'], [8, '2026-10-12', 'teaching'], [9, '2026-10-19', 'break'],
  [10, '2026-10-26', 'teaching'], [11, '2026-11-02', 'teaching'], [12, '2026-11-09', 'teaching'],
  [13, '2026-11-16', 'revision'], [14, '2026-11-23', 'exam'], [15, '2026-11-30', 'exam'],
];

const SUBJECTS = [
  ['MATH', 'Mathematics', 'Mathematics'],
  ['SCI', 'Science', 'Science'],
  ['ENG', 'English', 'English'],
  ['GP', 'Global Perspectives', 'Humanities'],
];

const SUBJECT_BY_NAME = {
  'Mathematics': 'MATH', 'Science': 'SCI', 'English': 'ENG', 'Global Perspectives': 'GP',
};

const PEOPLE = [
  { email: process.env.DEMO_USER_EMAIL ?? 'teacher.b@lusakaoaktree.school',
    full_name: 'Victor Mwaekwa', role: 'teacher', department: 'Primary' },
  { email: 'teacher.a@lusakaoaktree.school', full_name: 'Richard Mwanza', role: 'teacher', department: 'Primary' },
  { email: 'hod.primary@lusakaoaktree.school', full_name: 'Denny Sepiso', role: 'hod', department: 'Primary' },
  // The admin role passes every reviewer check and, since /admin, opens the
  // dashboard as well. Nobody held it before, so nobody could reach it.
  // No PIN is seeded: the first sign-in chooses one.
  { email: 'admin@lusakaoaktree.school', full_name: 'School Office', role: 'admin', department: null },
];

// From the Resources column the overviews already carry. Confirm with the HOD
// before the pilot — this is open item 2 in the main spec.
const INVENTORY = [
  ['MATH', 'CP4', "Cambridge primary learners' book pg 22-25"],
  ['MATH', 'CP4', 'Place value blocks'],
  ['MATH', 'CP4', 'Place value cards'],
  ['MATH', 'CP4', 'Hundred chart'],
  ['MATH', 'CP4', 'Number cards'],
  ['MATH', 'CP4', 'Papers, pencils and rulers'],
  ['MATH', 'CP4', 'Flash cards'],
  ['MATH', 'CP4', 'Rounding rules poster'],
  ['SCI', 'CP4', "Cambridge Primary Science Learner's Book 4"],
];

const ok = (label) => ({ error }) => {
  if (error) { console.error(`  x ${label}: ${error.message}`); process.exitCode = 1; }
  else console.log(`  ok ${label}`);
};

async function main() {
  console.log('seeding', process.env.NEXT_PUBLIC_SUPABASE_URL);

  await db.from('academic_year')
    .upsert({ id: YEAR, starts_on: '2026-08-24', ends_on: '2027-07-02' }).then(ok('academic year'));

  await db.from('school_week').upsert(
    WEEKS.map(([n, mon, type]) => ({
      academic_year: YEAR, semester: 1, week_number: n, week_commencing: mon, week_type: type,
    })), { onConflict: 'academic_year,semester,week_number' }).then(ok('school weeks'));

  await db.from('subject')
    .upsert(SUBJECTS.map(([id, name, dept]) => ({ id, name, department: dept }))).then(ok('subjects'));

  await db.from('app_user').upsert(PEOPLE, { onConflict: 'email' }).then(ok('people'));
  const { data: users } = await db.from('app_user').select('id, full_name');
  const uid = (n) => users.find(u => u.full_name === n)?.id;

  await db.from('klass').upsert([
    { id: 'CP4A-MATH', name: 'CP4A Mathematics', year_group: 'CP4', subject_id: 'MATH', teacher_id: uid('Richard Mwanza'), periods_per_week: 5 },
    { id: 'CP4B-MATH', name: 'CP4B Mathematics', year_group: 'CP4', subject_id: 'MATH', teacher_id: uid('Victor Mwaekwa'), periods_per_week: 5 },
    { id: 'CP4A-SCI',  name: 'CP4A Science',     year_group: 'CP4', subject_id: 'SCI',  teacher_id: uid('Richard Mwanza'), periods_per_week: 3 },
    { id: 'CP4B-SCI',  name: 'CP4B Science',     year_group: 'CP4', subject_id: 'SCI',  teacher_id: uid('Victor Mwaekwa'), periods_per_week: 3 },
    // 27 of the 30 ingested CP4 English weeks carry Cambridge references and sign
    // off same as Math — but no class row taught it, so the registry coverage was
    // unreachable from the app. Periods/week not stated in the overview; matched
    // to CP4A Mathematics pending HOD confirmation.
    { id: 'CP4A-ENG',  name: 'CP4A English',     year_group: 'CP4', subject_id: 'ENG',  teacher_id: uid('Richard Mwanza'), periods_per_week: 5 },
    { id: 'CP4B-ENG',  name: 'CP4B English',     year_group: 'CP4', subject_id: 'ENG',  teacher_id: uid('Victor Mwaekwa'), periods_per_week: 5 },
  ]).then(ok('classes'));

  await db.from('resource_inventory')
    .upsert(INVENTORY.map(([subject_id, year_group, label]) => ({ subject_id, year_group, label })))
    .then(ok('resource inventory'));

  // The registry, straight from the school's own documents.
  let rows;
  try {
    rows = JSON.parse(readFileSync('supabase/seed/curriculum.json', 'utf8'));
  } catch {
    console.error('  x no supabase/seed/curriculum.json — run: npm run ingest');
    process.exit(1);
  }

  const known = new Set(SUBJECTS.map(s => s[0]));
  const weeks = rows
    .filter(r => r.semester === 1 && SUBJECT_BY_NAME[r.subject] && known.has(SUBJECT_BY_NAME[r.subject]))
    .filter(r => r.week <= 15)
    .map(r => ({
      academic_year: YEAR,
      year_group: r.year_group,
      subject_id: SUBJECT_BY_NAME[r.subject],
      semester: 1,
      week_number: r.week,
      topic_label: r.topic_label,
      objectives: r.objectives,
      activities: r.activities,
      resources: r.resources,
      source_file: r.source_file,
    }));

  // One row per week is what the table allows, but an overview may legitimately
  // carry two units in the same week — CP4 English runs Historical stories and
  // Poems side by side. Those arrive as separate rows out of the ingest and
  // collide on the key, so they are merged into the one week they describe.
  //
  // Two *different files* claiming the same week is a different thing entirely:
  // that is the conflict the sign-off gate exists for, and guessing a winner
  // there would be exactly the confident wrongness this system is meant to
  // avoid. So it keeps the fuller row and says out loud that it did.
  const merged = new Map();
  const conflicts = [];

  for (const w of weeks) {
    const key = `${w.year_group}|${w.subject_id}|${w.week_number}`;
    const seen = merged.get(key);
    if (!seen) { merged.set(key, w); continue; }

    if (seen.source_file === w.source_file) {
      const dedupe = (a, b, of) => {
        const out = [...a];
        for (const item of b) if (!out.some(x => of(x) === of(item))) out.push(item);
        return out;
      };
      seen.topic_label = seen.topic_label === w.topic_label
        ? seen.topic_label
        : `${seen.topic_label} · ${w.topic_label}`;
      seen.objectives = dedupe(seen.objectives, w.objectives, o => `${o.ref ?? ''}|${o.text}`);
      seen.activities = dedupe(seen.activities, w.activities, x => String(x));
      seen.resources  = dedupe(seen.resources,  w.resources,  x => String(x));
    } else {
      const richer = w.objectives.filter(o => o.ref).length > seen.objectives.filter(o => o.ref).length
        || (w.objectives.length > seen.objectives.length
            && w.objectives.filter(o => o.ref).length === seen.objectives.filter(o => o.ref).length);
      conflicts.push(`${key}: kept ${(richer ? w : seen).source_file}, ignored ${(richer ? seen : w).source_file}`);
      if (richer) merged.set(key, w);
    }
  }

  const registry = [...merged.values()];
  if (weeks.length !== registry.length) {
    console.log(`  .. ${weeks.length - registry.length} same-week rows merged (parallel units in one overview)`);
  }
  for (const c of conflicts) console.log(`  ! two files claim ${c}`);

  await db.from('curriculum_week')
    .upsert(registry, { onConflict: 'academic_year,year_group,subject_id,semester,week_number' })
    .then(ok(`curriculum: ${registry.length} weeks`));

  // Sign off only what a HOD could honestly sign off: the weeks that carry
  // Cambridge references. Everything else stays blocked, visibly, on purpose.
  const signable = registry.filter(w => w.objectives.some(o => o.ref));
  for (const w of signable) {
    await db.from('curriculum_week').update({
      signed_off_by: uid('Denny Sepiso'), signed_off_at: new Date().toISOString(),
    }).match({
      academic_year: YEAR, year_group: w.year_group, subject_id: w.subject_id,
      semester: 1, week_number: w.week_number,
    });
  }
  console.log(`  ok signed off ${signable.length} weeks that carry syllabus references`);
  console.log(`     ${registry.length - signable.length} weeks stay blocked — their overviews have no codes`);

  const coded = new Set(signable.map(w => `${w.year_group} ${w.subject_id}`));
  console.log(`\nplannable now: ${[...coded].join(', ') || 'nothing'}`);

  await loadRegistryGaps();
  await loadArtefactEngine();

  console.log('done.');
}

// The weekly planner, expressed as a Standard + workflow — Addendum C §C2/§C6.
// This mirrors exactly what the planner does today: the schema is the PLAN_SCHEMA
// from lib/planner.ts, the non-negotiables are the seven from §C4, and the three
// *_id fields name the implementations already registered in lib/workflows/registry.ts.
// Loading this changes no behaviour; it is what lets the next artefact type be a
// record instead of a route.
const PLANNER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lessons'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['day_of_week', 'objective_indexes', 'methodology', 'resources', 'differentiation', 'is_recap'],
        properties: {
          day_of_week: { type: 'integer' },
          objective_indexes: { type: 'array', items: { type: 'integer' } },
          methodology: { type: 'string' },
          resources: { type: 'string' },
          differentiation: { type: 'string' },
          is_recap: { type: 'boolean' },
        },
      },
    },
  },
};

const PLANNER_NON_NEGOTIABLES = [
  'Every objective carries its syllabus reference from the registry, verbatim. Never paraphrased, never invented.',
  'Week number and dates match the school calendar, normalised to Monday.',
  'Methodology names a learner action, not a category.',
  'Resources come only from the inventory; anything outside it is flagged, never invented.',
  'Differentiation is present for every lesson, in three named tiers: support, core, extension.',
  'Any objective flagged as not landed in the previous two weeks appears as explicit recap time.',
  "Teacher's and HOD's comments are never AI-written.",
];

async function loadArtefactEngine() {
  // The private bucket rendered PDFs are written to. Idempotent — a bucket that
  // already exists is left as it is.
  const { data: bucket } = await db.storage.getBucket('artefacts');
  if (!bucket) {
    const { error } = await db.storage.createBucket('artefacts', { public: false });
    if (error) console.log(`  .. could not create 'artefacts' bucket (${error.message}) — create it by hand`);
    else console.log("  ok created private storage bucket 'artefacts'");
  }

  const std = await db.from('standard').upsert({
    key: 'weekly_planner', version: 'v1', name: 'Weekly Planner',
    schema: PLANNER_SCHEMA, non_negotiables: PLANNER_NON_NEGOTIABLES,
    generator_id: 'planner', gate_id: 'planner', renderer_id: 'planner',
    tier: 'standard',
    render: { page: 'A4', template: 'LOTS_Weekly_Planner' },
  }, { onConflict: 'key,version' });
  if (std.error) {
    console.log(`  .. artefact engine not loaded (${std.error.message}) — run migration 0007`);
    return;
  }

  const wf = await db.from('workflow').upsert({
    key: 'weekly_planner', name: 'Weekly Planner', roles: ['teacher'],
    inputs: { class: 'class_ref', school_week: 'week_ref' },
    grounding: [
      'curriculum_week(subject, year_group, school_week)',
      'evaluations(class, last_n_weeks: 2)',
      'resource_inventory(subject, year_group)',
      'standard: weekly_planner@v1',
      'exemplars(subject, phase, limit: 2)',
    ],
    collaborative: {
      work_key: ['artefact_type', 'subject', 'year_group', 'academic_year', 'school_week', 'objective_set'],
      on_match: ['reuse', 'adapt'],
    },
    generation: { cache_prefix: ['standard', 'exemplars', 'curriculum_week'], max_clarifying_questions: 1 },
    standard_key: 'weekly_planner', standard_version: 'v1',
    approval: { submit_to: 'hod', states: ['draft', 'submitted', 'reviewed', 'approved', 'returned'] },
    render: { on: 'approved', to: 'storage' },
  }, { onConflict: 'key' });
  if (wf.error) { console.log(`  .. workflow not loaded: ${wf.error.message}`); return; }

  // Study pack (Addendum C §C3) — the second artefact, a record not a route. Its
  // Standard is the Study Pack Build Kit: schema (units → topics → objectives, key
  // ideas, quiz), the six non-negotiables, and the ids of its generator, gate and
  // renderer. Objectives retrieved from the registry; the pedagogy generated.
  await db.from('standard').upsert({
    key: 'study_pack', version: 'v1', name: 'Study Pack',
    schema: { units: 'Unit[] -> Topic[] { objective_indexes, key_ideas[3-6], quiz[2-4], think_question }', glossary: '{term, definition}[]' },
    non_negotiables: [
      'Unit and Topic named on every screen.',
      'Objectives stated in full, retrieved from the registry, never invented.',
      'Short key ideas — 3 to 6 bullets per topic, not notes.',
      'At least one interactive activity per topic (a quiz with feedback).',
      'A thinking prompt per topic; a glossary for the pack.',
      'LOTS branding intact — crest, name, footer credit.',
    ],
    generator_id: 'studypack', gate_id: 'studypack', renderer_id: 'studypack',
    tier: 'standard', render: { format: 'html', template: 'LOTS_Study_Pack' },
  }, { onConflict: 'key,version' });

  await db.from('workflow').upsert({
    key: 'study_pack', name: 'Study Pack', roles: ['teacher'],
    inputs: { class: 'class_ref', week_from: 'week', week_to: 'week' },
    grounding: ['curriculum_week(subject, year_group, week_from..week_to)', 'standard: study_pack@v1'],
    collaborative: { work_key: ['artefact_type', 'subject', 'year_group', 'academic_year', 'week_from', 'objective_set'], on_match: ['reuse'] },
    generation: { cache_prefix: ['standard', 'curriculum_week'], max_clarifying_questions: 0 },
    standard_key: 'study_pack', standard_version: 'v1',
    approval: { submit_to: 'hod', states: ['draft', 'submitted', 'approved', 'returned'] },
    render: { on: 'create', to: 'storage', format: 'html' },
  }, { onConflict: 'key' });

  console.log('  ok artefact engine: weekly_planner@v1, study_pack@v1 (standards + workflows)');
}

/**
 * Carry the ingest's readiness report into the app, so an HOD can see what stands
 * between the school's documents and a complete registry — the conflicts a human
 * must decide, the files that could not be read, the filenames that could not be
 * placed. This is the standalone deliverable to the Academic Coordinator the spec
 * names (main spec §9 step 0); until now it lived only as a JSON file on disk.
 *
 * Tolerant of the registry_gap table not existing yet: migration 0006 is run the
 * same way 0001–0005 are (the SQL editor), and a seed run before that should still
 * complete the curriculum load rather than failing on a missing table.
 */
async function loadRegistryGaps() {
  let report;
  try {
    report = JSON.parse(readFileSync('supabase/seed/readiness_report.json', 'utf8'));
  } catch {
    console.log('  .. no readiness_report.json — skipping registry gaps');
    return;
  }

  const rows = [];
  for (const c of report.blocking_hod_decision ?? [])
    rows.push({ academic_year: YEAR, kind: 'conflict', year_group: c.year_group,
                subject: c.subject, semester: c.semester, detail: c.needs, files: c.files ?? [] });
  for (const f of report.could_not_import ?? [])
    rows.push({ academic_year: YEAR, kind: 'unreadable', year_group: f.year_group ?? null,
                subject: f.subject ?? null, semester: f.semester ?? null,
                detail: f.why, files: f.file ? [f.file] : [] });
  for (const u of report.unclassified ?? [])
    rows.push({ academic_year: YEAR, kind: 'unclassified', detail: u.why, files: u.file ? [u.file] : [] });
  for (const e of report.excluded ?? [])
    rows.push({ academic_year: YEAR, kind: 'excluded', detail: e.why, files: e.file ? [e.file] : [] });

  // Rewrite the year's gaps from scratch: a gap fixed since the last ingest should
  // disappear, not linger. Any HOD decision already recorded is preserved by the
  // ingest instead (conflict_resolutions.json), not by this row surviving.
  const del = await db.from('registry_gap').delete().eq('academic_year', YEAR);
  if (del.error) {
    console.log(`  .. registry_gap not loaded (${del.error.message}) — run migration 0006`);
    return;
  }
  const ins = await db.from('registry_gap').insert(rows);
  if (ins.error) console.log(`  .. registry_gap insert failed: ${ins.error.message}`);
  else console.log(`  ok registry gaps: ${rows.length} (${report.summary.duplicate_conflicts} conflicts, ${report.summary.unreadable} unreadable)`);
}

main().catch(e => { console.error(e); process.exit(1); });
