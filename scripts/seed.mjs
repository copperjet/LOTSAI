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
    full_name: 'M. Banda', role: 'teacher', department: 'Primary' },
  { email: 'teacher.a@lusakaoaktree.school', full_name: 'T. Phiri', role: 'teacher', department: 'Primary' },
  { email: 'hod.primary@lusakaoaktree.school', full_name: 'J. Zulu', role: 'hod', department: 'Primary' },
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
    { id: 'CP4A-MATH', name: 'CP4A Mathematics', year_group: 'CP4', subject_id: 'MATH', teacher_id: uid('T. Phiri'), periods_per_week: 5 },
    { id: 'CP4B-MATH', name: 'CP4B Mathematics', year_group: 'CP4', subject_id: 'MATH', teacher_id: uid('M. Banda'), periods_per_week: 5 },
    { id: 'CP4A-SCI',  name: 'CP4A Science',     year_group: 'CP4', subject_id: 'SCI',  teacher_id: uid('T. Phiri'), periods_per_week: 3 },
    { id: 'CP4B-SCI',  name: 'CP4B Science',     year_group: 'CP4', subject_id: 'SCI',  teacher_id: uid('M. Banda'), periods_per_week: 3 },
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

  await db.from('curriculum_week')
    .upsert(weeks, { onConflict: 'academic_year,year_group,subject_id,semester,week_number' })
    .then(ok(`curriculum: ${weeks.length} weeks`));

  // Sign off only what a HOD could honestly sign off: the weeks that carry
  // Cambridge references. Everything else stays blocked, visibly, on purpose.
  const signable = weeks.filter(w => w.objectives.some(o => o.ref));
  for (const w of signable) {
    await db.from('curriculum_week').update({
      signed_off_by: uid('J. Zulu'), signed_off_at: new Date().toISOString(),
    }).match({
      academic_year: YEAR, year_group: w.year_group, subject_id: w.subject_id,
      semester: 1, week_number: w.week_number,
    });
  }
  console.log(`  ok signed off ${signable.length} weeks that carry syllabus references`);
  console.log(`     ${weeks.length - signable.length} weeks stay blocked — their overviews have no codes`);

  const coded = new Set(signable.map(w => `${w.year_group} ${w.subject_id}`));
  console.log(`\nplannable now: ${[...coded].join(', ') || 'nothing'}`);
  console.log('done.');
}

main().catch(e => { console.error(e); process.exit(1); });
