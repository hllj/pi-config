/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Per-agent dispatch timeout in milliseconds. Overridden by a per-call `timeoutMs`. */
	timeoutMs?: number;
	/** Floor for any dispatch timeout, per-call ones included (see timeout.ts). */
	minTimeoutMs?: number;
	/** Extended-thinking level to request for this agent (advisory; only pushed when no explicit model is set). */
	thinking?: string;
	/** Advisory sampling temperature. pi has no CLI flag, so it becomes a prompt-level directive. */
	temperature?: number;
	/** Extra environment variables merged over `process.env` when spawning this agent. */
	env?: Record<string, string>;
	/** If true, instructs the agent not to create/modify/delete files (prompt-level advisory). */
	readonly?: boolean;
	/** Files (relative to the run cwd) whose contents are injected into the agent's system prompt. */
	contextFiles?: string[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	timeoutMs?: unknown;
	minTimeoutMs?: unknown;
	thinking?: unknown;
	temperature?: unknown;
	env?: unknown;
	readonly?: unknown;
	contextFiles?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/**
 * Tolerant optional-number parser. Mirrors `parseToolList`'s fail-soft stance:
 * a single bad value yields `undefined` rather than tainting agent discovery.
� * Accepts numbers and numeric strings (e.g. `timeoutMs: 5000` or `"5000"`).
 */
function parseOptionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (!Number.isNaN(n) && Number.isFinite(n)) return n;
	}
	return undefined;
}

/** Fail-soft optional-string parser. */
function parseOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Parse an optional environment map. Only string-valued entries are kept;
 * anything else is dropped rather than throwing.
 */
function parseEnvRecord(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const out: Record<string, string> = {};
	let any = false;
	for (const [key, val] of Object.entries(value)) {
		if (typeof val === "string") {
			out[key] = val;
			any = true;
		}
	}
	return any ? out : undefined;
}

/**
 * Parse an optional context-file list. Accepts both a comma/space string and a
 * YAML array, matching the `tools` spelling convention.
 */
function parseContextFileList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const files = raw
		.filter((f): f is string => typeof f === "string")
		.map((f) => f.trim())
		.filter(Boolean);
	return files.length > 0 ? files : undefined;
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (
			typeof frontmatter.name !== "string" ||
			typeof frontmatter.description !== "string"
		) {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: parseOptionalString(frontmatter.model),
			timeoutMs: parseOptionalNumber(frontmatter.timeoutMs),
			minTimeoutMs: parseOptionalNumber(frontmatter.minTimeoutMs),
			thinking: parseOptionalString(frontmatter.thinking),
			temperature: parseOptionalNumber(frontmatter.temperature),
			env: parseEnvRecord(frontmatter.env),
			readonly:
				typeof frontmatter.readonly === "boolean"
					? frontmatter.readonly
					: undefined,
			contextFiles: parseContextFileList(frontmatter.contextFiles),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents =
		scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed
			.map((a) => `${a.name} (${a.source}): ${a.description}`)
			.join("; "),
		remaining,
	};
}
