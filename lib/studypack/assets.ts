/**
 * The pictures a study pack holds.
 *
 * A teacher can hand a pack a photograph - a page of a textbook, a diagram from the
 * board, a picture of the thing the lesson is about - and ask for it on a particular
 * page; and they can ask for one to be drawn. Both end up here: bytes in the private
 * `artefacts` bucket, a row in `study_pack_asset`, and an `image` block pointing at
 * it by id (lib/studypack/schema.ts).
 *
 * Two decisions worth knowing about.
 *
 * **Everything is re-encoded on the way in.** A phone photograph is four thousand
 * pixels wide and six megabytes, and a study pack is a printed A4 document where the
 * largest a picture is ever drawn is about 76mm. Ten of those would be a sixty
 * megabyte page that no browser prints. So every upload is resized and recompressed
 * before it is stored, once, rather than by every reader afterwards.
 *
 * **They are inlined, not linked.** `loadAssets` returns data URIs and the renderer
 * embeds them, because the document has to be self-contained: the headless print
 * (lib/pdf/browser.ts) has no session, and /api/document/view is behind sign-in, so a
 * linked image prints as a blank rectangle. The crest is carried the same way
 * (lib/crest.ts).
 */
import { admin } from '@/lib/supabase';

const BUCKET = 'artefacts';

/** Longest side, in pixels. A picture is drawn at about 76mm on the page; this is
 *  generous enough for print at 300dpi and nowhere near a camera's own size. */
const MAX_EDGE = 1600;

/** What a stored picture may weigh. Past this the page it sits on stops printing. */
export const MAX_STORED_BYTES = 400_000;

/** What may be handed to a pack. Anything else is a document, not a picture. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** What may be uploaded before resizing, so a bad file fails at the door. */
export const MAX_UPLOAD_BYTES = 12_000_000;

export interface PackAsset {
  id: string;
  kind: 'upload' | 'generated';
  contentType: string;
  bytes: number;
  alt: string;
  prompt: string | null;
}

/**
 * Squeeze a picture down to something a printed page can carry.
 *
 * Never fatal. sharp is a native module, and a pack losing its picture because a
 * binary would not load on some host is a worse outcome than a page that is a little
 * heavier than it should be - so a failure here stores the original and says so.
 */
async function shrink(
  bytes: Uint8Array, contentType: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  try {
    const sharp = (await import('sharp')).default;
    const img = sharp(Buffer.from(bytes), { failOn: 'none' });
    const meta = await img.metadata();
    const edge = Math.max(meta.width ?? 0, meta.height ?? 0);

    let pipeline = img.rotate();     // honour the phone's orientation tag, then drop it
    if (edge > MAX_EDGE) pipeline = pipeline.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside' });

    // PNG for anything with transparency - a diagram photographed off a whiteboard is
    // not that, but a screenshot or a drawn image often is, and flattening it onto
    // black is the kind of thing nobody notices until it is printed.
    const out = meta.hasAlpha
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: 78, mozjpeg: true }).toBuffer();

    return { bytes: new Uint8Array(out), contentType: meta.hasAlpha ? 'image/png' : 'image/jpeg' };
  } catch (e) {
    console.error(`[studypack-asset] could not resize (${contentType}), storing as uploaded: `
      + `${e instanceof Error ? e.message : String(e)}`);
    return { bytes, contentType };
  }
}

/**
 * Store one picture against a pack.
 *
 * Returns the asset id an `image` block points at. Throws rather than returning a
 * half-made row: an asset the store does not hold renders as nothing, and a teacher
 * who was told their photograph was added should not find a gap where it was.
 */
export async function saveAsset(o: {
  studyPackId: string;
  bytes: Uint8Array;
  contentType: string;
  alt: string;
  kind: 'upload' | 'generated';
  prompt?: string | null;
  authorId?: string | null;
}): Promise<PackAsset> {
  const alt = o.alt.trim();
  if (!alt) throw new Error('every picture needs a description');

  const small = await shrink(o.bytes, o.contentType);
  if (small.bytes.byteLength > MAX_STORED_BYTES) {
    throw new Error('that picture is too large for a printed page, even resized');
  }

  const db = admin();
  const ext = small.contentType === 'image/png' ? 'png' : 'jpg';

  // The row first, so the id names the file. An orphaned row with no object behind it
  // renders as nothing; an orphaned object with no row is a file nobody can find.
  const { data: row, error } = await db.from('study_pack_asset').insert({
    study_pack_id: o.studyPackId,
    kind: o.kind,
    storage_path: 'pending',
    content_type: small.contentType,
    bytes: small.bytes.byteLength,
    alt,
    prompt: o.prompt ?? null,
    author_id: o.authorId ?? null,
  }).select('id').single();

  if (error || !row) throw new Error(`could not record the picture: ${error?.message ?? 'no row'}`);

  const path = `study_pack_asset/${row.id}.${ext}`;
  const up = await db.storage.from(BUCKET).upload(path, small.bytes, {
    contentType: small.contentType, upsert: true, cacheControl: '3600',
  });
  if (up.error) {
    await db.from('study_pack_asset').delete().eq('id', row.id);
    throw new Error(`could not store the picture: ${up.error.message}`);
  }

  await db.from('study_pack_asset').update({ storage_path: path }).eq('id', row.id);

  return {
    id: row.id as string, kind: o.kind, contentType: small.contentType,
    bytes: small.bytes.byteLength, alt, prompt: o.prompt ?? null,
  };
}

/** What this pack holds, for the revise prompt and for the teacher to see. */
export async function listAssets(studyPackId: string): Promise<PackAsset[]> {
  try {
    const { data } = await admin().from('study_pack_asset')
      .select('id, kind, content_type, bytes, alt, prompt')
      .eq('study_pack_id', studyPackId)
      .order('created_at');
    return (data ?? []).map(r => ({
      id: r.id as string,
      kind: r.kind as 'upload' | 'generated',
      contentType: r.content_type as string,
      bytes: r.bytes as number,
      alt: r.alt as string,
      prompt: (r.prompt as string | null) ?? null,
    }));
  } catch {
    return [];   // pre-0017: a pack simply has no pictures
  }
}

/**
 * Every picture this pack holds, as `asset_id` to a `data:` URI, for the renderer.
 *
 * Tolerant throughout. A pack renders without its pictures rather than not at all:
 * the table may not exist yet, and an object can go missing from the bucket while its
 * row remains. An id absent from this map draws nothing (renderBlock, 'image').
 */
export async function loadAssets(studyPackId: string): Promise<Record<string, string>> {
  const db = admin();
  let rows: { id: string; storage_path: string; content_type: string }[] = [];
  try {
    const { data } = await db.from('study_pack_asset')
      .select('id, storage_path, content_type').eq('study_pack_id', studyPackId);
    rows = (data ?? []) as typeof rows;
  } catch {
    return {};   // pre-0017
  }
  if (!rows.length) return {};

  const out: Record<string, string> = {};
  await Promise.all(rows.map(async r => {
    if (!r.storage_path || r.storage_path === 'pending') return;
    const { data: blob, error } = await db.storage.from(BUCKET).download(r.storage_path);
    if (error || !blob) {
      console.error(`[studypack-asset] ${r.id} is recorded but not in the bucket`);
      return;
    }
    const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    out[r.id] = `data:${r.content_type};base64,${b64}`;
  }));
  return out;
}
