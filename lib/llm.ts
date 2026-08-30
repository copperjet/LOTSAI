import { admin } from './supabase';
import { mockFor } from './mocks';

/**
 * Every model call in LOTS AI goes through this file.
 *
 * Three things are non-negotiable here:
 *   1. Server-side only. The API key never reaches a browser (main spec section 10).
 *   2. Every call is metered, here and nowhere else. No estimate ever goes to the
 *      board (Addendum D section D8) — one insert site is how that stays true.
 *   3. The provider is a detail. lib/providers/* differ; this contract does not.
 */

export type Provider = 'anthropic' | 'openai';

/**
 * Anthropic by default, so a deployment that has not heard of LLM_PROVIDER
 * behaves exactly as it did before.
 */
export function activeProvider(): Provider {
  return process.env.LLM_PROVIDER === 'openai' ? 'openai' : 'anthropic';
}

/**
 * Set MOCK_LLM=1 to exercise every path but the network one.
 *
 * MOCK_CLAUDE is the old name and is still honoured: it is what holds
 * production on fixtures today, and dropping it would take the live site to
 * real API calls mid-deploy.
 */
const MOCK = () => process.env.MOCK_LLM === '1' || process.env.MOCK_CLAUDE === '1';

export type Tier = 'small' | 'standard' | 'large';

/**
 * Model routing, from Addendum D section D8. Change it here and nowhere else.
 *
 * These tiers are a deliberate cost decision recorded in the spec, not a default.
 * Raising a tier is a one-line change: the metering will show what it costs.
 *
 * The OpenAI ids are pinned from what the account can actually reach
 * (`node --env-file=.env.local scripts/models.mjs`), not from memory.
 */
export const TIER: Record<Provider, Record<Tier, string>> = {
  anthropic: {
    small:    'claude-haiku-4-5',   // evaluation formatting, objective tagging, gate tone check
    standard: 'claude-sonnet-5',    // planner generation and adaptation
    large:    'claude-opus-5',      // registry ingestion, exemplar analysis — batch, rare
  },
  openai: {
    small:    process.env.OPENAI_MODEL_SMALL    ?? 'gpt-5.4-nano',
    standard: process.env.OPENAI_MODEL_STANDARD ?? 'gpt-5.4-mini',
    large:    process.env.OPENAI_MODEL_LARGE    ?? 'gpt-5.5',
  },
};

/**
 * USD per million tokens. Cache reads are 0.1x input on both providers.
 *
 * OpenAI prices from developers.openai.com/api/docs/pricing, for exactly these ids.
 */
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5':  { in: 2, out: 10 },
  'claude-opus-5':    { in: 5, out: 25 },
  'gpt-5.4-nano':     { in: 0.2,  out: 1.25 },
  'gpt-5.4-mini':     { in: 0.75, out: 4.5 },
  'gpt-5.4':          { in: 2.5,  out: 15 },
  'gpt-5.5':          { in: 5,    out: 30 },
};

/**
 * A model with no price is loud and costs zero. It used to fall back to
 * {in:2,out:10}, which wrote a plausible but wrong number into ai_usage —
 * precisely the estimate the spec forbids. A gap in the ledger is visible;
 * an invented figure is not.
 */
function costOf(model: string, u: { input: number; cached: number; output: number }) {
  const p = PRICE[model];
  if (!p) {
    console.error(`[llm] no price for model "${model}" — recording cost 0. Add it to PRICE in lib/llm.ts.`);
    return 0;
  }
  return (u.input * p.in + u.cached * p.in * 0.1 + u.output * p.out) / 1e6;
}

