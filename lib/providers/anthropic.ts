import Anthropic from '@anthropic-ai/sdk';
import type { CallOpts, ProviderResult } from '../llm';

/**
 * The Anthropic provider. Metering lives in lib/llm.ts, not here.
 *
 * Constructed on first use, not on import: the mock has to work on a machine
 * with no ANTHROPIC_API_KEY at all, and the SDK refuses to be built without one.
 */
let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export async function complete(o: CallOpts, model: string): Promise<ProviderResult> {
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

  return {
    text: res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join(''),
    usage: {
      // input_tokens already excludes cache reads on this provider
      input: res.usage.input_tokens ?? 0,
      cached: res.usage.cache_read_input_tokens ?? 0,
      output: res.usage.output_tokens ?? 0,
    },
  };
}
