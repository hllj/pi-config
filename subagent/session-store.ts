/**
 * Subagent run session store
 *
 * Durable, queryable on-disk record of every subagent dispatch:
 *
 *   <storeDir>/subagents/<runId>/
 *     <timestamp>_<sessionId>.jsonl   — the child's own pi session file (--session-dir points here;
 *                                       the code discovers any *.jsonl — reader picks the latest)
 *     record.json     — SubagentRunRecord, rewritten atomically (tmp + rename)
 *
 * Store dir resolution order:
 *   1. PI_SUBAGENT_SESSION_DIR env override
 *   2. <dirname(dirname(sessionDir))>/subagents   (sessionDir from ctx.sessionManager)
 *   3. ~/.pi/agent/subagents                      (fallback for in-memory sessions)
 *
 * Pure module — no ExtensionAPI / pi runtime dependency. The parent broker
 * (index.ts) supplies ctx.sessionManager data (session id/file, store dir) and
 * hooks the "subagent-session" parent pointer via pi.appendEntry. Transcript
 * reads go through the SessionManager SDK class (open()), falling back to a
 * line-by-line JSONL parse if opening fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type RunStatus =
	| "running"
	| "completed"
	| "failed"
	| "timed_out"
	| "aborted"
	| "orphaned";

export interface SubagentRunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentRunRecord {
	/** Reuses generateRunningAgentId() from index.ts. */
	runId: string;
	agent: string;
	agentSource: string;
	/** Full task text (truncate only at display). */
	task: string;
	model: string;
	mode: "single" | "parallel" | "chain" | "workflow";
	workflowId?: string;
	step?: number;
	/** Parent (broker) session id — ctx.sessionManager.getSessionId(). */
	parentSessionId: string;
	/** Parent session file path — ctx.sessionManager.getSessionFile(). */
	parentSessionFile: string;
	/** Path to the child's own pi session JSONL (discovered lazily). */
	sessionFile?: string;
	pid?: number;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	exitCode?: number;
	/** errorMessage / stderr (truncated). */
	error?: string;
	usage: SubagentRunUsage;
	/** getFinalOutput(messages) capped ~2000 chars. */
	outputSummary?: string;
}

export interface ListRunsOptions {
	agent?: string;
	mode?: SubagentRunRecord["mode"];
	status?: RunStatus;
	workflowId?: string;
	limit?: number;
	/** Only runs started at or after this timestamp. */
	since?: number;
}

/** Window used by reconcileOrphans when no pid is available (mirrors RUNNING_AGENT_PRUNE_MS). */
const ORPHAN_WINDOW_MS = 10 * 60 * 1000;
/**
 * Hard staleness safety net: any `running` record older than this is orphaned /
 * treated as dead regardless of pid-liveness, so PID-reuse/EPERM can never leave
 * a record `running` forever and exempt it from pruning.
 */
const HARD_ORPHAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_RUNS = 500;

/* ------------------------------------------------------------------ */
/* Store dir resolution                                                */
/* ------------------------------------------------------------------ */

function envStoreDirOverride(): string | undefined {
	const value = process.env.PI_SUBAGENT_SESSION_DIR;
	return value && value.trim() ? value : undefined;
}

/**
 * Resolve the run store directory.
 *
 * `sessionDir` is the broker's own session directory
 * (ctx.sessionManager.getSessionDir()). Typical layout:
 * <root>/sessions/<encoded-cwd>/ → store is <root>/subagents.
 */
export function resolveStoreDir(sessionDir?: string): string {
	const env = envStoreDirOverride();
	if (env) return env;
	if (sessionDir && sessionDir.trim()) {
		return path.join(path.dirname(path.dirname(sessionDir)), "subagents");
	}
	return path.join(os.homedir(), ".pi", "agent", "subagents");
}

/* ------------------------------------------------------------------ */
/* Record read/write                                                   */
/* ------------------------------------------------------------------ */

function recordFile(storeDir: string, runId: string): string {
	return path.join(storeDir, runId, "record.json");
}

/** Atomic tmp+rename rewrite: readers see old or new full record, never torn. */
function atomicWrite(file: string, record: SubagentRunRecord): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
	fs.renameSync(tmp, file);
}

function writeRecord(record: SubagentRunRecord, storeDir: string): void {
	const dir = path.join(storeDir, record.runId);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
	atomicWrite(recordFile(storeDir, record.runId), record);
}

