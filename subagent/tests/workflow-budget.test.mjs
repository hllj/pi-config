// Unit tests for the token-budget-nudge logic in subagent/workflow-engine.ts
// (totalWorkflowTokens / nextBudgetThresholdCrossed / formatBudgetNudge).
//
// Run via run-workflow-budget.sh (copies the CURRENT workflow-engine.ts into a
// throwaway bare workspace — it's dependency-free), or directly with
// Node >= 22: cd <workdir> && node workflow-budget.test.mjs

import {
	createWorkflowState,
	totalWorkflowTokens,
	nextBudgetThresholdCrossed,
	formatBudgetNudge,
} from "./workflow-engine.ts";

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
	if (actual === expected) ok(n);
	else fail(n, `expected ${expected}, got ${actual}`);
};
const assertTrue = (n, cond) => (cond ? ok(n) : fail(n, "expected true"));

const usage = (n) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 });

console.log("== createWorkflowState budgetTokens ==");
{
	const noBudget = createWorkflowState([{ agent: "a", task: "t" }]);
	assertEq("no budget arg -> undefined", noBudget.budgetTokens, undefined);
	const withBudget = createWorkflowState([{ agent: "a", task: "t" }], "n", 1000);
	assertEq("budget arg stored", withBudget.budgetTokens, 1000);
	const zeroBudget = createWorkflowState([{ agent: "a", task: "t" }], "n", 0);
	assertEq("zero/invalid budget is dropped, not stored as 0", zeroBudget.budgetTokens, undefined);
}

console.log("== totalWorkflowTokens ==");
{
	let state = createWorkflowState([{ agent: "a", task: "t" }, { agent: "b", task: "t2" }]);
	assertEq("no usage recorded yet -> 0", totalWorkflowTokens(state), 0);
	state.results[0].usage = usage(100);
	state.results[1].usage = usage(50);
	assertEq("sums usage across steps", totalWorkflowTokens(state), 150);
}

console.log("== nextBudgetThresholdCrossed ==");
{
	assertEq("no budget set -> undefined", nextBudgetThresholdCrossed(9999, undefined, []), undefined);
	assertEq("zero budget -> undefined", nextBudgetThresholdCrossed(9999, 0, []), undefined);
	assertEq("below 60% -> undefined", nextBudgetThresholdCrossed(500, 1000, []), undefined);
	assertEq("at 60% -> 60", nextBudgetThresholdCrossed(600, 1000, []), 60);
	assertEq("at 70% (between 60/85), 60 already sent -> undefined", nextBudgetThresholdCrossed(700, 1000, [60]), undefined);
	assertEq("at 90%, only 60 sent -> 85 (jumps straight to highest crossed)", nextBudgetThresholdCrossed(900, 1000, [60]), 85);
	assertEq("both thresholds already sent -> undefined", nextBudgetThresholdCrossed(1200, 1000, [60, 85]), undefined);
}

console.log("== formatBudgetNudge ==");
{
	const withNext = formatBudgetNudge(60, 600, 1000, { index: 2, agent: "worker" });
	assertTrue("mentions percent/budget/remaining", withNext.includes("60%") && withNext.includes("1000-token") && withNext.includes("400 remaining"));
	assertTrue("names the next step", withNext.includes("#3 (worker)"));
	assertTrue("states it's advisory only", withNext.toLowerCase().includes("advisory only"));

	const noNext = formatBudgetNudge(85, 900, 1000);
	assertTrue("no next step -> says none queued", noNext.includes("No further steps queued"));
}

console.log(`SUITE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
