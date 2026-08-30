/**
 * Lists the models this OPENAI_API_KEY can actually reach.
 *
 * The three tiers in lib/llm.ts are a cost decision recorded in the spec
 * (Addendum D section D8). They get pinned from this list, never from memory:
 * a guessed model id fails at request time, and a guessed price writes a
 * plausible but wrong number into ai_usage.
 *
 *   node --env-file=.env.local scripts/models.mjs
 */
import OpenAI from 'openai';

const key = process.env.OPENAI_API_KEY;
if (!key) { console.error('OPENAI_API_KEY is not set.'); process.exit(1); }

const client = new OpenAI({ apiKey: key });
const page = await client.models.list();
const ids = page.data.map(m => m.id).sort();

// Chat-capable ids first: those are the only candidates for a tier.
const chat = ids.filter(id => /^(gpt|o[0-9]|chatgpt)/.test(id)
  && !/(audio|realtime|transcribe|tts|image|search|embedding|moderation|codex)/.test(id));
const other = ids.filter(id => !chat.includes(id));

console.log(`\n${chat.length} chat-capable model(s):\n`);
for (const id of chat) console.log('  ' + id);
console.log(`\n${other.length} other model(s) (audio, image, embeddings, ...):\n`);
console.log('  ' + other.join('\n  ') + '\n');
