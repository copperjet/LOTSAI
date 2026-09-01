/**
 * Print an HTML document to PDF with a headless browser.
 *
 * Two artefacts are page-designed documents whose design lives entirely in their CSS -
 * the study pack and homework - and redrawing either of them in pdf-lib would be a
 * second layout engine to keep in step with the first. So the browser does it, and
 * there is exactly one design per document.
 *
 * Extracted from lib/pdf/renderers/studypack_print.ts when homework needed the same
 * thing. Callers own the fallback: this throws if no browser can be started, and what
 * to draw instead is the artefact's decision, not this file's.
 */

/** Launch flags for a browser we did not build. Font hinting is a screen optimisation
 *  that wants fontconfig, and off is both faster and one less thing to fail. */
const LOCAL_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'];

/** Where a browser might be on a development machine, when none is configured. */
const LOCAL_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * @param html    a self-contained document
 * @param footer  Chrome's running-footer template, or null to print with no margins
 */
export async function printHtmlToPdf(html: string, footer: string | null): Promise<Uint8Array> {
  const puppeteer = await import('puppeteer-core');

  const cfg = await browserConfig();
  if (!cfg.executablePath) throw new Error('no chrome executable found (set CHROME_EXECUTABLE_PATH)');

  const browser = await puppeteer.launch(cfg);
  try {
    const page = await browser.newPage();
    // 'load' waits on the Google Fonts stylesheet, which is the one thing in these
    // documents that can hang on a serverless container's network. The faces are
    // waited for separately below, and never fatally.
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // A document printed before Fraunces arrives reflows every heading, so wait for
    // the faces themselves rather than for the load event alone. Never fatal: a pack
    // in the fallback font is still a pack.
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
    if (split) console.log(`[pdf] ${split} sheet(s) ran past the page and were continued`);
    // Hand the media emulation back before printing. page.pdf() prints with the print
    // stylesheet either way, and leaving the override on made it fail with
    // "Protocol error (IO.read): Read failed" - a fallback to a plainer PDF, which is
    // a real loss for a document whose whole design is in its CSS.
    await page.emulateMediaType(undefined).catch(() => { /* nothing to undo */ });
    const bytes = await page.pdf({
      printBackground: true,
      // The document's own @page rule decides A4 landscape or a 16:9 slide, and leaves
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
    return { executablePath: configured, args: LOCAL_ARGS, headless: true as const };
  }

  // Only in a real serverless container. `VERCEL` alone is not the test: `vercel env
  // pull` writes it into .env.local, so a developer's machine claims to be Vercel and
  // would go looking for a Linux chromium binary that is not there.
  if (process.env.AWS_LAMBDA_FUNCTION_NAME
      || (process.env.VERCEL && process.env.NODE_ENV === 'production')) {
    const chromium = (await import('@sparticuz/chromium')).default;
    return {
      executablePath: await chromium.executablePath(),
      // Its own args, plus one of ours. @sparticuz/chromium stopped exporting
      // `headless` and `defaultViewport` at v131; the build is headless either way.
      args: [...chromium.args, '--font-render-hinting=none'],
      headless: true as const,
    };
  }

  const { existsSync } = await import('node:fs');
  return {
    executablePath: LOCAL_CHROME.find(p => existsSync(p)) ?? '',
    args: LOCAL_ARGS,
    headless: true as const,
  };
}
