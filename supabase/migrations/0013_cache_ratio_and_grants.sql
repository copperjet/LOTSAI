-- Two corrections to 0012, both found by looking at the dashboard against real
-- rows rather than mock ones.

-- 1. The cache ratio was wrong, and wrong in the direction that hides a
--    problem: school_question reported 459%.
--
--    `input_tokens` is *uncached* input on both providers - Anthropic reports
--    cache_read_input_tokens separately, and lib/providers/openai.ts subtracts
--    them so the two agree. The denominator is therefore input + cached, not
--    input. lib/llm.ts already had this right; the view did not.
--
--    A ratio over 100% was obvious. One quietly reading half its true value
--    would not have been, and Addendum D8 asks this number to be watched.
create or replace view ai_usage_by_workflow as
select workflow,
       count(*)                                        as calls,
       sum(cost_usd)                                   as cost_usd,
       sum(input_tokens)                               as input_tokens,
       sum(cached_tokens)                              as cached_tokens,
       sum(output_tokens)                              as output_tokens,
       case when sum(input_tokens) + sum(cached_tokens) = 0 then null
            else sum(cached_tokens)::numeric
                 / (sum(input_tokens) + sum(cached_tokens)) end as cache_ratio,
       percentile_cont(0.5) within group (order by latency_ms) as p50_ms,
       percentile_cont(0.9) within group (order by latency_ms) as p90_ms,
       max(created_at)                                 as last_call
from ai_usage
group by workflow;

-- 2. 0012 revoked the views from anon and authenticated and that worked - all
--    five answer 42501 to the anon key. The function did not, because
--    PostgreSQL grants EXECUTE on a new function to PUBLIC, and revoking from
--    two roles that are members of PUBLIC does not take that away.
--    admin_overview() stayed callable with the key that ships in the browser
--    bundle.
--
--    It returned zeros rather than figures, because it is a plain
--    `language sql` function with no SECURITY DEFINER, so it runs as the caller
--    and row level security on ai_usage empties it. That is the second line of
--    defence doing the first line's job, and it would stop the day anyone added
--    a permissive policy to ai_usage.
revoke all on function admin_overview() from public, anon, authenticated;
grant execute on function admin_overview() to service_role;

revoke all on ai_usage_by_workflow from anon, authenticated;
