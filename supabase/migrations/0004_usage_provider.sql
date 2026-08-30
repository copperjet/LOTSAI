-- Which vendor served each call.
--
-- Without it, comparing what Anthropic and OpenAI actually cost means guessing
-- from model names. With it, that is one group by — and the §D8 cost model gets
-- corrected from measurements instead of estimates.
alter table ai_usage add column if not exists provider text not null default 'anthropic';
create index if not exists ai_usage_provider_created_at_idx on ai_usage (provider, created_at);
