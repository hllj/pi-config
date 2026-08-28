/**
 * dev-workflows.ts — preset development workflows as a single tool + command.
 *
 * Thin layer over the subagent extension's engine: it builds `WorkflowStep[]`
 * arrays for a few named pipelines (swat / bugfix / refactor / explore) and
 * runs them via `executeWorkflowSteps`, reusing subagent's existing dispatch,
 * persistence, TUI widget, and resume machinery.
 *
 * - `run_dev_workflow` tool — the LLM calls this once to launch a whole
 *   pipeline (instead of hand-assembling a multi-step chain).
 * - `/dev <type> <topic>` command — for humans; expands to an agent prompt
 *   that invokes the tool, so the workflow streams normally in the transcript.
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
			"Run a preset development workflow (scout → planner → worker with verification/review gates) in one call. Reuses the subagent workflow engine. Pick a type and topic; the appropriate agents run in sequence.",
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
}
