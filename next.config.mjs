/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // pdfjs-dist and mammoth do their own file resolution at runtime (pdfjs loads a
  // worker module, mammoth reads its templates). Bundling them breaks that — pdfjs
  // fails with "Setting up fake worker failed" — so they run from node_modules on
  // the server instead. These routes are runtime='nodejs' already.
  serverExternalPackages: ['pdfjs-dist', 'mammoth'],

  // Leaving them external is necessary but not sufficient. In Node, pdfjs sets
  // GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs" and import()s that path at
  // run time (legacy/build/pdf.mjs). A computed dynamic import is invisible to
  // static tracing, so the worker was never copied into the lambda and every PDF
  // upload in production failed with
  //   Cannot find module '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
  // while working locally, where the whole of node_modules is on disk. Naming the
  // file here is what puts it next to pdf.mjs in the deployment.
  outputFileTracingIncludes: {
    '/api/ingest/upload': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      // mammoth resolves its own files the same way, and a .docx upload has never
      // been proven in production either.
      './node_modules/mammoth/**',
    ],
  },
};
