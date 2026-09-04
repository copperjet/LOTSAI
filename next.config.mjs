/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  // Two servers in this directory at once (a dev server someone is using, and a
  // build or a second dev server on another port) both write .next and stand on
  // each other. Naming the directory lets the second one run without disturbing
  // the first. Unset in normal use, so the default stays .next.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // pdfjs-dist and mammoth do their own file resolution at runtime (pdfjs loads a
  // worker module, mammoth reads its templates). Bundling them breaks that — pdfjs
  // fails with "Setting up fake worker failed" — so they run from node_modules on
  // the server instead. These routes are runtime='nodejs' already.
  //
  // puppeteer-core and @sparticuz/chromium are external for the same reason: the
  // chromium package unpacks a brotli-compressed binary from its own directory at
  // run time, which bundling defeats.
  serverExternalPackages: ['pdfjs-dist', 'mammoth', 'puppeteer-core', '@sparticuz/chromium'],

  // Leaving them external is necessary but not sufficient. In Node, pdfjs sets
  // GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs" and import()s that path at
  // run time (legacy/build/pdf.mjs). A computed dynamic import is invisible to
  // static tracing, so the worker was never copied into the lambda and every PDF
  // upload in production failed with
  //   Cannot find module '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
  // while working locally, where the whole of node_modules is on disk. Naming the
  // file here is what puts it next to pdf.mjs in the deployment.
  outputFileTracingIncludes: {
    // The same failure, on the browser print. @sparticuz/chromium is external, which
    // is necessary and was not sufficient: it unpacks chromium.br from its own bin/
    // directory at run time by a path it builds itself, and a path nothing imports is
    // a path the tracer cannot see. So bin/ was never copied into the lambda, every
    // print in production died with
    //   The input directory "/var/task/node_modules/@sparticuz/chromium/bin" does not exist
    // and every teacher got the plain pdf-lib fallback instead of the designed pack
    // (lib/pdf/renderers/studypack_print.ts). It worked locally, where a real Chrome
    // is found on disk and the package is never asked for its binary at all.
    //
    // Every route that can reach printHtmlToPdf needs it: a study pack or homework
    // renders its PDF on demand, and again on approval, on the way to Drive.
    '/api/studypack/pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
    '/api/studypack/approve': ['./node_modules/@sparticuz/chromium/bin/**'],
    '/api/homework/approve': ['./node_modules/@sparticuz/chromium/bin/**'],
    '/api/ingest/upload': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      // mammoth resolves its own files the same way, and a .docx upload has never
      // been proven in production either.
      './node_modules/mammoth/**',
    ],
  },
};
