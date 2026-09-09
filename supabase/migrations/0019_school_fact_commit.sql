-- Saving school facts in one transaction, and keeping the replacement chain in the
-- table rather than only in the audit log.
--
-- Two problems this fixes, both in /api/school-fact action=commit.
--
-- 1. The route inserted the new facts, then looped retiring the rows each one
--    replaced. The order was deliberate - a failed insert must never leave the school
--    with the old policy withdrawn and nothing in its place - but it has the opposite
--    failure on the other side: the insert lands, the retire fails, and now both the
--    old wording and the new one are live. Both then reach the cached grounding block
--    in lib/ask.ts, where two copies of the marking policy is the exact outcome
--    lib/knowledge.ts exists to prevent, and nobody sees it happen. One function, one
--    transaction: either the fact is saved and what it replaced is withdrawn, or
--    neither is.
--
-- 2. The route paired the inserted rows with the retired ones by array position -
--    `written[i]` against `kept[i]` - and PostgREST does not promise that an insert
--    returns rows in the order they were sent. The audit's `replacedBy` could
--    therefore name the wrong fact, which is worse than naming none, because the
--    audit log is what a school reads when it wants to know what it was saying and
--    when. Here the pairing is a variable inside the loop and cannot drift.
--
-- `supersedes` is the same fact stated in the table. Until now the only record that
-- this fact replaced that one lived in audit_log, so the page could show a withdrawn
-- policy but not what took its place - which is the first thing an administrator
-- looking at the withdrawn list wants to know.
--
-- Safe to re-run.

alter table school_fact add column if not exists supersedes uuid[];

comment on column school_fact.supersedes is
  'The rows this fact replaced, retired in the same transaction that inserted it.';

-- Small table, but the withdrawn list resolves "what replaced this" through it on
-- every page load, and a containment index is the one that answers that.
create index if not exists school_fact_supersedes
  on school_fact using gin (supersedes);

/**
 * Save a reviewed batch of school facts.
 *
 * p_facts is [{topic, body, source_note, replaces: [uuid, ...]}] - the shape
 * /api/school-fact builds after it has dropped anything already saved word for word.
 * Duplicate detection stays in the route: it is a judgement with thresholds and a
 * person's decision attached, and it does not belong in SQL.
 *
 * Returns {saved: [{id, topic}], replaced: n}.
 */
create or replace function school_fact_commit(p_year text, p_actor uuid, p_facts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  f        jsonb;
  ids      uuid[];
  new_id   uuid;
  gone     record;
  saved    jsonb := '[]'::jsonb;
  replaced int := 0;
begin
  if jsonb_typeof(p_facts) <> 'array' then
    raise exception 'school_fact_commit: p_facts must be a JSON array';
  end if;

  for f in select value from jsonb_array_elements(p_facts) loop
    if coalesce(btrim(f->>'topic'), '') = '' or coalesce(btrim(f->>'body'), '') = '' then
      raise exception 'school_fact_commit: every fact needs a topic and a body';
    end if;

    select coalesce(array_agg(v::uuid), '{}'::uuid[])
      into ids
      from jsonb_array_elements_text(coalesce(f->'replaces', '[]'::jsonb)) as t(v);

    insert into school_fact (academic_year, topic, body, source_note, added_by, supersedes)
    values (p_year, f->>'topic', f->>'body', nullif(btrim(coalesce(f->>'source_note', '')), ''),
            p_actor, nullif(ids, '{}'::uuid[]))
    returning id into new_id;

    saved := saved || jsonb_build_array(jsonb_build_object('id', new_id, 'topic', f->>'topic'));

    insert into audit_log (actor_id, action, entity_type, entity_id, detail)
    values (p_actor, 'school_fact.add', 'school_fact', new_id::text,
            jsonb_build_object('topic', f->>'topic'));

    -- Withdrawn inside the same transaction as the insert that supersedes it. A row
    -- already retired is left alone, so re-sending a commit cannot double-count.
    for gone in
      update school_fact set retired_at = now()
       where id = any (ids) and retired_at is null
      returning id, topic
    loop
      replaced := replaced + 1;
      insert into audit_log (actor_id, action, entity_type, entity_id, detail)
      values (p_actor, 'school_fact.supersede', 'school_fact', gone.id::text,
              jsonb_build_object('topic', gone.topic, 'replacedBy', new_id));
    end loop;
  end loop;

  return jsonb_build_object('saved', saved, 'replaced', replaced);
end;
$$;

-- SECURITY DEFINER, so it must not be reachable with the key that ships in the
-- browser bundle. PostgreSQL grants EXECUTE to PUBLIC on a new function, and
-- revoking from anon and authenticated alone does not take that away (0013).
revoke all on function school_fact_commit(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function school_fact_commit(text, uuid, jsonb) to service_role;
