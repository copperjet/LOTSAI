/**
 * pdf-lib layout primitives.
 *
 * Ported to Node from eScholr's supabase/functions/_shared/pdf/layout.ts, which
 * runs the same pipeline in production. The imports are the only substantive
 * change (Node `pdf-lib` rather than Deno `npm:pdf-lib`); `sanitizeWinAnsi` in
 * particular is carried over verbatim because it is load-bearing — every word in
 * a LOTS artefact comes from a language model, and the standard Helvetica fonts
 * throw at save() on any character outside cp1252. One curly quote in a teacher's
 * note would otherwise kill the whole render.
 *
 * Added beyond the port: `wrapText` and `embedDataUri`. A planner is a prose table
 * (methodology, differentiation) where eScholr's tables are single-line numbers,
 * so cells wrap rather than truncate; and the school crest is a data URI, so it is
 * decoded directly rather than fetched.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, RGB } from 'pdf-lib';

export const A4 = { width: 595.28, height: 841.89 } as const;
export const Margins = { top: 48, right: 40, bottom: 48, left: 40 } as const;
export const Fonts = {
  bodySize: 10, smallSize: 8.5, headingSize: 16, subheadSize: 12, lineHeight: 1.35,
} as const;

export interface DocCtx {
  doc: PDFDocument; regular: PDFFont; bold: PDFFont; italic: PDFFont;
}

export async function newDoc(): Promise<DocCtx> {
  const doc = await PDFDocument.create();
  return {
    doc,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
}

export function newPage(ctx: DocCtx): PDFPage {
  return ctx.doc.addPage([A4.width, A4.height]);
}

/** Current page + Y position, auto-advancing to a new page on overflow. */
export class Cursor {
  page: PDFPage;
  y: number;
  constructor(private ctx: DocCtx, page?: PDFPage) {
    this.page = page ?? newPage(ctx);
    this.y = A4.height - Margins.top;
  }
  /** True when a page break occurred, so a caller can redraw a table header. */
  ensure(spaceNeeded: number): boolean {
    if (this.y - spaceNeeded < Margins.bottom) {
      this.page = newPage(this.ctx);
      this.y = A4.height - Margins.top;
      return true;
    }
    return false;
  }
  advance(dy: number): void { this.y -= dy; }
}

const HEX_RE = /^#?([0-9a-f]{6})$/i;
export function parseHex(hex: string | null | undefined, fallback: RGB = rgb(0.1, 0.1, 0.1)): RGB {
  if (!hex) return fallback;
  const m = HEX_RE.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

/**
 * WinAnsi (cp1252) sanitizer. The standard Helvetica fonts throw at save() on any
 * character outside cp1252 — a single curly quote in a note would kill the job.
 * Latin-1 and the cp1252 extras pass through; accented chars outside that range
 * fall back to their base letter; anything else becomes "?". Carried verbatim
 * from eScholr — do not "simplify" it.
 */
const WINANSI_EXTRAS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ' + '‘’“”•–—˜™š›œžŸ';
export function sanitizeWinAnsi(text: string | null | undefined): string {
  if (!text) return '';
  let out = '';
  for (const ch of String(text).normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0xff && cp !== 0x7f) || WINANSI_EXTRAS.includes(ch)) { out += ch; continue; }
    if (ch === '\t') { out += '  '; continue; }
    if (ch === '\n' || ch === '\r') { out += ' '; continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base && base !== ch && [...base].every((c) => {
      const b = c.codePointAt(0)!; return b >= 0x20 && b <= 0xff && b !== 0x7f;
    })) { out += base; continue; }
    out += '?';
  }
  return out;
}

/** Truncate to fit `maxWidth`, appending an ellipsis when cut. Sanitized input. */
export function truncateToWidth(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (maxWidth <= 0 || !text) return '';
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ell = '…', ellW = font.widthOfTextAtSize(ell, size);
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid), size) + ellW <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '' : text.slice(0, lo).trimEnd() + ell;
}

/**
 * Break `text` into lines that each fit `maxWidth`, greedy by word, honouring
 * existing newlines. A word longer than the column is broken by character rather
 * than allowed to overflow. This is the primitive a prose table needs and the
 * numeric tables in eScholr did not.
 */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const safe = sanitizeWinAnsi(text);
  const out: string[] = [];
  for (const para of safe.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) { line = trial; continue; }
      if (line) out.push(line);
      // A single word wider than the column: hard-break it.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) chunk += ch;
          else { if (chunk) out.push(chunk); chunk = ch; }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    out.push(line);   // keep blank lines so paragraph spacing survives
  }
  return out.length ? out : [''];
}

export function drawText(
  page: PDFPage, text: string, x: number, y: number,
  opts: { font: PDFFont; size?: number; color?: RGB; maxWidth?: number },
): void {
  const size = opts.size ?? Fonts.bodySize;
  let safe = sanitizeWinAnsi(text);
  if (opts.maxWidth !== undefined) safe = truncateToWidth(opts.font, safe, size, opts.maxWidth);
  page.drawText(safe, { x, y, size, font: opts.font, color: opts.color ?? rgb(0.1, 0.1, 0.1) });
}

/** Embed a base64 data: URI image (the school crest). Returns null on any fault
 *  so a render never fails for want of a logo. */
export async function embedDataUri(ctx: DocCtx, dataUri: string | null | undefined) {
  if (!dataUri?.startsWith('data:')) return null;
  try {
    const [head, b64] = dataUri.split(',', 2);
    if (!b64) return null;
    const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
    const isJpg = /jpe?g/i.test(head);
    const image = isJpg ? await ctx.doc.embedJpg(bytes) : await ctx.doc.embedPng(bytes);
    return { image, w: image.width, h: image.height };
  } catch {
    return null;
  }
}
