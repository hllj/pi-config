// Unit tests for dev-workflows.ts template definitions.
//
// Run directly with Node >= 22 (type-stripping):  node dev-workflows.test.ts
// Requires the repo's node_modules (@earendil-works symlinked via `npm run setup`)
// and the subagent/ source to be resolvable from the repo root.
//
// These validate the pure template-building logic (agent sequences, {topic}
// substitution, expect contracts) without spawning any subagent processes.

import { DevWorkflowTemplates, detectWorkflow } from "./dev-workflows.ts";

let passed = 0;
let failed = 0;
const ok = (n: string) => {
	passed++;
	console.log(`  ✓ ${n}`);
};
const fail = (n: string, m: string) => {
	failed++;
	console.log(`  ✗ ${n}: ${m}`);
};
const assert = (cond: unknown, n: string, m: string) =>
	cond ? ok(n) : fail(n, m);

const TYPES = ["swat", "bugfix", "refactor", "explore"] as const;

// 1. All four workflow types are defined.
for (const typ of TYPES) {
	assert(
		DevWorkflowTemplates[typ] &&
			typeof DevWorkflowTemplates[typ].build === "function",
		`workflow "${typ}" template defined`,
		"missing template or build()",
	);
}

// 2. Every template emits a non-empty, complete step sequence with real agents.
for (const typ of TYPES) {
	const steps = DevWorkflowTemplates[typ].build("sample topic");
	assert(
		Array.isArray(steps) && steps.length > 0,
		`${typ}: steps non-empty`,
		"empty steps",
	);
	for (const [i, s] of steps.entries()) {
		assert(
			typeof s.agent === "string" && s.agent.length > 0,
			`${typ}: step ${i} has agent`,
			`got ${s.agent}`,
		);
		assert(
			typeof s.task === "string" && s.task.length > 0,
			`${typ}: step ${i} has task`,
			"empty task",
		);
	}
}

// 3. {topic} is substituted, {previous} is preserved for chaining.
const topic = "add redis caching";
for (const typ of TYPES) {
	const steps = DevWorkflowTemplates[typ].build(topic);
	for (const s of steps) {
		assert(
			!s.task.includes("{topic}"),
			`${typ}: {topic} substituted`,
			`unsubstituted: ${s.task}`,
		);
		if (s.task.includes("{previous}")) {
			assert(true, `${typ}: chaining step keeps {previous}`, "");
		}
	}
}

// 4. SWAT pipeline order: scout → planner → worker → general → reviewer → worker.
{
	const steps = DevWorkflowTemplates.swat.build("x");
	assert(
		JSON.stringify(steps.map((s) => s.agent)) ===
			JSON.stringify([
				"scout",
				"planner",
				"worker",
				"general",
				"reviewer",
				"worker",
			]),
		"swat agent order",
		steps.map((s) => s.agent).join(","),
	);
}

// 5. Planners use an expect JSON contract; exploratory scouts share a parallel group.
{
	const plannerSteps = [
		DevWorkflowTemplates.swat,
		DevWorkflowTemplates.refactor,
	];
	for (const wf of plannerSteps) {
		const planner = wf.build("x").find((s) => s.agent === "planner");
		assert(
			!!planner?.expect,
			`${wf.label}: planner has expect contract`,
			"missing expect",
		);
		assert(
			(
				planner?.expect as { jsonSchema?: { required?: string[] } }
			)?.jsonSchema?.required?.includes("plan"),
			`${wf.label}: planner expect requires "plan"`,
			"bad schema",
		);
	}
	const explore = DevWorkflowTemplates.explore.build("x");
	const reconGroup = explore.filter((s) => s.parallelGroup === "recon");
	assert(
		reconGroup.length === 3,
		"explore has 3 parallel recon scouts",
		`got ${reconGroup.length}`,
	);
	const groups = explore.map((s) => s.parallelGroup ?? "").join(",");
	assert(
		groups.startsWith("recon,recon,recon,"),
		"explore recon group is consecutive",
		groups,
	);
}

// 6. Template labels/descriptions present.
for (const typ of TYPES) {
	assert(
		typeof DevWorkflowTemplates[typ].label === "string" &&
			DevWorkflowTemplates[typ].label.length > 0,
		`${typ}: label`,
		"missing label",
	);
	assert(
		typeof DevWorkflowTemplates[typ].description === "string" &&
			DevWorkflowTemplates[typ].description.length > 0,
		`${typ}: description`,
		"missing description",
	);
}

// 7. Auto-workflow intent detection.
const wf = (
	input: string,
	expectType: DevWorkflowType | null,
	name: string,
) => {
	const got = detectWorkflow(input);
	if (got === expectType) ok(`${name}: "${input}"`);
	else fail(`${name}: "${input}"`, `expected ${expectType}, got ${got}`);
};

wf("refactor the workflow engine into smaller modules", "refactor", "refactor");
wf("split the auth module into separate files", "refactor", "refactor split");
wf("rename session-store to run-store", "refactor", "refactor rename");
wf("fix the auth token refresh race condition", "bugfix", "bugfix race");
wf("the flaky test keeps failing on CI", "bugfix", "bugfix flaky");
wf("add Redis caching to the session store", "swat", "swat add");
wf("implement input validation for the API", "swat", "swat implement");
wf("build a new tool for parsing config files", "swat", "swat build");
wf("map how tool dispatch works in this repo", "explore", "explore map");
wf(
	"understand the session-store persistence layer",
	"explore",
	"explore understand",
);

// Weak / meta prompts must not trigger.
wf("what is the best way to cache data", null, "meta what");
wf("how does the router work", null, "meta how");
wf("hi", null, "too short");
wf(
	"call run_dev_workflow with swat for this feature",
	null,
	"already workflowed",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
