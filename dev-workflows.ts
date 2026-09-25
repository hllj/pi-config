/**
 * dev-workflows.ts — preset development workflows as a single tool + command.
 *
 * Thin layer over the subagent extension's engine: it builds `WorkflowStep[]`
 * arrays for a few named pipelines (swat / bugfix / refactor / explore) and
 * runs them via `executeWorkflowSteps`, reusing subagent's existing dispatch,
 * persistence, TUI widget, and resume machinery.
 *
 * - `run_dev_workflow` tool — the LLM calls this once to launch a whole
 *   pipeline (instead of hand-assembling a multi-step chain). It owns the
 *   type/topic decision: the tool guidance teaches the model how to pick
 *   `type` from task shape and `topic` as an imperative phrase.
 * - `/dev <type> <topic>` command — for humans; expands to an agent prompt
 *   that invokes the tool, so the workflow streams normally in the transcript.
 * - `/dev-auto` — persisted toggle for EVENT-DRIVEN workflow nudges (no
 *   keyword detection): a failing `run_dev_workflow` earns a recovery nudge,
 *   and a tool error that matches a known recurring failure in the
 *   failure-learning store earns a data-driven nudge to consider
 *   `run_dev_workflow`. The model always decides type/topic itself.
 *
 * Examples:
 *   /dev swat add Redis caching to the session store
 *   /dev bugfix the auth token refresh race condition
 *   /dev refactor split the workflow engine into smaller modules
 *   /dev explore how tool dispatch works
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { repeatWorkflowHint } from "./learning/index.ts";
import {
	discoverAgents,
	type AgentConfig,
	type AgentScope,
} from "./subagent/agents.ts";
import {
	createWorkflowState,
	type WorkflowStep,
	type WorkflowState,
} from "./subagent/workflow-engine.ts";
import {
	buildSessionLink,
	executeWorkflowSteps,
	type DispatchDefaults,
	type WorkflowRunContext,
} from "./subagent/index.ts";
import {
	renderWorkflowCollapsed,
	renderWorkflowExpanded,
} from "./subagent/workflow-renderer.ts";

// ---------------------------------------------------------------------------
// Workflow templates
// ---------------------------------------------------------------------------

/** Fill the `{topic}` placeholder (and keep `{previous}` intact for chaining). */
function t(template: string, topic: string): string {
	return template.replaceAll("{topic}", topic);
}

export type DevWorkflowType = "swat" | "bugfix" | "refactor" | "explore";

interface WorkflowTemplate {
	label: string;
	description: string;
	/** Build the step array for a given topic. */
	build(topic: string): WorkflowStep[];
}

