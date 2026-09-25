/**
 * Start-of-task gate — the "firm" half of AGENTS.md "Start of a task".
 *
 * The operating manual asks for a skill scan and a delegation check before
 * the first edit. Models routinely skip both: in SWE-bench runs the agent
 * never read a SKILL.md or considered a subagent, and its reasoning never
 * mentioned either. A rule 200 lines into the system prompt doesn't get read
 * at the moment it matters, so this extension raises it at that moment:
 *
 *   on the FIRST edit/write of a session, if the agent has
 *     - read no SKILL.md, AND
 *     - dispatched nothing (subagent / run_dev_workflow / run_workflow),
 *   → hold that one call (not applied) and return a short checklist naming
 *     the catalog skills (with paths) and the delegation triggers, with the
 *     counts that already hold.
 *
 * It holds at most once per session; every later edit goes through, so it
 * can't deadlock. The model decides what to do with it: reading a matching
 * skill or delegating satisfies it, and so does re-issuing the edit.
 *
 * Default ON (unlike verify-guard): a gate that's off unless a state file
 * exists never fires in fresh environments such as benchmark containers.
 * Disable with /start-gate (persisted in ~/.pi/agent/start-gate/state.json).
 * Subagent children are never gated; the parent owns that decision.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ------------------------------ pure logic ------------------------------ */

export const GATED_TOOLS = new Set(["edit", "write"]);
export const DELEGATION_TOOLS = new Set([
	"subagent",
	"run_dev_workflow",
	"run_workflow",
	"resume_workflow",
]);

/** Delegation trigger from AGENTS.md: reading ~10+ files you won't need again. */
export const FILES_READ_TRIGGER = 10;

export interface CatalogSkill {
	name: string;
	description: string;
	filePath: string;
}

export interface GateState {
	skillsRead: Set<string>;
	delegated: boolean;
	/** Distinct non-skill paths opened with `read`. */
	filesRead: Set<string>;
	toolCalls: number;
	held: boolean;
}

export function newGateState(): GateState {
	return { skillsRead: new Set(), delegated: false, filesRead: new Set(), toolCalls: 0, held: false };
}

const SKILL_PATH_RE = /([A-Za-z0-9._-]+)\/SKILL\.md\b/;

/** Skill name when a tool call reads a SKILL.md (via read, or cat & co. via bash). */
export function skillFromToolInput(toolName: string, input: unknown): string | null {
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	let text: unknown;
	if (toolName === "read") text = args.path;
	else if (toolName === "bash") text = args.command;
	else return null;
	if (typeof text !== "string") return null;
	const m = text.match(SKILL_PATH_RE);
	return m ? m[1] : null;
}

export function observeTool(state: GateState, toolName: string, input: unknown): void {
	state.toolCalls++;
	if (DELEGATION_TOOLS.has(toolName)) state.delegated = true;
	const skill = skillFromToolInput(toolName, input);
	if (skill) {
		state.skillsRead.add(skill);
		return;
	}
	if (toolName === "read") {
		const p = (input as { path?: unknown } | undefined)?.path;
		if (typeof p === "string") state.filesRead.add(p);
	}
}

export function shouldHoldEdit(state: GateState, toolName: string): boolean {
	return GATED_TOOLS.has(toolName) && !state.held && state.skillsRead.size === 0 && !state.delegated;
}

function firstSentence(text: string, max = 160): string {
	const one = text.replace(/\s+/g, " ").trim();
	const cut = one.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? one;
	return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

export function gateMessage(state: GateState, catalog: CatalogSkill[], targetPath?: string): string {
	const lines: string[] = [];
	lines.push(
		`Start-of-task gate: this ${targetPath ? `edit to ${targetPath}` : "edit"} was NOT applied. ` +
			"It's your first code change, and you haven't done the start-of-task steps yet (AGENTS.md → Start of a task). Do them now, then re-issue the edit:",
	);
	lines.push("");
	if (catalog.length > 0) {
		lines.push("1. Skill scan. `read` the SKILL.md of each skill below that matches this task (a bug fix, feature or refactor matches dev-workflows):");
		for (const s of catalog) lines.push(`   - ${s.name}: ${firstSentence(s.description)} (${s.filePath})`);
	} else {
		lines.push("1. Skill scan. No skills are loaded in this session, so there's nothing to read.");
	}
	lines.push("2. Delegation check. Dispatch instead of continuing inline if any of these holds:");
	const n = state.filesRead.size;
	const filesNote = n >= FILES_READ_TRIGGER ? ` (holds now: you've read ${n} files)` : ` (${n} files read so far)`;
	lines.push(`   - you'd read ~${FILES_READ_TRIGGER}+ files you won't need again${filesNote} → subagent scout, or run_dev_workflow type explore`);
	lines.push("   - the change spans more than one source file, or the bug's cause is still unclear → run_dev_workflow (bugfix / swat / refactor)");
	lines.push("   - the work splits into 3+ independent pieces → subagent with a tasks array");
	lines.push("   - you're about to call the change done → subagent reviewer on your diff");
	lines.push("3. Record it with `note` (section workflow): `Skills read: …` and which delegation triggers you checked.");
	lines.push("");
	lines.push("If none of it applies, say why in the note and re-issue the edit. This gate fires once per session; later edits go through.");
	return lines.join("\n");
}

/* --------------------------- extension wiring --------------------------- */

export default function (pi: ExtensionAPI) {
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	const stateFile = () => join(homedir(), ".pi", "agent", "start-gate", "state.json");

	const readEnabled = (): boolean => {
		try {
			return JSON.parse(readFileSync(stateFile(), "utf8")).enabled !== false;
		} catch {
			return true;
		}
	};
	let enabled = readEnabled();
	const writeEnabled = (on: boolean) => {
		try {
			mkdirSync(dirname(stateFile()), { recursive: true });
			writeFileSync(stateFile(), JSON.stringify({ enabled: on }, null, 2), "utf8");
		} catch {
			/* state file unwritable — in-memory toggle for this session */
		}
	};

	let state = newGateState();
	let catalog: CatalogSkill[] = [];

	pi.on("session_start", () => {
		state = newGateState();
	});

	// The loaded skill catalog, as pi built it into the system prompt.
	pi.on("before_agent_start", (event) => {
		catalog = (event.systemPromptOptions?.skills ?? [])
			.filter((s) => !s.disableModelInvocation)
			.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }));
	});

	pi.on("tool_call", (event) => {
		if (isSubagentChild || !enabled) return;
		if (shouldHoldEdit(state, event.toolName)) {
			state.held = true;
			const p = (event.input as { path?: unknown }).path;
			return { block: true, reason: gateMessage(state, catalog, typeof p === "string" ? p : undefined) };
		}
		observeTool(state, event.toolName, event.input);
	});

	pi.registerCommand("start-gate", {
		description:
			"Toggle the start-of-task gate (persisted, default ON): the first edit/write of a session is held once, with a skill-scan + delegation checklist, unless a SKILL.md was read or work was delegated first.",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			writeEnabled(enabled);
			ctx.ui.notify(
				enabled ? "Start-of-task gate ON." : "Start-of-task gate OFF.",
				enabled ? "info" : "warning",
			);
		},
	});
}