/** Read one record.json; skip missing/corrupt records silently. */
const _num = (v: unknown): number =>
	(typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Fill in missing/non-numeric record fields so consumers never hit undefined. */
function normalizeRecord(rec: SubagentRunRecord): SubagentRunRecord {
	const u = (rec.usage ?? {}) as Partial<SubagentRunUsage>;
	rec.usage = {
		input: _num(u.input),
		output: _num(u.output),
		cacheRead: _num(u.cacheRead),
		cacheWrite: _num(u.cacheWrite),
		cost: _num(u.cost),
		contextTokens: _num(u.contextTokens),
		turns: _num(u.turns),
	};
	rec.startedAt = _num(rec.startedAt);
	rec.endedAt = rec.endedAt === undefined ? undefined : _num(rec.endedAt);
	rec.durationMs = rec.durationMs === undefined ? undefined : _num(rec.durationMs);
	rec.exitCode = rec.exitCode === undefined ? undefined : _num(rec.exitCode);
	return rec;
}

function readRecord(file: string): SubagentRunRecord | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (data && typeof data.runId === "string") return normalizeRecord(data);
	} catch {
		/* corrupt / mid-write — skip */
	}
	return undefined;
}

export function recordStart(
	record: SubagentRunRecord,
	storeDir: string = resolveStoreDir(),
): void {
	writeRecord(record, storeDir);
}

export function recordUpdate(
	record: SubagentRunRecord,
	storeDir: string = resolveStoreDir(),
): void {
	writeRecord(record, storeDir);
}