const WORKFLOWS: Record<DevWorkflowType, WorkflowTemplate> = {
	swat: {
		label: "SWAT",
		description:
			"Full feature pipeline: scout → planner → worker (TDD) → verify → reviewer → worker fixes",
		build: (topic) => [
			{
				agent: "scout",
				task: t(
					"Find all code relevant to: {topic}. Report files, key symbols, and the surrounding architecture so a plan can be made.",
					topic,
				),
			},
			{
				agent: "planner",
				task: t(
					'Create an implementation plan for "{topic}" using the context from the previous step ({previous}). Emit a JSON object with fields: {plan, files, risks}.',
					topic,
				),
				expect: {
					type: "json",
					description: "Plan object with plan, files, risks",
					jsonSchema: {
						type: "object",
						properties: {
							plan: { type: "string" },
							files: { type: "array", items: { type: "string" } },
							risks: { type: "array", items: { type: "string" } },
						},
						required: ["plan", "files", "risks"],
					},
				},
			},
			{
				agent: "worker",
				task: t(
					"Implement the plan from the previous step ({previous}) for {topic} test-first (TDD): RED → GREEN → VERIFY → REFACTOR. Run the relevant test suite and LSP diagnostics. Report tests that pass.",
					topic,
				),
			},
			{
				agent: "general",
				task: t(
					"Verify the implementation from the previous step ({previous}) for {topic}. Run the full test suite and `lsp_diagnostics` / `lens_diagnostics` on every changed file. Report pass/fail evidence.",
					topic,
				),
			},
			{
				agent: "reviewer",
				task: t(
					"Review the implementation and verification from the previous step ({previous}) for {topic}. Check correctness, security, and error handling. List concrete issues.",
					topic,
				),
			},
			{
				agent: "worker",
				task: t(
					"Address the reviewer's issues from the previous step ({previous}) for {topic}. Fix what is valid, test-first, and re-run the suite. Confirm all issues resolved.",
					topic,
				),
			},
		],
	},
	bugfix: {
		label: "Bugfix",
		description:
			"Debug a bug: scout traces it → worker writes failing test (RED) → worker fixes (GREEN) → reviewer",
		build: (topic) => [
			{
				agent: "scout",
				task: t(
					"Trace the bug for: {topic}. Find the exact code paths, likely root cause, and any existing tests. Report findings.",
					topic,
				),
			},
			{
				agent: "worker",
				task: t(
					"Write a failing test that reproduces the bug for {topic} using the context from the previous step ({previous}). Confirm it fails (RED) for the right reason.",
					topic,
				),
			},
			{
				agent: "worker",
				task: t(
					"Fix the bug for {topic} (root-caused in the previous step: {previous}). Make the failing test pass (GREEN) and run the full suite.",
					topic,
				),
			},
			{
				agent: "reviewer",
				task: t(
					"Review the bugfix from the previous step ({previous}) for {topic}. Confirm the root cause was addressed, the test is meaningful, and no regressions were introduced.",
					topic,
				),
			},
		],
	},
	refactor: {
		label: "Refactor",
		description:
			"Deep refactor: planner designs with blast radius → worker (TDD) → reviewer → lens full scan",
		build: (topic) => [
			{
				agent: "planner",
				task: t(
					'Design a refactor for "{topic}". Use `module_report` to assess the blast radius (transitive dependents). Emit a JSON object with fields: {plan, files, risks}.',
					topic,
				),
				expect: {
					type: "json",
					description: "Refactor plan object with plan, files, risks",
					jsonSchema: {
						type: "object",
						properties: {
							plan: { type: "string" },
							files: { type: "array", items: { type: "string" } },
							risks: { type: "array", items: { type: "string" } },
						},
						required: ["plan", "files", "risks"],
					},
				},
			},
			{
				agent: "worker",
				task: t(
					"Execute the refactor from the previous step ({previous}) for {topic}. Run the existing suite before and after; keep the diff green. Test-first where behavior changes.",
					topic,
				),
			},
			{
				agent: "reviewer",
				task: t(
					"Review the refactor from the previous step ({previous}) for {topic}. Check it matches the plan, preserves behavior, and leaves no dead code or broken references.",
					topic,
				),
			},
			{
				agent: "general",
				task: t(
					"Run a full diagnostics sweep on the refactored code for {topic} ({previous}). Use `lens_diagnostics` mode=full refreshRunners=all to surface dead code, circular imports, copy-paste, and security findings. Report results.",
					topic,
				),
			},
		],
	},
	explore: {
		label: "Explore",
		description:
			"Parallel recon of a codebase, then a planner synthesizes an architecture summary",
		build: (topic) => [
			{
				agent: "scout",
				task: t(
					"Map part of the codebase related to: {topic}. Identify the core modules, data flow, and key abstractions. Report a structured outline.",
					topic,
				),
				parallelGroup: "recon",
			},
			{
				agent: "scout",
				task: t(
					"Inspect entry points, configuration, and external integrations related to: {topic}. Report how data and control flow into the system.",
					topic,
				),
				parallelGroup: "recon",
			},
			{
				agent: "scout",
				task: t(
					"Find tests, schemas, and error-handling patterns related to: {topic}. Report conventions the team follows.",
					topic,
				),
				parallelGroup: "recon",
			},
			{
				agent: "planner",
				task: t(
					"Synthesize the parallel recon results from the previous steps ({previous}) into a clear architecture summary for {topic}: components, data flow, conventions, and risks.",
					topic,
				),
			},
		],
	},
};

export const DevWorkflowTemplates: Record<DevWorkflowType, WorkflowTemplate> =
	WORKFLOWS;

