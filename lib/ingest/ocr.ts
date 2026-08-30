/**
 * Read the text off a photographed page.
 *
 * A teacher's worksheet is more often a photograph than a file, so this is the
 * other door into the same reconciliation the .pdf/.docx path uses. What comes
 * back is *evidence*, not curriculum: every objective code it yields still goes
 * through reconcile() against the school's own registry, and an unresolved code
 * is shown and never used (main spec section 4). Nothing here writes curriculum.
 *
 * It goes through lib/llm.ts like every other model call, so it is metered in
 * ai_usage the same way - the ledger has no exception for the workflow that
 * happens to take a picture.
 */
import { call } from '@/lib/llm';

const SYSTEM = `Transcribe all text in this image verbatim.

Preserve objective codes exactly as they appear, character for character - a code
read wrongly is worse than a code not read at all. Keep the reading order of the
page. Do not summarise, do not correct, do not explain, and do not invent text
that is not there. If part of the page is unreadable, write [unreadable] in its
place rather than guessing.

Return the text and nothing else.`;

/** Media types a vision model will accept, and the route will let through. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export function isImageType(t: string): t is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(t);
}

export async function extractTextFromImage(
  bytes: Uint8Array, mediaType: string, userId: string,
): Promise<{ text: string; usage: unknown }> {
  const { data, usage } = await call<string>({
    tier: 'standard',
    workflow: 'ocr_extract',
    userId,
    system: SYSTEM,
    prompt: 'Transcribe this page.',
    images: [{ mediaType, base64: Buffer.from(bytes).toString('base64') }],
    maxTokens: 4096,
  });
  return { text: String(data ?? ''), usage };
}