export function recordEnd(
	record: SubagentRunRecord,
	storeDir: string = resolveStoreDir(),
): void {
	writeRecord(record, storeDir);
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/**
 * List runs, newest first. Filters: agent / mode / status / workflowId /
 * since (startedAt >= since). Missing or corrupt records are skipped.
 */
export function listRuns(
	opts: ListRunsOptions = {},
	storeDir: string = resolveStoreDir(),
): SubagentRunRecord[] {
	if (!fs.existsSync(storeDir)) return [];
	const out: SubagentRunRecord[] = [];
	for (const name of fs.readdirSync(storeDir)) {
		const dir = path.join(storeDir, name);
		let st: fs.Stats;
		try {
			st = fs.statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const rec = readRecord(recordFile(storeDir, name));
		if (!rec) continue;
		if (opts.agent && rec.agent !== opts.agent) continue;
		if (opts.mode && rec.mode !== opts.mode) continue;
		if (opts.status && rec.status !== opts.status) continue;
		if (opts.workflowId && rec.workflowId !== opts.workflowId) continue;
		if (opts.since !== undefined && (rec.startedAt ?? 0) < opts.since) continue;
		out.push(rec);
	}
	out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	if (opts.limit !== undefined && opts.limit > 0)
		out.length = Math.min(out.length, opts.limit);
	return out;
}

export function getRun(
	runId: string,
	storeDir: string = resolveStoreDir(),
): SubagentRunRecord | undefined {
	return readRecord(recordFile(storeDir, runId));
}

/**
 * Format a raw duration in ms (or '—' when unknown). Shared by index.ts and
 * runs-screen.ts (single consolidated helper for the run store's surfaces).
 */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m${s}s`;
}

export interface RunTranscript {
	messages: Message[];
	header: { type: "session"; id: string; timestamp: string; cwd: string } | null;
}

/** Best-effort line-by-line JSONL parse of a pi session file (fallback). */
function parseTranscriptJsonl(sessionFile: string): RunTranscript | undefined {
	let text: string;
	try {
		text = fs.readFileSync(sessionFile, "utf-8");
	} catch {
		return undefined;
	}
	const messages: Message[] = [];
	let header: RunTranscript["header"] = null;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "message" && entry.message) {
			messages.push(entry.message as Message);
		} else if (entry.type === "session") {
			header = entry as RunTranscript["header"];
		}
	}
	return { messages, header };
}

/**
 * Read the transcript (messages + header) of a run's own session file.
 * Uses SessionManager.open() from the coding-agent SDK; falls back to a
 * line-by-line JSONL parse when the file cannot be opened as a session.
 */
export function readRunTranscript(
	runId: string,
	storeDir: string = resolveStoreDir(),
): RunTranscript | undefined {
	const dir = path.join(storeDir, runId);
	let candidates: string[];
	try {
		candidates = fs
			.readdirSync(dir)
			.filter((f: string) => f.endsWith(".jsonl") && !f.endsWith(".tmp"));
	} catch {
		return undefined;
	}
	if (candidates.length === 0) return undefined;
	const sessionFile = path.join(dir, [...candidates].sort().pop()!);
	try {
		const sm = SessionManager.open(sessionFile);
		const messages: Message[] = [];
		for (const entry of sm.getEntries()) {
			if (entry.type === "message") {
				// SAFETY: SessionMessageEntry.message is typed AgentMessage (<-> pi-ai Message
				// structural twin with identical role/content/usage fields); on-disk payloads
				// are produced by pi itself, so the widen-via-unknown is representation-safe.
				messages.push(entry.message as unknown as Message);
			}
		}
		const h = sm.getHeader();
		return {
			messages,
			header: h
				? { type: "session", id: h.id, timestamp: h.timestamp, cwd: h.cwd }
				: null,
		};
	} catch {
		return parseTranscriptJsonl(sessionFile);
	}
}

/* ------------------------------------------------------------------ */
/* Orphan reconciliation & pruning                                     */
/* ------------------------------------------------------------------ */

function isProcessDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as { code?: string }).code === "ESRCH";
	}
}

/**
 * For every record still marked "running": if its pid is provably dead
 * (process.kill(pid, 0) → ESRCH) it is flipped to "orphaned". Records without
 * a pid fall back to a >10 min startedAt staleness signal (bounds
 * PID-reuse misclassification). Returns the newly orphaned records.
 */
export function reconcileOrphans(
	storeDir: string = resolveStoreDir(),
): SubagentRunRecord[] {
	if (!fs.existsSync(storeDir)) return [];
	const orphaned: SubagentRunRecord[] = [];
	for (const name of fs.readdirSync(storeDir)) {
		const dir = path.join(storeDir, name);
		let st: fs.Stats;
		try {
			st = fs.statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const rec = readRecord(recordFile(storeDir, name));
		if (!rec || rec.status !== "running") continue;
		const startedAt = rec.startedAt ?? Date.now();
		let hasPid = false;
		let pidAlive = false;
		if (typeof rec.pid === "number" && rec.pid > 0) {
			hasPid = true;
			pidAlive = !isProcessDead(rec.pid);
		}
		const now = Date.now();
		// Hard staleness safety net: regardless of pid-liveness, any `running` record
		// that started more than 24h ago is orphaned too — PID-reuse/EPERM can never
		// leave a record `running` forever.
		const hardStale = now - startedAt > HARD_ORPHAN_WINDOW_MS;
		const staleNoPid = now - startedAt > ORPHAN_WINDOW_MS;
		if (hardStale || (!pidAlive && (hasPid || staleNoPid))) {
			rec.status = "orphaned";
			if (rec.endedAt === undefined) {
				rec.endedAt = now;
				rec.durationMs = now - startedAt;
			}
			if (!rec.error) {
				rec.error = hasPid
					? `Left running after parent exit (pid ${rec.pid} unreachable).`
					: "Left running after parent exit (no pid recorded).";
			}
			try {
				atomicWrite(recordFile(storeDir, name), rec);
				orphaned.push(rec);
			} catch {
				/* ignore */
			}
		}
	}
	return orphaned;
}

/**
 * Delete run directories beyond the retention limits (oldest first).
 * Live runs (status running + reachable pid) are never pruned.
 * `PI_SUBAGENT_RETENTION_DAYS` overrides the age limit. Returns count removed.
 */
export function pruneStore(
	maxAgeDays: number = DEFAULT_RETENTION_DAYS,
	maxRuns: number = DEFAULT_MAX_RUNS,
	storeDir: string = resolveStoreDir(),
): number {
	const override = process.env.PI_SUBAGENT_RETENTION_DAYS;
	if (override) {
		const n = Number(override);
		if (Number.isFinite(n) && n > 0) maxAgeDays = n;
	}
	if (!fs.existsSync(storeDir)) return 0;
	const maxAgeTs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

	interface Entry {
		dir: string;
		rec?: SubagentRunRecord;
		startedAt: number;
	}
	const entries: Entry[] = [];
	for (const name of fs.readdirSync(storeDir)) {
		const dir = path.join(storeDir, name);
		let st: fs.Stats;
		try {
			st = fs.statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const rec = readRecord(recordFile(storeDir, name));
		entries.push({ dir, rec, startedAt: rec?.startedAt ?? st.mtimeMs ?? 0 });
	}
	entries.sort((a, b) => b.startedAt - a.startedAt); // newest first

	// A `running` record older than 24h is treated as NOT live (see
	// HARD_ORPHAN_WINDOW_MS) so it becomes prunable when it exceeds retention;
	// this prevents a forever-running record from exempting itself from pruning.
	const isLive = (rec?: SubagentRunRecord): boolean =>
		rec?.status === "running" &&
		(rec.startedAt ?? 0) > Date.now() - HARD_ORPHAN_WINDOW_MS &&
		typeof rec.pid === "number" &&
		rec.pid > 0 &&
		!isProcessDead(rec.pid);

	let kept = 0;
	let removed = 0;
	for (const e of entries) {
		if (isLive(e.rec)) continue; // never prune a live run
		const tooOld = e.startedAt < maxAgeTs;
		const overCap = !tooOld && kept >= maxRuns;
		if (tooOld || overCap) {
			try {
				fs.rmSync(e.dir, { recursive: true, force: true });
				removed++;
			} catch {
				/* ignore */
			}
		} else {
			kept++;
		}
	}
	return removed;
}