/**
 * `run_dev_workflow` tool guidance: how the model should pick `type` + `topic`
 * from its current task. Shared by the tool's `promptGuidelines` so the choice
 * is model-owned (no keyword/regex detection anywhere).
 */
const TYPE_GUIDANCE = [
	"Use this for a task that matches a whole pipeline — one call instead of hand-assembling a chain of subagent steps.",
	"Pick type by task shape (you decide, not a keyword rule): swat = ship new behavior (scout → planner → worker TDD → verify → reviewer → worker); bugfix = a bug/failure to reproduce+fix (scout → failing test → fix → review); refactor = restructure working code (planner blast-radius → worker → reviewer → lens full scan); explore = map/understand an unfamiliar area (parallel recon → synthesis).",
	'Pick topic as the imperative task description the pipeline runs on — e.g. "add Redis caching to the session store" (swat) or "the auth token refresh race" (bugfix).',
	"If a subagent result, a failing test, or your own iteration suggests a whole pipeline would serve better than inline work, prefer run_dev_workflow.",
] as const;

// ---------------------------------------------------------------------------
// Shared executor (reuses subagent's engine)
// ---------------------------------------------------------------------------

/** Structural subset of ExtensionContext that both tool and command handlers expose. */
interface WorkflowHost {
	cwd: string;
	hasUI: boolean;
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
		setWidget(id: string, lines?: string[]): void;
		setStatus(id: string, text?: string): void;
	};
	sessionManager: ExtensionContext["sessionManager"];
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}

function buildExec(
	pi: ExtensionAPI,
	host: WorkflowHost,
	agentScope: AgentScope,
	signal: AbortSignal | undefined,
	onUpdate: WorkflowRunContext["onUpdate"],
): {
	exec: WorkflowRunContext;
	agents: AgentConfig[];
	projectAgentsDir: string | null;
} {
	const dispatchDefaults: DispatchDefaults = {
		model: host.model ? `${host.model.provider}/${host.model.id}` : undefined,
		thinkingLevel: host.thinkingLevel,
	};
	const discovery = discoverAgents(host.cwd, agentScope);
	const exec: WorkflowRunContext = {
		pi,
		ctx: {
			cwd: host.cwd,
			hasUI: host.hasUI,
			ui: { confirm: (title, message) => host.ui.confirm(title, message) },
		},
		dispatchDefaults,
		agents: discovery.agents,
		signal,
		session: buildSessionLink(host.sessionManager),
		ui: {
			setWidget: (id, lines) => {
				try {
					host.ui.setWidget(id, lines);
				} catch {
					/* ignore */
				}
			},
			setStatus: (id, text) => {
				try {
					host.ui.setStatus(id, text);
				} catch {
					/* ignore */
				}
			},
		},
		onUpdate,
	};
	return {
		exec,
		agents: discovery.agents,
		projectAgentsDir: discovery.projectAgentsDir,
	};
}

interface DevRunResult {
	state: WorkflowState;
	failed: boolean;
	failureText?: string;
	canceled?: boolean;
}

