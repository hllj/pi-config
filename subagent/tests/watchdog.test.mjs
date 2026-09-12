// Unit tests for subagent/watchdog.ts (pure trigger/stalemate logic).
//
// Run via run-watchdog.sh (copies the CURRENT watchdog.ts into a throwaway
// bare workspace), or directly with Node >= 22: cd <workdir> && node watchdog.test.mjs

import {
	newWatchdogTriggerState,
	recordWatchdogTool,
	shouldRunWatchdog,
	resetWatchdogTriggerState,
	parseWatchdogFindings,
	buildWatchdogReviewTask,
	formatWatchdogSteer,
	hashWatchdogFindings,
	newWatchdogStalemateState,
	trackWatchdogStalemate,
} from "./watchdog.ts";

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
const assertTrue = (n, cond) => (cond ? ok(n) : fail(n, "expected true"));
const assertFalse = (n, cond) => (!cond ? ok(n) : fail(n, "expected false"));

console.log("== trigger state: mutation boundary ==");
{
	const s = newWatchdogTriggerState();
	recordWatchdogTool(s, "read");
	assertFalse("no trigger after a single read", shouldRunWatchdog(s));
	recordWatchdogTool(s, "edit");
	assertTrue("mutation triggers immediately", shouldRunWatchdog(s));
	resetWatchdogTriggerState(s);
	assertFalse("reset clears the trigger", shouldRunWatchdog(s));
}

console.log("== trigger state: cadence ==");
{
	const s = newWatchdogTriggerState();
	for (let i = 0; i < 4; i++) recordWatchdogTool(s, "read");
	assertFalse("below cadence floor (5) does not trigger", shouldRunWatchdog(s));
	recordWatchdogTool(s, "read");
	assertTrue("cadence floor of 5 triggers even if cadence arg is lower", shouldRunWatchdog(s, 3));
}
{
	const s = newWatchdogTriggerState();
	for (let i = 0; i < 9; i++) recordWatchdogTool(s, "grep");
	assertFalse("just below a configured cadence of 10 does not trigger", shouldRunWatchdog(s, 10));
	recordWatchdogTool(s, "grep");
	assertTrue("configured cadence of 10 triggers at 10", shouldRunWatchdog(s, 10));
}

console.log("== parseWatchdogFindings ==");
{
	assertEq("empty/invalid input -> []", parseWatchdogFindings(null), []);
	assertEq("missing findings field -> []", parseWatchdogFindings({}), []);
	const good = {
		findings: [
			{ severity: "high", category: "correctness", evidence: "e", recommendedAction: "a" },
		],
	};
	assertEq("well-formed findings pass through", parseWatchdogFindings(good), good.findings);
	const mixed = {
		findings: [
			{ severity: "high", category: "correctness", evidence: "e", recommendedAction: "a" },
			{ severity: "high" }, // missing fields - dropped
			"not an object", // dropped
		],
	};
	assertEq("malformed entries are dropped, valid ones kept", parseWatchdogFindings(mixed), [mixed.findings[0]]);
}

console.log("== prompt/steer text ==");
{
	const task = buildWatchdogReviewTask("/repo");
	assertTrue("task mentions git diff and the cwd", task.includes("git diff") && task.includes("/repo"));
	assertTrue("task lists all five categories", ["correctness", "test-gap", "loop-risk", "scope-drift", "unsafe-change"].every((c) => task.includes(c)));

	const steer = formatWatchdogSteer([
		{ severity: "high", category: "correctness", evidence: "foo.ts:10 returns null", recommendedAction: "add a null check" },
	]);
	assertTrue("steer includes severity/category/evidence/action", steer.includes("high/correctness") && steer.includes("foo.ts:10 returns null") && steer.includes("add a null check"));
	assertTrue("steer mentions the disable command", steer.includes("/watchdog"));
}

console.log("== stalemate detection ==");
{
	const findingsA = [{ severity: "low", category: "test-gap", evidence: "x", recommendedAction: "y" }];
	const findingsB = [{ severity: "high", category: "correctness", evidence: "z", recommendedAction: "w" }];
	const hashA = hashWatchdogFindings(findingsA);
	const hashB = hashWatchdogFindings(findingsB);
	assertTrue("different finding sets hash differently", hashA !== hashB);
	assertEq("empty findings hash to empty string", hashWatchdogFindings([]), "");

	const st = newWatchdogStalemateState();
	assertFalse("1st occurrence not suppressed", trackWatchdogStalemate(st, hashA, 3));
	assertFalse("2nd occurrence not suppressed", trackWatchdogStalemate(st, hashA, 3));
	assertFalse("3rd occurrence not suppressed (streak==threshold)", trackWatchdogStalemate(st, hashA, 3));
	assertTrue("4th identical occurrence is suppressed (streak>threshold)", trackWatchdogStalemate(st, hashA, 3));

	assertFalse("a genuinely different finding set resets the streak", trackWatchdogStalemate(st, hashB, 3));
	assertFalse("an empty findings set resets and is never suppressed", trackWatchdogStalemate(st, hashWatchdogFindings([]), 3));
	assertFalse("after an empty reset, the same old hash starts fresh", trackWatchdogStalemate(st, hashA, 3));
}

console.log(`SUITE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
