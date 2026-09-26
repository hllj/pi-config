// Unit tests for subagent/timeout.ts (per-call vs frontmatter timeout resolution).
//
// Run via run-timeout.sh (copies the CURRENT timeout.ts into a throwaway
// bare workspace), or directly with Node >= 22: cd <workdir> && node timeout.test.mjs

import { resolveSubagentTimeoutMs } from "./timeout.ts";

let passed = 0;
let failed = 0;
const fail = (n, m) => {
	failed++;
	console.log(`  ✗ ${n}: ${m}`);
};
const ok = (n) => {
	passed++;
	console.log(`  ✓ ${n}`);
};
const assertEq = (n, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) ok(n);
	else fail(n, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const MIN = 60_000;

console.log("== no floor: existing behaviour ==");
assertEq("no timeouts at all -> undefined (no timer)", resolveSubagentTimeoutMs(undefined, {}), undefined);
assertEq("frontmatter timeoutMs is the default", resolveSubagentTimeoutMs(undefined, { timeoutMs: 10 * MIN }), 10 * MIN);
assertEq("per-call timeout beats frontmatter timeoutMs", resolveSubagentTimeoutMs(3 * MIN, { timeoutMs: 10 * MIN }), 3 * MIN);

console.log("== minTimeoutMs floor ==");
// pi-bench 0925/0926: the parent passed 180-300s to `reviewer`, whose turns
// can take 100-285s each -- it was killed mid-thought with no verdict.
assertEq("a per-call timeout below the floor is raised to it", resolveSubagentTimeoutMs(4 * MIN, { timeoutMs: 10 * MIN, minTimeoutMs: 7 * MIN }), 7 * MIN);
assertEq("a per-call timeout above the floor is kept", resolveSubagentTimeoutMs(15 * MIN, { timeoutMs: 10 * MIN, minTimeoutMs: 7 * MIN }), 15 * MIN);
assertEq("the floor also lifts a low frontmatter default", resolveSubagentTimeoutMs(undefined, { timeoutMs: 2 * MIN, minTimeoutMs: 7 * MIN }), 7 * MIN);
assertEq("a floor alone does not invent a timer", resolveSubagentTimeoutMs(undefined, { minTimeoutMs: 7 * MIN }), undefined);
assertEq("a non-positive floor is ignored", resolveSubagentTimeoutMs(4 * MIN, { minTimeoutMs: 0 }), 4 * MIN);

console.log(`SUITE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
