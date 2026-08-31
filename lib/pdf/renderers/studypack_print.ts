/**
 * Print a study pack to PDF with a headless browser.
 *
 * The pack's HTML is the print master: it carries @page sizing, sheet breaks, ruled
 * answer space and an answer key, and "GP LS3 Study Pack Formative 4.pdf" was itself
 * made by printing a page like it from Chrome. Redrawing all of that a second time in
 * pdf-lib would be a second layout engine to keep in step with the first, so the
 * browser does it instead and there is exactly one design.
 *
 * The pdf-lib renderer (./studypack.ts, registered as 'studypack-pdf-basic') stays as
 * the fallback. Approval delivers a pack to Google Drive, and that must not fail
 * because a browser could not be started in a serverless container - a plainer PDF is
 * a far better outcome than none.
 */
import { admin } from '@/lib/supabase';
import { renderPackHtml, footerTemplate } from '@/lib/studypack/render_html';
import { renderStudyPackHtml } from '@/lib/studypack_html';
import { renderStudyPackPdf } from './studypack';
import type { PackV2 } from '@/lib/studypack/schema';
import type { PackContent } from '@/lib/studypack';

/** Where a browser might be on a development machine, when none is configured. */
const LOCAL_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export async function renderStudyPackPrint(studyPackId: string): Promise<Uint8Array> {
  const db = admin();
  const { data: pack } = await db.from('study_pack')
    .select('content, subject_id, year_group, week_from, week_to').eq('id', studyPackId).single();
  if (!pack) throw new Error(`No study pack ${studyPackId}`);

  const content = pack.content as Partial<PackV2>;
  const v2 = Number(content?.version) === 2;
  const html = v2
    ? renderPackHtml(content as PackV2, { paged: true })
    : renderStudyPackHtml(pack.content as PackContent, {
        subject: pack.subject_id, yearGroup: pack.year_group,
        weekFrom: pack.week_from, weekTo: pack.week_to,
      });

  try {
    return await printToPdf(html, v2 ? footerTemplate(content as PackV2) : null);
  } catch (e) {
    // Loud, then fall back: a pack with a plain PDF is usable; a pack with none is not.
    console.error(`[studypack-pdf] browser print failed, falling back to pdf-lib: `
      + `${e instanceof Error ? e.message : String(e)}`);
    return renderStudyPackPdf(studyPackId);
  }
}

async function printToPdf(html: string, footer: string | null): Promise<Uint8Array> {
  const puppeteer = await import('puppeteer-core');

  const { executablePath, args, headless } = await browserConfig();
  if (!executablePath) throw new Error('no chrome executable found (set CHROME_EXECUTABLE_PATH)');

  const browser = await puppeteer.launch({ executablePath, args, headless });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    // The document is self-contained apart from the Google Fonts stylesheet. A pack
    // printed before Fraunces arrives reflows every heading, so wait for the faces
    // themselves rather than for the load event alone. Never fatal: a pack in the
    // fallback font is still a pack.
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => { /* fallback font */ });
    // Measure and split in print media, not screen: the print stylesheet is what the
    // page will actually be laid out with, and a sheet measured against the screen one
    // would be split in the wrong place. The document's own paginator does the work
    // (lib/studypack/render_html.ts) - it is the only thing that can know how tall a
    // block of the teacher's text really is.
    await page.emulateMediaType('print').catch(() => { /* older browser: skip */ });
    const split = await page.evaluate(
      'window.__packPaginate ? window.__packPaginate(window.__packPagePx) : 0',
    ).catch(() => 0);
    if (split) console.log(`[studypack-pdf] ${split} sheet(s) ran past the page and were continued`);
    // Hand the media emulation back before printing. page.pdf() prints with the print
    // stylesheet either way, and leaving the override on made it fail with
    // "Protocol error (IO.read): Read failed" - a fallback to the plain pdf-lib PDF,
    // which is a real loss for a document whose whole design is in its CSS.
    await page.emulateMediaType(undefined).catch(() => { /* nothing to undo */ });
    const bytes = await page.pdf({
      printBackground: true,
      // The pack's own @page rule decides A4 landscape or a 16:9 slide, and leaves
      // the strip at the foot that the running footer is stamped into.
      preferCSSPageSize: true,
      ...(footer
        ? { displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer }
        : { margin: { top: '0', right: '0', bottom: '0', left: '0' } }),
    });
    return new Uint8Array(bytes);
  } finally {
    await browser.close().catch(() => { /* the render already succeeded or failed */ });
  }
}

/**
 * Chromium on a serverless container, a real browser on a developer's machine.
 * `CHROME_EXECUTABLE_PATH` overrides both, and unsetting it is how the fallback path
 * is exercised in testing.
 */
async function browserConfig() {
  const configured = process.env.CHROME_EXECUTABLE_PATH;
  if (configured) {
    return { executablePath: configured, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true as const };
  }

  // Only in a real serverless container. `VERCEL` alone is not the test: `vercel env
  // pull` writes it into .env.local, so a developer's machine claims to be Vercel and
  // would go looking for a Linux chromium binary that is not there.
  if (process.env.AWS_LAMBDA_FUNCTION_NAME
      || (process.env.VERCEL && process.env.NODE_ENV === 'production')) {
    const chromium = (await import('@sparticuz/chromium')).default;
    return {
      executablePath: await chromium.executablePath(),
      args: chromium.args,
      headless: true as const,
    };
  }

  const { existsSync } = await import('node:fs');
  return {
    executablePath: LOCAL_CHROME.find(p => existsSync(p)) ?? '',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    headless: true as const,
  };
}
