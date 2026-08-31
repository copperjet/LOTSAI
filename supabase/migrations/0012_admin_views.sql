-- The admin dashboard's data.
--
-- ai_usage has been written on every model call since migration 0001 and read
-- by nothing at all. These views are what finally read it, and they aggregate
-- in SQL rather than in the page because the table only grows: at sixteen staff
-- and roughly 350 calls a week it passes ten thousand rows inside a year, and
-- "fetch it all and sum it in JavaScript" would stop working quietly.

-- ---------------------------------------------------------------- daily spend
create or replace view ai_usage_daily as
select date_trunc('day', created_at)::date as day,
       provider,
       count(*)                as calls,
       sum(input_tokens)       as input_tokens,
       sum(cached_tokens)      as cached_tokens,
       sum(output_tokens)      as output_tokens,
       sum(cost_usd)           as cost_usd
from ai_usage
group by 1, 2;

-- ------------------------------------------------------------- by workflow
-- cache_ratio is the one number Addendum D8 asks to be watched: the standard
-- and exemplar prefix is meant to be cached, and a workflow sitting at zero
-- across repeated calls is one whose prefix something is quietly invalidating.
-- p90 is here because the D2 time budgets are stated at p50 and p90, not mean.
create or replace view ai_usage_by_workflow as
select workflow,
       count(*)                                        as calls,
       sum(cost_usd)                                   as cost_usd,
       sum(input_tokens)                               as input_tokens,
       sum(cached_tokens)                              as cached_tokens,
       sum(output_tokens)                              as output_tokens,
       case when sum(input_tokens) = 0 then null
            else sum(cached_tokens)::numeric / sum(input_tokens) end as cache_ratio,
       percentile_cont(0.5) within group (order by latency_ms) as p50_ms,
       percentile_cont(0.9) within group (order by latency_ms) as p90_ms,
       max(created_at)                                 as last_call
from ai_usage
group by workflow;

-- ------------------------------------------------------------------ by model
create or replace view ai_usage_by_model as
select provider, model,
       count(*)          as calls,
       sum(cost_usd)     as cost_usd,
       sum(input_tokens) as input_tokens,
       sum(cached_tokens) as cached_tokens,
       sum(output_tokens) as output_tokens
from ai_usage
group by provider, model;

-- ------------------------------------------------------------------- by person
-- A left join, so somebody who has signed in and done nothing still appears.
-- Being able to see who is *not* using it is half the point of the roll.
create or replace view ai_usage_by_user as
select u.id              as user_id,
       u.full_name, u.email, u.role, u.department,
       u.is_active, u.last_seen_at, u.pin_set_at,
       count(a.id)                    as calls,
       coalesce(sum(a.cost_usd), 0)   as cost_usd,
       coalesce(sum(a.input_tokens), 0)  as input_tokens,
       coalesce(sum(a.cached_tokens), 0) as cached_tokens,
       coalesce(sum(a.output_tokens), 0) as output_tokens,
       min(a.created_at)              as first_call,
       max(a.created_at)              as last_call
from app_user u
left join ai_usage a on a.user_id = u.id
group by u.id, u.full_name, u.email, u.role, u.department,
         u.is_active, u.last_seen_at, u.pin_set_at;

-- --------------------------------------------------------------- what they did
-- Spend alone would rank a teacher who generates freely above one who reuses,
-- which is exactly backwards under Addendum B. These are the counts that say
-- whether the thing is being used.
create or replace view user_activity as
select u.id as user_id,
       (select count(*) from planner    p where p.teacher_id     = u.id) as planners,
       (select count(*) from evaluation e where e.teacher_id     = u.id) as evaluations,
       (select count(*) from reuse_event r where r.reusing_user_id = u.id) as reuses,
       (select count(*) from shared_artifact s where s.author_id  = u.id) as shared,
       (select count(*) from user_session s
         where s.user_id = u.id and s.expires_at > now())                as live_sessions
from app_user u;

-- ------------------------------------------------------------------- headline
-- Four windows in one round trip. 'today' is the calendar day rather than the
-- last 24 hours, because that is what somebody looking at it means by today.
create or replace function admin_overview()
returns table (span text, calls bigint, cost_usd numeric,
               input_tokens bigint, cached_tokens bigint)
language sql stable as $$
  select w.span,
         count(a.id),
         coalesce(sum(a.cost_usd), 0),
         coalesce(sum(a.input_tokens), 0)::bigint,
         coalesce(sum(a.cached_tokens), 0)::bigint
  from (values ('today', date_trunc('day', now())),
               ('week',  now() - interval '7 days'),
               ('month', now() - interval '30 days'),
               ('all',   '-infinity'::timestamptz)) as w(span, since)
  left join ai_usage a on a.created_at >= w.since
  group by w.span;
$$;

-- A view is not subject to the row level security of the tables beneath it —
-- it runs with its owner's rights unless declared security_invoker. Every one
-- of these would therefore hand cost, staff names and email addresses to
-- anybody holding the anon key, which is published in the browser bundle.
-- The pages read them through the service-role client, so nothing else needs
-- to reach them.
revoke all on ai_usage_daily, ai_usage_by_workflow, ai_usage_by_model,
              ai_usage_by_user, user_activity from anon, authenticated;
revoke all on function admin_overview() from anon, authenticated;