export interface CallOpts {
  tier: Tier;
  workflow: string;
  userId?: string | null;
  /**
   * Blocks that are identical for everyone planning this subject and year:
   * the standard, the exemplars, the registry week. Cached, so the second
   * teacher to plan this week pays a tenth of the input price for them.
   */
  cached?: string[];
  /** Volatile, per-request context. Must come after the cache breakpoint. */
  prompt: string;
  /**
   * Pictures the model should read - a photographed worksheet, a textbook page.
   *
   * They go through this contract rather than an SDK call of their own so that
   * OCR is metered like everything else: one ai_usage row per call, no exception
   * for the one workflow that happens to take an image (Addendum D section D8).
   * Always volatile, so they follow the cache breakpoint.
   */
  images?: { mediaType: string; base64: string }[];
  system: string;
  maxTokens?: number;
  /** JSON schema. Structured output means no fragile parsing of prose. */
  schema?: Record<string, unknown>;
  /**
   * The Friday planning window is bursty: many teachers hit the same subject
   * prefix over a few hours, so the standard/exemplar prefix earns the long TTL.
   */
  longCache?: boolean;
}

export interface CallResult<T = unknown> {
  data: T;
  usage: { input: number; cached: number; output: number; cost: number; model: string; ms: number };
}

/**
 * What a provider module must return.
 *
 * `input` is *uncached* input tokens on both providers. Anthropic reports it
 * that way already; OpenAI folds cache reads into its input count, so the
 * OpenAI module subtracts them. Without that, cached tokens would be billed
 * twice and cacheHitRate would read as half what it is.
 */
export interface ProviderResult {
  text: string;
  usage: { input: number; cached: number; output: number };
}

export async function call<T = unknown>(o: CallOpts): Promise<CallResult<T>> {
  const started = Date.now();

  // The mock still meters. Bypassing ai_usage would mean the one thing the
  // board is promised — a ledger, not an estimate — is the one thing never
  // tested (Addendum D section D8).
  if (MOCK()) {
    const cached = (o.cached ?? []).join('\n');
    const data = mockFor(o.workflow, cached, o.prompt) as T;
    const u = {
      input: Math.round((cached.length + o.prompt.length + o.system.length) / 4),
      cached: 0,
      output: Math.round(JSON.stringify(data).length / 4),
    };
    const usage = { ...u, cost: 0, model: 'mock', ms: Date.now() - started };
    await meter(o, 'mock', 'mock', u, 0, usage.ms);
    return { data, usage };
  }

  const p = activeProvider();
  const model = TIER[p][o.tier];

  // Imported lazily so a machine with only one key set never constructs the
  // other SDK — both refuse to be built without their key.
  const { complete } = p === 'openai'
    ? await import('./providers/openai')
    : await import('./providers/anthropic');

  const res = await complete(o, model);
  const cost = costOf(model, res.usage);
  const usage = { ...res.usage, cost, model, ms: Date.now() - started };

  // Metered before the result is returned, so a failure downstream never
  // loses the record of what was already spent.
  await meter(o, p, model, res.usage, cost, usage.ms);

  if (!o.schema) return { data: res.text as T, usage };

  try {
    return { data: JSON.parse(res.text) as T, usage };
  } catch {
    throw new Error(`${o.workflow}: model returned unparseable JSON`);
  }
}

async function meter(
  o: CallOpts, provider: string, model: string,
  u: { input: number; cached: number; output: number },
  cost: number, ms: number,
) {
  const { error } = await admin().from('ai_usage').insert({
    workflow: o.workflow, provider, model,
    user_id: o.userId ?? null,
    input_tokens: u.input, cached_tokens: u.cached, output_tokens: u.output,
    cost_usd: cost, latency_ms: ms,
  });
  // A call that is not in the ledger is money the board cannot see. It must not
  // fail the teacher's request, but it must never fail quietly either — a
  // missing migration would otherwise look exactly like an idle system.
  if (error) console.error(`[llm] ai_usage insert failed for ${o.workflow}/${model}: ${error.message}`);
}

/**
 * Cache health. If this is zero across repeated planner generations, something
 * volatile has crept above the breakpoint and the cost model is wrong.
 */
export function cacheHitRate(usage: CallResult['usage']) {
  const total = usage.input + usage.cached;
  return total ? usage.cached / total : 0;
}
