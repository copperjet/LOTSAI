/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // pdfjs-dist and mammoth do their own file resolution at runtime (pdfjs loads a
  // worker module, mammoth reads its templates). Bundling them breaks that — pdfjs
  // fails with "Setting up fake worker failed" — so they run from node_modules on
  // the server instead. These routes are runtime='nodejs' already.
  serverExternalPackages: ['pdfjs-dist', 'mammoth'],
};
