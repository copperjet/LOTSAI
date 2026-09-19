/**
 * The pictures a lesson holds.
 *
 * Same bargain as the study pack's assets (lib/studypack/assets.ts), with one
 * difference that matters: a pack draws a picture at about 76mm on a printed
 * page, and a lesson projects it across two metres of wall. So the stored edge
 * is bigger here, and the weight allowance with it.
 *
 * It is a module of its own rather than a parameter on the pack's because the
 * pack's is working, is on the approval path of every artefact the school has
 * produced so far, and its sizing decisions are about print. Two small modules
 * that each say what they are for beat one that takes a table name.
 *
 * They are inlined as data URIs, not linked, for the same reason the pack's are:
 * the deck has to be self-contained. The headless print has no session and
 * /api/document/view is behind sign-in, so a linked image prints as a blank
 * rectangle - and the PowerPoint export needs the bytes in hand anyway.
 */
import { admin } from '@/lib/supabase';

const BUCKET = 'artefacts';
const PREFIX = 'lesson_asset';

/** Longest side, in pixels. A slide is projected, so this is generous. */
const MAX_EDGE = 1920;
/** What a stored picture may weigh. A deck of twenty of these still has to move. */
export const MAX_STORED_BYTES = 600_000;
/** What may be handed to a lesson. Anything else is a document, not a picture. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** What may be uploaded before resizing, so a bad file fails at the door. */
export const MAX_UPLOAD_BYTES = 12_000_000;

export interface LessonAsset {
  id: string;
  kind: 'upload' | 'generated';
  contentType: string;
  bytes: number;
  alt: string;
  prompt: string | null;
}

/**
 * Squeeze a picture down to something a deck can carry.
 *
 * Never fatal. sharp is a native module, and a lesson losing its picture
 * because a binary would not load on some host is worse than a deck that is
 * heavier than it should be.
 */
async function shrink(
  bytes: Uint8Array, contentType: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  try {
    const sharp = (await import('sharp')).default;
    const img = sharp(Buffer.from(bytes), { failOn: 'none' });
    const meta = await img.metadata();
    const edge = Math.max(meta.width ?? 0, meta.height ?? 0);

    let pipeline = img.rotate();    // honour the phone's orientation tag, then drop it
    if (edge > MAX_EDGE) {
      pipeline = pipeline.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside' });
    }
    const out = meta.hasAlpha
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();

    return {
      bytes: new Uint8Array(out),
      contentType: meta.hasAlpha ? 'image/png' : 'image/jpeg',
    };
  } catch (e) {
    console.error(`[lesson-asset] could not resize (${contentType}), storing as uploaded: `
      + `${e instanceof Error ? e.message : String(e)}`);
    return { bytes, contentType };
  }
}

export async function saveAsset(o: {
  lessonId: string;
  bytes: Uint8Array;
  contentType: string;
  kind: 'upload' | 'generated';
  alt: string;
  prompt?: string | null;
}): Promise<{ id: string } | null> {
  const db = admin();
  const small = await shrink(o.bytes, o.contentType);

  const row = await db.from('lesson_asset').insert({
    lesson_id: o.lessonId,
    kind: o.kind,
    content_type: small.contentType,
    bytes: small.bytes.byteLength,
    // Not optional: a slide is projected, printed and sometimes read aloud, and a
    // picture nobody can describe is a picture doing no teaching.
    alt: o.alt.trim() || 'Picture',
    prompt: o.prompt ?? null,
    storage_path: '',
  }).select('id').single();
  if (row.error) {
    console.error(`[lesson-asset] insert failed: ${row.error.message}`);
    return null;
  }

  const ext = small.contentType === 'image/png' ? 'png' : 'jpg';
  const path = `${PREFIX}/${row.data.id}.${ext}`;
  const up = await db.storage.from(BUCKET).upload(path, small.bytes, {
    contentType: small.contentType, upsert: true, cacheControl: '3600',
  });
  if (up.error) {
    // A row pointing at nothing renders as nothing, which is worse than no row.
    await db.from('lesson_asset').delete().eq('id', row.data.id);
    console.error(`[lesson-asset] upload failed: ${up.error.message}`);
    return null;
  }
  await db.from('lesson_asset').update({ storage_path: path }).eq('id', row.data.id);
  return { id: row.data.id };
}

export async function listAssets(lessonId: string): Promise<LessonAsset[]> {
  try {
    const { data } = await admin().from('lesson_asset')
      .select('id, kind, content_type, bytes, alt, prompt')
      .eq('lesson_id', lessonId).order('created_at', { ascending: true });
    return (data ?? []).map(a => ({
      id: a.id as string,
      kind: a.kind as 'upload' | 'generated',
      contentType: a.content_type as string,
      bytes: (a.bytes ?? 0) as number,
      alt: (a.alt ?? '') as string,
      prompt: (a.prompt ?? null) as string | null,
    }));
  } catch {
    return [];
  }
}

/**
 * Every picture in this lesson, as a data URI keyed by asset id.
 *
 * One download per asset. A deck has a handful, and the alternative - a signed
 * URL per picture - does not survive the headless print.
 */
export async function loadAssets(lessonId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const db = admin();
    const { data } = await db.from('lesson_asset')
      .select('id, storage_path, content_type').eq('lesson_id', lessonId);
    for (const a of data ?? []) {
      const path = a.storage_path as string;
      if (!path) continue;
      const file = await db.storage.from(BUCKET).download(path);
      if (file.error || !file.data) continue;
      const bytes = Buffer.from(await file.data.arrayBuffer());
      out[a.id as string] = `data:${a.content_type};base64,${bytes.toString('base64')}`;
    }
  } catch (e) {
    console.error(`[lesson-asset] could not load: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/** The raw bytes of every picture, for the PowerPoint export. */
export async function loadAssetBytes(
  lessonId: string,
): Promise<Record<string, { bytes: Buffer; contentType: string }>> {
  const out: Record<string, { bytes: Buffer; contentType: string }> = {};
  try {
    const db = admin();
    const { data } = await db.from('lesson_asset')
      .select('id, storage_path, content_type').eq('lesson_id', lessonId);
    for (const a of data ?? []) {
      const path = a.storage_path as string;
      if (!path) continue;
      const file = await db.storage.from(BUCKET).download(path);
      if (file.error || !file.data) continue;
      out[a.id as string] = {
        bytes: Buffer.from(await file.data.arrayBuffer()),
        contentType: a.content_type as string,
      };
    }
  } catch {
    /* a deck without its pictures still exports */
  }
  return out;
}
