/**
 * Reading text off a file, whatever kind of file it is.
 *
 * These lived inside /api/ingest/upload, which was the only route that read a file.
 * /api/school-fact reads one too - an administrator pasting the uniform policy is more
 * often holding a PDF of the staff handbook than the words themselves - and a second
 * copy of "how do we get text out of a PDF" is how two doors start disagreeing about
 * what a readable file is. So they moved here whole; the upload route imports them and
 * behaves exactly as before.
 *
 * Nothing here reconciles, stores or interprets. It turns bytes into text and stops.
 */
import { extractTextFromImage, isImageType } from './ocr';

export type Kind = 'pdf' | 'docx' | 'image';

/** Beyond this a photograph is a scan, and base64 of it is a request nobody wants. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function kindOf(file: File): Kind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (/\.docx?$/.test(name)) return 'docx';
  if (isImageType(file.type)) return 'image';
  return null;
}

/** PDF text via pdfjs (legacy build runs in Node; no worker needed for text). */
export async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += (content.items as { str?: string }[]).map(it => it.str ?? '').join(' ') + '\n';
  }
  return text;
}

/** DOCX raw text via mammoth. */
export async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}

/**
 * One file's text, by its kind. A photograph goes through the vision model and so
 * costs a metered call; the other two are local parsing and cost nothing.
 */
export async function extractFile(file: File, kind: Kind, userId: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === 'pdf') return extractPdf(bytes);
  if (kind === 'docx') return extractDocx(bytes);
  return (await extractTextFromImage(bytes, file.type, userId)).text;
}
