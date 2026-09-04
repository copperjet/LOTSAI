import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import type { CallOpts, ImageOpts, ProviderResult } from '../llm';

/**
 * The OpenAI provider, on the Responses API. Metering lives in lib/llm.ts.
 *
 * Constructed on first use for the same reason as the Anthropic one: the mock
 * must run on a machine with no key.
 */
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/** The gpt-5 family reasons; the older chat models do not take a reasoning param. */
const REASONS = /^(gpt-5|o[1-9])/;

export async function complete(o: CallOpts, model: string): Promise<ProviderResult> {
  const cached = o.cached ?? [];

  // OpenAI matches cached prefixes itself rather than taking an explicit
  // breakpoint, so the cached blocks simply come first and the volatile prompt
  // last — the same ordering the Anthropic breakpoint depends on.
  const content: OpenAI.Responses.ResponseInputContent[] =
    [...cached, o.prompt].map(text => ({ type: 'input_text' as const, text }));

  // After the text, so the cached prefix stays a prefix.
  for (const img of o.images ?? []) {
    content.push({
      type: 'input_image' as const,
      image_url: `data:${img.mediaType};base64,${img.base64}`,
      detail: 'auto' as const,
    });
  }

  // A stable key routes repeat requests to the same cache. Derived from the
  // prefix itself, so it changes exactly when the prefix does.
  const cacheKey = cached.length
    ? `${o.workflow}-${createHash('sha256').update(cached.join('\n')).digest('hex').slice(0, 16)}`
    : undefined;

  const res = await client().responses.create({
    model,
    instructions: o.system,
    input: [{ role: 'user', content }],
    max_output_tokens: o.maxTokens ?? 4096,
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    // The Friday burst spans hours, well past the in-memory default.
    ...(o.longCache ? { prompt_cache_retention: '24h' as const } : {}),
    ...(REASONS.test(model) ? { reasoning: { effort: 'low' as const } } : {}),
    ...(o.schema
      ? { text: { format: {
          type: 'json_schema' as const,
          // a-z, A-Z, 0-9, underscores and dashes only
          name: o.workflow.replace(/[^A-Za-z0-9_-]/g, '_'),
          schema: o.schema,
          strict: true,
        } } }
      : {}),
  });

  const u = res.usage;
  const cachedTokens = u?.input_tokens_details?.cached_tokens ?? 0;

  return {
    text: res.output_text,
    usage: {
      // OpenAI's input_tokens INCLUDES cache reads; Anthropic's does not.
      // Subtract, or the cached tokens get billed twice in lib/llm.ts.
      input: Math.max(0, (u?.input_tokens ?? 0) - cachedTokens),
      cached: cachedTokens,
      output: u?.output_tokens ?? 0,
    },
  };
}

/**
 * Draw one picture. Metering, pricing and the mock all live in lib/llm.ts.
 *
 * The Images API answers with base64 rather than a URL for these models, which is
 * what we want: the bytes go straight into the artefacts bucket, and there is no
 * expiring link for a pack to be pointed at.
 */
export async function image(o: ImageOpts, model: string): Promise<Uint8Array> {
  const res = await client().images.generate({
    model,
    prompt: o.prompt,
    size: o.size ?? '1024x1024',
    n: 1,
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${o.workflow}: the image model returned no image`);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
