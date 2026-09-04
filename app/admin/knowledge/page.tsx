import Link from 'next/link';
import { admin } from '@/lib/supabase';
import Knowledge from './Knowledge';

export const dynamic = 'force-dynamic';

/**
 * What the school knows, and where each kind of it lives.
 *
 * Most of what LOTS AI answers from has a home already: the calendar, the curriculum
 * registry, the staff list, the class list. Each of those is maintained on the page
 * that owns it, and lib/ask.ts reads them live, so "who heads Science" cannot go stale.
 * `school_fact` is the remainder - the uniform policy, the safeguarding lead, how work
 * is marked, when reports go home - which no table holds and which the model will
 * otherwise answer from what schools usually do.
 *
 * The strip at the top exists because the first question anybody has here is "does this
 * go in the box, or somewhere else". Writing "Mrs Banda heads Science" into the box
 * produces an answer that is right today and authoritative forever; the strip says
 * where it actually belongs, and the extraction prompt refuses to write it anyway.
 */
export default async function KnowledgePage() {
  const db = admin();
  const YEAR = '2026-27';
  const rows = { count: 'exact' as const, head: true };

  const [weeks, signedWeeks, staff, classes, unassigned, calendar, facts] = await Promise.all([
    db.from('curriculum_week').select('*', rows).eq('academic_year', YEAR),
    db.from('curriculum_week').select('*', rows).eq('academic_year', YEAR).not('signed_off_at', 'is', null),
    db.from('app_user').select('*', rows).eq('is_active', true),
    db.from('klass').select('*', rows),
    db.from('klass').select('*', rows).is('teacher_id', null),
    db.from('school_week').select('*', rows).eq('academic_year', YEAR),
    db.from('school_fact').select('*', rows).eq('academic_year', YEAR).is('retired_at', null),
  ]);

  const sources = [
    {
      href: '/admin/curriculum',
      label: 'Curriculum registry',
      count: weeks.count ?? 0,
      unit: 'weeks',
      note: `${signedWeeks.count ?? 0} signed off. Objectives and topics, imported from the school's own overviews.`,
    },
    {
      href: '/admin/people',
      label: 'Staff',
      count: staff.count ?? 0,
      unit: 'people',
      note: 'Names, roles and departments. Who heads what is read from here, live.',
    },
    {
      href: '/admin/classes',
      label: 'Classes',
      count: classes.count ?? 0,
      unit: 'classes',
      note: (unassigned.count ?? 0) > 0
        ? `${unassigned.count} with no teacher against them.`
        : 'Every class has a teacher.',
    },
    {
      href: '/admin/curriculum',
      label: 'Calendar',
      count: calendar.count ?? 0,
      unit: 'weeks',
      note: 'Terms, breaks and teaching weeks for the academic year.',
    },
  ];

  return (
    <>
      <h1>Knowledge</h1>
      <p className="anote awide">
        LOTS AI answers questions about the school from its own records. Most of those records have a
        home of their own and are read from it, live. This page is for the rest - what the school has
        written down about itself that no table holds.
      </p>

      <h2>Where each kind lives</h2>
      <div className="acards">
        {sources.map(s => (
          <Link key={s.label} href={s.href} className="acard asource">
            <span className="alabel">{s.label}</span>
            <b className="num">{s.count}</b>
            <span className="anote">{s.unit} · {s.note}</span>
          </Link>
        ))}
        <div className="acard asource here">
          <span className="alabel">School facts</span>
          <b className="num">{facts.count ?? 0}</b>
          <span className="anote">facts · Policy and practice. Added below.</span>
        </div>
      </div>
      <p className="anote awide">
        <b>A fact with a home is read from its home.</b> Who heads a department, who teaches a class
        and what a week covers are not written down here - they are read from the pages above every
        time somebody asks, so they cannot go stale. Put a policy here only when nothing else owns it.
      </p>

      <Knowledge />
    </>
  );
}