async function runDevWorkflow(
	pi: ExtensionAPI,
	host: WorkflowHost,
	type: DevWorkflowType,
	topic: string,
	opts: {
		agentScope?: AgentScope;
		confirmProjectAgents?: boolean;
		signal?: AbortSignal;
		onUpdate?: WorkflowRunContext["onUpdate"];
	} = {},
): Promise<DevRunResult> {
	const template = WORKFLOWS[type];
	const agentScope: AgentScope = opts.agentScope ?? "user";
	const steps = template.build(topic);

	const { exec, agents, projectAgentsDir } = buildExec(
		pi,
		host,
		agentScope,
		opts.signal,
		opts.onUpdate,
	);

	// Project-agent approval gate mirrors run_workflow.
	if (
		(agentScope === "project" || agentScope === "both") &&
		(opts.confirmProjectAgents ?? true) &&
		host.hasUI
	) {
		const requested = new Set<string>(steps.map((s) => s.agent));
		const projectAgents = Array.from(requested)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a): a is AgentConfig => a?.source === "project");
		if (projectAgents.length > 0) {
			const ok = await host.ui.confirm(
				"Run project-local agents?",
				`Agents: ${projectAgents.map((a) => a.name).join(", ")}\nSource: ${projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok)
				return {
					state: createWorkflowState(steps, `${type}: ${topic}`),
					failed: false,
					canceled: true,
				};
		}
	}

	const state = createWorkflowState(steps, `${type}: ${topic}`);
	const result = await executeWorkflowSteps(
		state,
		0,
		{ output: "", exitCode: 0 },
		exec,
	);
	return result;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_dev_workflow",
		label: "Run Dev Workflow",
		description:
			"Run a preset development workflow (scout → planner → worker with verification/review gates) in one call. Use it for a bug whose cause is still unclear after about six tool calls (bugfix), a change that spans more than one source file (swat / refactor), or mapping an unfamiliar area before editing (explore). Reuses the subagent workflow engine. Pick a type and topic; the appropriate agents run in sequence.",
		promptSnippet:
			"run_dev_workflow: one-call multi-agent pipeline for a bug still unclear after ~6 calls (bugfix), a multi-file change (swat/refactor), or unfamiliar code (explore)",
		promptGuidelines: [...TYPE_GUIDANCE],
		parameters: Type.Object({
			type: StringEnum(["swat", "bugfix", "refactor", "explore"] as const, {
				description:
					"Which dev workflow to run: swat (full feature), bugfix (debug), refactor (deep refactor with full diagnostics), explore (parallel recon + synthesis)",
			}),
			topic: Type.String({
				description:
					"What to work on, e.g. 'add Redis caching to the session store'",
			}),
			agentScope: Type.Optional(
				StringEnum(["user", "project", "both"] as const, {
					description: 'Which agent directories to use. Default "user".',
					default: "user",
				}),
			),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({
					description: "Prompt before running project-local agents. Default true.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const host: WorkflowHost = {
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				sessionManager: ctx.sessionManager,
				model: ctx.model,
				thinkingLevel: ctx.thinkingLevel,
			};
			const makeDetails = (s: WorkflowState): { workflow: WorkflowState } => ({
				workflow: s,
			});

			const results: DevRunResult = await runDevWorkflow(
				pi,
				host,
				params.type,
				params.topic,
				{
					agentScope: params.agentScope,
					confirmProjectAgents: params.confirmProjectAgents,
					signal,
					onUpdate: (s: WorkflowState) => {
						if (!onUpdate) return;
						const completed = s.results.filter(
							(r) => r.status === "completed",
						).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `${params.type}: ${completed}/${s.steps.length} steps completed`,
								},
							],
							details: makeDetails(s),
						});
					},
				},
			);

			if (results.canceled) {
				return {
					content: [
						{ type: "text", text: "Canceled: project-local agents not approved." },
					],
					details: makeDetails(results.state),
				};
			}
			if (results.failed) {
				return {
					content: [
						{ type: "text", text: results.failureText ?? "Workflow failed" },
					],
					details: makeDetails(results.state),
					isError: true,
				};
			}

			const completed = results.state.results.filter(
				(r) => r.status === "completed",
			).length;
			let summary = `${params.type} workflow completed: ${completed}/${results.state.steps.length} steps succeeded`;
			const lastOutput = results.state.results
				.filter((r) => r.status === "completed")
				.pop();
			if (lastOutput?.output)
				summary += `\n\n─── Final Output ───\n${lastOutput.output}`;
			return {
				content: [{ type: "text", text: summary }],
				details: makeDetails(results.state),
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("run_dev_workflow ")) +
					theme.fg("accent", args.type) +
					theme.fg("muted", ` "${args.topic}"`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as { workflow?: WorkflowState } | undefined;
			if (details?.workflow) {
				return expanded
					? renderWorkflowExpanded(details.workflow, theme)
					: renderWorkflowCollapsed(details.workflow, theme);
			}
			const text = result.content[0];
			return new Text(
				text?.type === "text" ? text.text : "Dev workflow result",
				0,
				0,
			);
		},
	});

	// /dev <type> <topic> — human-facing wrapper. Sends an agent prompt that
	// invokes run_dev_workflow, so it streams normally in the transcript.
	pi.registerCommand("dev", {
		description:
			"Run a dev workflow. Usage: /dev swat|bugfix|refactor|explore <topic>.\n" +
			"Examples:\n" +
			"  /dev swat add Redis caching to the session store\n" +
			"  /dev bugfix the auth token refresh race condition\n" +
			"  /dev refactor split the workflow engine into smaller modules\n" +
			"  /dev explore how tool dispatch works\n" +
			"(no type = swat)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim();
			const [first, ...rest] = trimmed.split(/\s+/);
			const knownTypes = Object.keys(WORKFLOWS) as DevWorkflowType[];

			// First token missing/incomplete → suggest workflow types.
			if (rest.length === 0 || !knownTypes.includes(first as DevWorkflowType)) {
				const types: AutocompleteItem[] = knownTypes
					.filter((k) => k.startsWith(first))
					.map((key) => ({
						value: key,
						label: key,
						description: WORKFLOWS[key].description,
					}));
				// When a full type is already typed, suggest a starter topic.
				if (knownTypes.includes(first as DevWorkflowType) && rest.length === 0) {
					types.push({
						value: `${first} `,
						label: `${first} <topic>`,
						description: "Add a topic to run the workflow on",
					});
				}
				return types;
			}

			// Type already chosen → suggest example topics for it.
			const examples: Record<DevWorkflowType, string[]> = {
				swat: [
					"add Redis caching to the session store",
					"build a new tool for parsing config files",
				],
				bugfix: [
					"the auth token refresh race condition",
					"flaky test in the workflow engine",
				],
				refactor: [
					"split the workflow engine into smaller modules",
					"replace the ad-hoc config parser",
				],
				explore: ["how tool dispatch works", "the session-store persistence layer"],
			};
			return (examples[first as DevWorkflowType] ?? []).map((topic) => ({
				value: `${first} ${topic}`,
				label: `${first} ${topic}`,
			}));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [maybeType, ...rest] = trimmed.split(/\s+/);
			const type: DevWorkflowType = (
				Object.keys(WORKFLOWS) as DevWorkflowType[]
			).includes(maybeType as DevWorkflowType)
				? (maybeType as DevWorkflowType)
				: "swat";
			const topic = (
				type === (maybeType as DevWorkflowType) ? rest.join(" ") : trimmed
			).trim();
			if (!topic) {
				ctx.ui.notify(
					"Usage: /dev swat|bugfix|refactor|explore <topic>\nDefaults to swat when no type is given.",
					"info",
				);
				return;
			}
			pi.sendUserMessage(
				`Run the run_dev_workflow tool with type=${type} and topic="${topic}".`,
				{ expandPromptTemplates: true },
			);
		},
	});

	// ---------------------------------- C: event-driven nudges ----------------
	// No keyword detection. Two measured signals:
	//   1. a `run_dev_workflow` run fails → recovery nudge (get_workflow/resume).
	//   2. a tool error whose fingerprint already recurs in the failure-learning
	//      store (>= threshold sessions, non-terminal) → data-driven nudge to
	//      consider run_dev_workflow.
	// In both cases the MODEL owns type/topic; the nudge only surfaces the option.
	// Persisted toggle: /dev-auto. Subagent children never nudge (they race the
	// parent and would duplicate every message).
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	const nudgeStateFile = () =>
		join(homedir(), ".pi", "agent", "dev-workflows", "nudge-state.json");
	const readNudgeEnabled = (): boolean => {
		try {
			return JSON.parse(readFileSync(nudgeStateFile(), "utf8")).enabled === true;
		} catch {
			return false;
		}
	};
	let devNudgeEnabled = readNudgeEnabled();
	// One-time context hint: on the first agent turn of a session with nudges
	// enabled, inject a custom message explaining the persisted state so the
	// model knows steers are event-driven and advisory (model owns type/topic).
	let nudgeStateHinted = false;
	const writeNudgeEnabled = (enabled: boolean) => {
		try {
			mkdirSync(dirname(nudgeStateFile()), { recursive: true });
			writeFileSync(
				nudgeStateFile(),
				JSON.stringify({ enabled }, null, 2),
				"utf8",
			);
		} catch {
			/* state file unwritable — keep in-memory toggle for this session */
		}
	};

	pi.registerCommand("dev-auto", {
		description:
			"Toggle event-driven workflow nudges (persisted): when a dev workflow run fails or a tool error matches a known recurring failure in the failure-learning store, the agent is steered to consider run_dev_workflow. Type/topic are chosen by the model, not a keyword heuristic.",
		handler: async (_args, ctx) => {
			devNudgeEnabled = !devNudgeEnabled;
			writeNudgeEnabled(devNudgeEnabled);
			// Re-enabling re-arms the one-time context hint so the model is told
			// about the persisted state again.
			if (devNudgeEnabled) nudgeStateHinted = false;
			ctx.ui.notify(
				devNudgeEnabled
					? "Auto dev-workflow nudges enabled: recurring failures / failed workflow runs will steer to run_dev_workflow."
					: "Auto dev-workflow nudges disabled.",
				devNudgeEnabled ? "info" : "warning",
			);
		},
	});

	// Injected once per session (first agent turn while nudges are enabled): a
	// custom message that explains the persisted /dev-auto state to the model
	// before any nudge arrives, so steers read as advisory, event-driven hints.
	// Custom messages render in the transcript when a renderer is registered;
	// without one they still appear as plain entries carrying the details.
	pi.on("before_agent_start", () => {
		if (isSubagentChild || !devNudgeEnabled || nudgeStateHinted) return;
		nudgeStateHinted = true;
		return {
			message: {
				customType: "dev-workflow-nudge-state",
				content:
					"Auto dev-workflow nudges are ON (persisted in ~/.pi/agent/dev-workflows/nudge-state.json). " +
					"You may see steer messages suggesting run_dev_workflow when a dev workflow run fails or " +
					"a tool error matches a repeat candidate in the failure-learning store. " +
					"They are advisory — you own the type/topic decision: pick the workflow type that fits, " +
					"or ignore it if a pipeline doesn't help. Disable with /dev-auto.",
				display: true,
				details: { stateFile: nudgeStateFile() },
			},
		};
	});

	// Dedupe: at most one nudge per turn; per fingerprint max once per session.
	const nudgedFingerprints = new Set<string>();
	let nudgedThisTurn = false;
	pi.on("turn_end", () => {
		nudgedThisTurn = false;
	});

	pi.on("tool_execution_end", (event) => {
		if (isSubagentChild || !devNudgeEnabled || !event.isError) return;

		// Signal 1: the workflow run itself failed → recovery nudge.
		if (event.toolName === "run_dev_workflow") {
			if (nudgedThisTurn) return;
			nudgedThisTurn = true;
			pi.sendUserMessage(
				"Your dev workflow run just failed. Inspect which step failed with `get_workflow`, resume from it with `resume_workflow`, or relaunch with a more focused topic.",
				{ deliverAs: "steer" },
			);
			return;
		}

		// Signal 2: a tool error matching a known recurring failure pattern
		// (fingerprint exists in the failure-learning store as a repeat).
		// subagent/run_workflow broker calls SUCCEED even when children fail —
		// those are ingested from the run store by the learning extension, so
		// skip them here to avoid double-signaling.
		if (event.toolName === "subagent" || event.toolName === "run_workflow")
			return;

		const message =
			typeof event.result === "string"
				? event.result
				: typeof event.result === "object" && event.result !== null
					? JSON.stringify(event.result)
					: String(event.result ?? "tool failed");
		const hint = repeatWorkflowHint("tool", event.toolName, message);
		if (!hint.repeats || hint.workflow === null) return;
		if (nudgedFingerprints.has(marker(event.toolName, message))) return;
		if (nudgedThisTurn) return;

		nudgedFingerprints.add(marker(event.toolName, message));
		nudgedThisTurn = true;
		pi.sendUserMessage(
			`Heads-up: "${event.toolName}" just failed with an error you've hit before ` +
				`(a repeat candidate in the failure-learning store). This is often a sign the task is ` +
				`bigger than inline iteration — consider running it as a \`${hint.workflow}\` dev workflow: ` +
				`call run_dev_workflow with type="${hint.workflow}" and topic describing the current task. ` +
				`You decide whether it fits; disable these nudges with /dev-auto.`,
			{ deliverAs: "steer" },
		);
	});

	function marker(toolName: string, message: string): string {
		return `${toolName}:${message}`;
	}
}
