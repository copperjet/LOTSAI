-- Derived reads. Coverage and landed rates are computed, never typed
-- (main spec section 5, Addendum A section A2 "derive, don't collect").

/**
 * What a class did not land in the last N weeks.
 * This is what turns an approved parallel-class plan into a plan for THIS class.
 */
create or replace function recent_flagged(p_class_id text, p_weeks int default 2)
returns table (ref text, text text, note text)
language sql stable as $$
  select distinct on (f.ref)
         f.ref,
         coalesce(obj->>'text', '') as text,
         e.formatted_comment        as note
  from evaluation e
  join lesson_entry le on le.id = e.lesson_entry_id
  join planner p       on p.id = le.planner_id
  cross join lateral unnest(e.objectives_flagged) as f(ref)
  left join lateral jsonb_array_elements(le.objectives) obj
         on obj->>'ref' = f.ref
  where p.class_id = p_class_id
    and e.captured_at > now() - (p_weeks || ' weeks')::interval
    -- an objective that later landed is no longer flagged
    and not exists (
      select 1 from evaluation e2
      join lesson_entry le2 on le2.id = e2.lesson_entry_id
      join planner p2 on p2.id = le2.planner_id
      where p2.class_id = p_class_id
        and e2.captured_at > e.captured_at
        and f.ref = any(e2.objectives_landed))
  order by f.ref, e.captured_at desc;
$$;

/** Reuse and adapt counters. Demand, recorded as it happens. */
create or replace function bump_artifact(p_id uuid, p_mode text)
returns void language sql as $$
  update shared_artifact
     set reuse_count = reuse_count + (case when p_mode = 'reuse' then 1 else 0 end),
         adapt_count = adapt_count + (case when p_mode = 'adapt' then 1 else 0 end)
   where id = p_id;
$$;

/**
 * Syllabus coverage per class (Teacher KPI 1, Addendum A section A4).
 * Denominators count teaching weeks only — 11 in Semester 1, not 14 or 15
 * (Addendum A section A9). Nobody types any of this.
 */
create or replace function class_coverage(p_class_id text, p_semester int default 1)
returns table (planned int, taught int, landed int, teaching_weeks int)
language sql stable as $$
  with k as (select year_group, subject_id from klass where id = p_class_id),
  reg as (
    select cw.week_number, objective_refs(cw.objectives) as refs
    from curriculum_week cw, k
    where cw.year_group = k.year_group and cw.subject_id = k.subject_id
      and cw.semester = p_semester and cw.academic_year = '2026-27'
      and exists (select 1 from school_week sw
                  where sw.academic_year = '2026-27' and sw.semester = p_semester
                    and sw.week_number = cw.week_number and sw.week_type = 'teaching')
  ),
  planned_refs as (
    select distinct obj->>'ref' as ref
    from planner p
    join lesson_entry le on le.planner_id = p.id
    cross join lateral jsonb_array_elements(le.objectives) obj
    where p.class_id = p_class_id and obj->>'ref' is not null
  ),
  landed_refs as (
    select distinct r as ref
    from evaluation e
    join lesson_entry le on le.id = e.lesson_entry_id
    join planner p on p.id = le.planner_id
    cross join lateral unnest(e.objectives_landed) r
    where p.class_id = p_class_id
  )
  select (select count(distinct r) from reg, unnest(reg.refs) r)::int,
         (select count(*) from planned_refs)::int,
         (select count(*) from landed_refs)::int,
         (select count(*) from reg)::int;
$$;
