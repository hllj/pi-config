/**
 * Verification Guard — the "firm" half of Definition of done.
 *
 * The operating manual says a task is only done after a verify signal
 * (diagnostics + tests) appears in the transcript. That rule is easy to skip:
 * an agent can edit files and declare done without running anything. This
 * extension makes it a *measured, event-driven* signal instead of a suggestion:
 *
 *   at each `turn_end`, if this turn
 *     - MUTATED files (edit / write ran) BUT
 *     - ran NO verification (run_test / lsp_diagnostics / lens_diagnostics, or
 *       a bash/capture_output command that looks like a check)
 *   → send ONE advisory steer reminding the agent to verify before done.
 *
 * It never blocks and never interrupts mid-turn — it only nudges once at the
 * end of a turn that changed files without checking them. The model owns
 * whether to act (some turns just stage edits for a later verify step).
 *
 * Sibling to the dev-workflows "nudge-state" pattern: a persisted toggle
 * `~/.pi/agent/verify-guard/state.json` (default ON; disable with
 * `/verify-guard`). Subagent children never nudge (they race the parent).
 *
 * Pure classification lives here (exported for unit tests); the extension
 * wiring is at the bottom.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ------------------------------ pure logic ------------------------------ */

export const MUTATION_TOOLS = new Set(["edit", "write"]);
export const VERIFY_TOOLS = new Set([
	"run_test",
	"lsp_diagnostics",
	"lens_diagnostics",
]);

/** Commands that read like a check/build/test pass (a weak verify signal). */
const CHECK_RE =
	/\b(test|tests|testing|typecheck|type-check|lint|check|verify|pytest|vitest|jest|rspec|mocha)\b/i;

/** A single tool invocation observed in a turn. */
export interface TurnTool {
	name: string;
	/** For bash/capture_output — the shell command text (used as a weak check). */
	command?: string;
}

/** Classification of one turn: did it mutate but fail to verify? */
export interface TurnVerdict {
	mutations: number;
	verifications: number;
	/** True when files changed but no verification signal ran this turn. */
	needsVerifyNudge: boolean;
}

/**
 * Classify a turn's tool calls. A `bash`/`capture_output` whose command looks
 * like a check test counts as verification (weak, but enough to avoid nagging
 * someone who did `npm test` through bash). Mutations are edit/write only.
 */
export function classifyTurn(tools: TurnTool[]): TurnVerdict {
	let mutations = 0;
	let verifications = 0;
	for (const t of tools) {
		if (MUTATION_TOOLS.has(t.name)) {
			mutations++;
		} else if (VERIFY_TOOLS.has(t.name)) {
			verifications++;
		} else if (
			(t.name === "bash" || t.name === "capture_output") &&
			t.command &&
			CHECK_RE.test(t.command)
		) {
			verifications++;
		}
	}
	return {
		mutations,
		verifications,
		needsVerifyNudge: mutations > 0 && verifications === 0,
	};
}

/** Advisory steer text. Tailored to what actually happened this turn. */
export function verifyNudgeMessage(v: TurnVerdict): string {
	return (
		`Heads-up (verification guard): this turn changed ${v.mutations} file(s) ` +
		`but I saw no verification run (run_test / lsp_diagnostics / lens_diagnostics / ` +
		`check command). Per the engineering loop, **verify before declaring done**: ` +
		`run the targeted test + diagnostics on the changed files and confirm green. ` +
		`You decide — if you're mid-iteration and intend to verify next turn, ignore this. ` +
		`(Disable with /verify-guard.)`
	);
}

/* --------------------------- extension wiring --------------------------- */

export default function (pi: ExtensionAPI) {
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	const stateFile = () =>
		join(homedir(), ".pi", "agent", "verify-guard", "state.json");

	const readEnabled = (): boolean => {
		try {
			return JSON.parse(readFileSync(stateFile(), "utf8")).enabled === true;
		} catch {
			return false;
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

	// One-time context hint so the model knows steers are advisory, event-driven
	// (mirrors dev-workflows' nudge-state hint).
	let hinted = false;
	pi.on("before_agent_start", () => {
		if (isSubagentChild || !enabled || hinted) return;
		hinted = true;
		return {
			message: {
				customType: "verify-guard-state",
				content:
					"The verification guard is ON. At the end of a turn that changes files without running verification (run_test / lsp_diagnostics / lens_diagnostics / a check command), you'll get one advisory steer to verify before declaring done. It's advisory — for mid-iteration turns you may defer. Disable with /verify-guard.",
				display: true,
			},
		};
	});

	// Accumulate the tools used within the current turn.
	let turnTools: TurnTool[] = [];
	// At most one nudge per turn.
	let nudgedThisTurn = false;

	pi.on("tool_execution_start", (event) => {
		if (isSubagentChild) return;
		const name = event.toolName;
		let command: string | undefined;
		if (name === "bash" || name === "capture_output") {
			const args = event.args;
			if (typeof args === "string") command = args;
			else if (args && typeof args === "object") {
				const c = (args as { command?: unknown }).command;
				if (typeof c === "string") command = c;
			}
		}
		turnTools.push({ name, command });
	});

	pi.on("turn_end", () => {
		if (isSubagentChild) return;
		if (!enabled) {
			turnTools = [];
			nudgedThisTurn = false;
			return;
		}
		const verdict = classifyTurn(turnTools);
		if (verdict.needsVerifyNudge && !nudgedThisTurn) {
			nudgedThisTurn = true;
			pi.sendUserMessage(verifyNudgeMessage(verdict), { deliverAs: "steer" });
		}
		turnTools = [];
		nudgedThisTurn = false;
	});

	pi.registerCommand("verify-guard", {
		description:
			"Toggle the verification guard (persisted): at the end of a turn that changed files but ran no verification (run_test / lsp_diagnostics / lens_diagnostics / check command), the agent gets one advisory steer to verify before declaring done.",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			writeEnabled(enabled);
			// Re-enabling re-arms the one-time hint.
			if (enabled) hinted = false;
			ctx.ui.notify(
				enabled
					? "Verification guard ON: turns that change files without running verification get one advisory verify-steer."
					: "Verification guard OFF.",
				enabled ? "info" : "warning",
			);
		},
	});
}
