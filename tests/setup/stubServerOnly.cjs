// "server-only" throws unless Next.js's own webpack config aliases it to
// a no-op, which only happens inside a real Next.js build — importing a
// lib file directly from a plain node:test run (no Next.js involved)
// would otherwise fail immediately. This redirects the module id to an
// empty file for test runs only, the moral equivalent of Jest's
// moduleNameMapper for the same package, since node:test has no built-in
// module aliasing. Loaded via createRequire() at the top of
// tests/batchCompletion.test.ts — never touches how the real app
// resolves "server-only". Plain CJS require() is the point here (this
// hook has to run before any ESM import is evaluated), not an oversight.
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("module");
const path = require("path");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "server-only") {
    return path.join(__dirname, "noopServerOnly.cjs");
  }
  return originalResolve.call(this, request, ...args);
};
