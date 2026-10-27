// Audit 2026-10-26 P2-E: one Node major across the places that pick one.
//
// package.json `engines.node` is what Vercel builds with when it is set
// (it takes precedence over the project's Node.js setting), the CI
// workflow's `node-version` is what the tests run on, and `.nvmrc` is what
// a developer's machine picks. They had drifted: engines said 22, CI said
// 22, and the Vercel project setting said 24.x. This check fails CI when
// the repository's own three disagree. The Vercel project setting cannot be
// read from here without a token; see the PR's deployment memo for it.
//
//   node scripts/check-node-version.mjs
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const engines = JSON.parse(read("package.json")).engines?.node ?? "";
const enginesMajor = /^>=(\d+)\s+<(\d+)$/.exec(engines.trim());
if (!enginesMajor || Number(enginesMajor[2]) !== Number(enginesMajor[1]) + 1) {
  console.error(`package.json engines.node must pin one major as ">=N <N+1", got "${engines}"`);
  process.exit(1);
}
const major = Number(enginesMajor[1]);

const ciVersions = [...read(".github/workflows/ci.yml").matchAll(/node-version:\s*["']?(\d+)/g)].map((m) => Number(m[1]));
const nvmrc = Number(/^v?(\d+)/.exec(read(".nvmrc").trim())?.[1]);

const problems = [];
if (ciVersions.length === 0) problems.push("ci.yml sets no node-version");
for (const v of ciVersions) if (v !== major) problems.push(`ci.yml node-version ${v} != engines ${major}`);
if (nvmrc !== major) problems.push(`.nvmrc ${nvmrc} != engines ${major}`);

if (problems.length) {
  console.error(`Node version drift:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Node ${major} everywhere the repository pins it (engines, CI, .nvmrc).`);
