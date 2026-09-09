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

/**
 * How much may arrive in one upload, all files together.
 *
 * Not our number. Vercel caps the body of a serverless function request at 4.5 MB,
 * and it does so at the platform, before any route code runs - so a request over it
 * never reaches the size check below, never produces one of our messages, and lands
 * in the browser as the generic "that could not be sent". The routes promised five
 * files at 10 MB each; the platform allows about a tenth of that, and a modern phone
 * photograph is 2 to 5 MB, so a teacher sending two pages of a handbook was already
 * over it.
 *
 * Held slightly under the limit, because multipart framing and the field names are
 * part of the body too.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * The most one photograph may be.
 *
 * Beyond this a photograph is a scan, and base64 of it is a request nobody wants -
 * but the binding constraint is MAX_UPLOAD_BYTES above, and a per-file ceiling above
 * the whole-request ceiling is a ceiling that cannot be reached. Same number, so the
 * message a teacher gets names the file that is too big rather than the request.
 */
export const MAX_IMAGE_BYTES = MAX_UPLOAD_BYTES;

/** What is wrong with this set of files, before any of them is read. Total first: it
 *  is the one that fails at the platform and therefore the one with no message. */
export function tooMuch(files: { name: string; size: number }[]): string | null {
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total <= MAX_UPLOAD_BYTES) return null;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return files.length === 1
    ? `${files[0].name} is ${mb(total)}. One upload must be under ${mb(MAX_UPLOAD_BYTES)} - `
      + 'take the photograph again at a lower resolution, or send the pages separately.'
    : `Those ${files.length} files come to ${mb(total)} together. One upload must be under `
      + `${mb(MAX_UPLOAD_BYTES)} - send them in two goes.`;
}

export function kindOf(file: File): Kind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  // .docx only. mammoth reads the zipped XML format and nothing else, so matching
  // /\.docx?$/ here sent a legacy binary .doc down the docx path, where it threw and
  // was reported to the teacher as a file that could not be read - the same message a
  // dark photograph gets. An unreadable kind belongs to the caller to explain.
  if (name.endsWith('.docx')) return 'docx';
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
