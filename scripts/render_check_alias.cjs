/**
 * Resolve the project's "@/" import alias for the compiled render_check harness.
 *
 * tsc rewrites nothing at emit - it resolves "@/lib/pdf/layout" at type-check time and
 * leaves the specifier alone in the JavaScript - so plain node cannot find it. Next
 * does this for the application; this does it for the one script that runs outside it.
 *
 *   node -r ./scripts/render_check_alias.cjs .render-check/scripts/render_check.js out.html
 */
const path = require('node:path');
const Module = require('node:module');
const root = path.join(__dirname, '..', '.render-check');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request.startsWith('@/') ? path.join(root, request.slice(2)) : request, ...rest);
};
