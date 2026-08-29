import Anthropic from '@anthropic-ai/sdk';
import { admin } from './supabase';
import { mockFor } from './mocks';

/**
 * Every Claude call in LOTS AI goes through this file.
 *
 * Two things are non-negotiable here:
 *   1. Server-side only. The API key never reaches a browser (main spec section 10).
 *   2. Every call is metered. No estimate ever goes to the board (Addendum D section D8).
 */

/**
 * Constructed on first use, not on import: MOCK_CLAUDE=1 has to work on a
 * machine with no ANTHROPIC_API_KEY at all, and the SDK refuses to be built
 * without one.
 */
let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/** Set MOCK_CLAUDE=1 to exercise every path but the network one. */
const MOCK = () => process.env.MOCK_CLAUDE === '1';

/**
 * Model routing, from Addendum D section D8. Change it here and nowhere else.
 *
 * These tiers are a deliberate cost decision recorded in the spec, not a default.
 * Raising a tier is a one-line change: the metering will show what it costs.
 */
export const TIER = {
  small:    'claude-haiku-4-5',   // evaluation formatting, objective tagging, gate tone check
  standard: 'claude-sonnet-5',    // planner generation and adaptation
  large:    'claude-opus-5',      // registry ingestion, exemplar analysis — batch, rare
} as const;

type Tier = keyof typeof TIER;

// USD per million tokens. Cache reads are ~0.1x input; 5-minute writes ~1.25x.
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5':  { in: 2, out: 10 },
  'claude-opus-5':    { in: 5, out: 25 },
};

function costOf(model: string, u: { input: number; cached: number; output: number }) {
  const p = PRICE[model] ?? { in: 2, out: 10 };
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
  system: string;
  maxTokens?: number;
  /** JSON schema. Structured output means no fragile parsing of prose. */
  schema?: Record<string, unknown>;
  /**
   * The Friday planning window is bursty: many teachers hit the same subject
   * prefix over a few hours, so the standard/exemplar prefix earns the 1h TTL.
   */
  longCache?: boolean;
}

export interface CallResult<T = unknown> {
  data: T;
  usage: { input: number; cached: number; output: number; cost: number; model: string; ms: number };
}

export async function call<T = unknown>(o: CallOpts): Promise<CallResult<T>> {
  const model = TIER[o.tier];
  const started = Date.now();

  // The mock still meters. Bypassing ai_usage would mean the one thing the
  // board is promised — a ledger, not an estimate — is the one thing never
  // tested (Addendum D section D8).
  if (MOCK()) {
    const cached = (o.cached ?? []).join("\n");
    const data = mockFor(o.workflow, cached, o.prompt) as T;
    const u = {
      input: Math.round((cached.length + o.prompt.length + o.system.length) / 4),
      cached: 0,
      output: Math.round(JSON.stringify(data).length / 4),
    };
    const usage = { ...u, cost: 0, model: 'mock', ms: Date.now() - started };
    await admin().from('ai_usage').insert({
      workflow: o.workflow, model: 'mock',
      user_id: o.userId ?? null,
      input_tokens: u.input, cached_tokens: u.cached, output_tokens: u.output,
      cost_usd: 0, latency_ms: usage.ms,
    });
    return { data, usage };
  }

  const content: Anthropic.MessageParam['content'] = [];
  for (const [i, block] of (o.cached ?? []).entries()) {
    content.push({
      type: 'text',
      text: block,
      // one breakpoint on the last stable block; everything volatile follows it
      ...(i === (o.cached!.length - 1)
        ? { cache_control: { type: 'ephemeral' as const, ...(o.longCache ? { ttl: '1h' as const } : {}) } }
        : {}),
    });
  }
  content.push({ type: 'text', text: o.prompt });

  const res = await client().messages.create({
    model,
    max_tokens: o.maxTokens ?? 4096,
    system: o.system,
    thinking: { type: 'adaptive' },
    ...(o.schema
      ? { output_config: { format: { type: 'json_schema' as const, schema: o.schema } } }
      : {}),
    messages: [{ role: 'user', content }],
  });

  const u = {
    input: res.usage.input_tokens ?? 0,
    cached: res.usage.cache_read_input_tokens ?? 0,
    output: res.usage.output_tokens ?? 0,
  };
  const usage = { ...u, cost: costOf(model, u), model, ms: Date.now() - started };

  // Metered before the result is returned, so a failure downstream never
  // loses the record of what was already spent.
  await admin().from('ai_usage').insert({
    workflow: o.workflow, model,
    user_id: o.userId ?? null,
    input_tokens: u.input, cached_tokens: u.cached, output_tokens: u.output,
    cost_usd: usage.cost, latency_ms: usage.ms,
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text).join('');

  if (!o.schema) return { data: text as T, usage };

  try {
    return { data: JSON.parse(text) as T, usage };
  } catch {
    throw new Error(`${o.workflow}: model returned unparseable JSON`);
  }
}

/**
 * Cache health. If this is zero across repeated planner generations, something
 * volatile has crept above the breakpoint and the cost model is wrong.
 */
export function cacheHitRate(usage: CallResult['usage']) {
  const total = usage.input + usage.cached;
  return total ? usage.cached / total : 0;
}
