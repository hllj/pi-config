// Unit tests for start-of-task-gate.ts pure logic.
// Run directly with Node >= 22 (type-stripping):  node tests/start-of-task-gate.test.ts
import {
	gateMessage,
	newGateState,
	observeTool,
	shouldHoldEdit,
	skillFromToolInput,
	type CatalogSkill,
} from "../start-of-task-gate.ts";

declare const process: { exit(code?: number): never };

let passed = 0;
let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
		console.log(`✓ ${name}`);
	} else {
		failed++;
		console.log(`✗ ${name}\n  expected: ${e}\n  actual:   ${a}`);
	}
};

const catalog: CatalogSkill[] = [
	{ name: "dev-workflows", description: "Preset multi-agent development workflows. Use for a bug fix, feature or refactor.", filePath: "/root/.pi/agent/skills/dev-workflows/SKILL.md" },
	{ name: "subagents", description: "How to delegate work to subagents in Pi well.", filePath: "/root/.pi/agent/skills/subagents/SKILL.md" },
];

/* ---- skill-read detection ---- */
check("read of a SKILL.md names the skill", skillFromToolInput("read", { path: "/root/.pi/agent/skills/subagents/SKILL.md" }), "subagents");
check("bash cat of a SKILL.md names the skill", skillFromToolInput("bash", { command: "cat ~/.pi/agent/skills/dev-workflows/SKILL.md" }), "dev-workflows");
check("ordinary read is not a skill", skillFromToolInput("read", { path: "/testbed/django/db/models/deletion.py" }), null);
check("edit of a SKILL.md is not a skill read", skillFromToolInput("edit", { path: "/x/foo/SKILL.md" }), null);

/* ---- hold decision ---- */
{
	const s = newGateState();
	observeTool(s, "read", { path: "/testbed/a.py" });
	observeTool(s, "bash", { command: "rg foo" });
	check("first edit with no skill/delegation is held", shouldHoldEdit(s, "edit"), true);
	check("write is held the same way", shouldHoldEdit(s, "write"), true);
	check("non-mutating tools are never held", shouldHoldEdit(s, "read"), false);
	s.held = true;
	check("only held once per session", shouldHoldEdit(s, "edit"), false);
}
{
	const s = newGateState();
	observeTool(s, "read", { path: "/root/.pi/agent/skills/dev-workflows/SKILL.md" });
	check("a skill read satisfies the gate", shouldHoldEdit(s, "edit"), false);
}
{
	const s = newGateState();
	observeTool(s, "subagent", { agent: "scout", task: "x" });
	check("a delegation satisfies the gate", shouldHoldEdit(s, "edit"), false);
}
{
	const s = newGateState();
	observeTool(s, "run_dev_workflow", { type: "bugfix", topic: "x" });
	check("run_dev_workflow counts as delegation", s.delegated, true);
}

/* ---- file counting for the delegation triggers ---- */
{
	const s = newGateState();
	observeTool(s, "read", { path: "/testbed/a.py" });
	observeTool(s, "read", { path: "/testbed/a.py" });
	observeTool(s, "read", { path: "/testbed/b.py" });
	observeTool(s, "read", { path: "/root/.pi/agent/skills/subagents/SKILL.md" });
	check("distinct non-skill files read", s.filesRead.size, 2);
	check("tool calls counted", s.toolCalls, 4);
}

/* ---- message ---- */
{
	const s = newGateState();
	for (let i = 0; i < 11; i++) observeTool(s, "read", { path: `/testbed/f${i}.py` });
	const msg = gateMessage(s, catalog, "/testbed/django/db/models/deletion.py");
	check("message names each catalog skill with its path", msg.includes("dev-workflows") && msg.includes("/root/.pi/agent/skills/subagents/SKILL.md"), true);
	check("message says the edit was not applied", /not applied/i.test(msg), true);
	check("message flags the 10+ files trigger when it holds", msg.includes("11 files"), true);
	check("message says it only happens once", /once/i.test(msg), true);
}
{
	const msg = gateMessage(newGateState(), [], "/testbed/x.py");
	check("empty catalog still explains the delegation check", /delegat/i.test(msg) && !msg.includes("undefined"), true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
