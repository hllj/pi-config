/**
 * Shared capture + spill-to-disk runner.
 *
 * Extracted from `run_test`: a generic way to run a shell command while keeping
 * the *context* small (Claude Code "Layer 0" pattern). Any tool can use it.
 *
 * The runner:
 *   • runs `command` in `cwd` (shell, detached so the whole tree is killable);
 *   • keeps a bounded head+tail preview buffer for the context;
 *   • streams the FULL output to a temp file on disk once it exceeds
 *     `maxOutputBytes`, so nothing is lost even though nothing floods the
 *     context window;
 *   • reports the spill file path so the agent can read slices on demand
 *     ("check it all" without bloating context).
 *
 * Safety note: `shell: true` is intentional — this runner must execute
 * arbitrary (compound) shell commands, same trust model as pi's built-in
 * `bash`. The `detached: true` flag puts the child in its own process group so
 * killing it reaps the whole tree, not just the shell.
 */

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export const DEFAULT_CAPTURE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 40_000;
/** Budget for the in-context preview when output is large (~2 KB). */
export const DEFAULT_PREVIEW_BYTES = 2_048;

export interface CapturedResult {
	code: number | null;
	timedOut: boolean;
	signal: string | null;
	durationMs: number;
	/** Preview (head+tail) — or the full output if it fit under the cap. */
	output: string;
	/** Total bytes captured, before any spill. */
	outputBytes: number;
	truncated: boolean;
	/** Absolute path to the temp file holding the FULL output, if spilled. */
	spillPath: string | null;
}

export interface CaptureOptions {
	timeoutMs?: number;
	/** Cap on bytes held in context; above this the full output spills to disk. */
	maxOutputBytes?: number;
	/** Budget for the in-context preview (head+tail). */
	previewBytes?: number;
	/** Always write full output to a temp file (not just when it overflows). */
	alwaysSpill?: boolean;
	signal?: AbortSignal;
}

/**
 * Run a command with a hard timeout, capturing combined stdout+stderr.
 * Keeps a bounded head+tail for the preview; once output exceeds
 * `maxOutputBytes`, streams the FULL output to a unique temp file (spilled)
 * and reports its path so the caller can read slices on demand.
 * Sends SIGKILL to the whole process group on timeout/abort.
 */
export async function runCaptured(
	command: string,
	cwd: string,
	opts: CaptureOptions = {},
): Promise<CapturedResult> {
	const started = Date.now();
	const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const previewBytes = Math.min(
		maxOutputBytes,
		opts.previewBytes ?? DEFAULT_PREVIEW_BYTES,
	);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;

	const child = spawn(command, {
		cwd,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Bounded preview buffers + a pre-spill buffer that retains everything seen
	// so far (capped) so the spill file is complete even though it opens late.
	let head = Buffer.alloc(0);
	let tail = Buffer.alloc(0);
	let preSpill = Buffer.alloc(0);
	let totalBytes = 0;
	let overflow = false;
	let finished = false;

	let spillFile: string | null = null;
	let spillWS: import("node:fs").WriteStream | null = null;

	const openSpill = () => {
		spillFile = path.join(
			os.tmpdir(),
			`pi-capture-${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e6)}.log`,
		);
		spillWS = createWriteStream(spillFile, { flags: "w" });
	};

	const capture = (chunk: Buffer) => {
		if (chunk.length === 0) return;
		totalBytes += chunk.length;
		if (head.length < previewBytes) {
			head = Buffer.concat([head, chunk]);
			if (head.length > previewBytes) head = head.subarray(0, previewBytes);
		}
		if (totalBytes <= previewBytes) {
			tail = head;
		} else {
			tail = Buffer.concat([tail, chunk]);
			if (tail.length > previewBytes)
				tail = tail.subarray(tail.length - previewBytes);
		}
		preSpill = Buffer.concat([preSpill, chunk]);
		if (preSpill.length > maxOutputBytes) {
			preSpill = preSpill.subarray(preSpill.length - maxOutputBytes);
		}
		if (!overflow && totalBytes > maxOutputBytes) overflow = true;
		if (opts.alwaysSpill || totalBytes > maxOutputBytes) {
			if (!spillWS) {
				openSpill();
				spillWS?.write(preSpill); // flush everything seen before the stream opened
			}
			spillWS?.write(chunk);
		}
	};
	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);

	const killTree = () => {
		try {
			if (child.pid === undefined) {
				child.kill("SIGKILL");
			} else {
				// Negative PID targets the whole process group (POSIX). On Windows
				// process.kill(-pid) throws; fall back to killing just the child.
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		} catch {
			/* ignore */
		}
	};

	const onAbort = () => killTree();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	if (opts.signal?.aborted) onAbort();

	const timer = setTimeout(killTree, timeoutMs);

	return new Promise<CapturedResult>((resolve) => {
		const finish = async (partial: Omit<CapturedResult, "outputBytes">) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (spillWS) {
				await new Promise<void>((res) => {
					spillWS?.end(() => res());
				});
			}
			resolve({ ...partial, outputBytes: totalBytes });
		};

		child.on("error", (err) => {
			void finish({
				code: -1,
				timedOut: false,
				signal: "error",
				durationMs: Date.now() - started,
				output: `Failed to spawn: ${err.message}`,
				truncated: false,
				spillPath: null,
			});
		});

		child.on("close", (code, sig) => {
			const timedOut = Date.now() - started >= timeoutMs;
			const spilled = spillWS !== null;
			const output = spilled
				? renderPreview(head.toString("utf8"), tail.toString("utf8"))
				: (overflow ? tail : head).toString("utf8");
			void finish({
				code,
				timedOut,
				signal: sig,
				durationMs: Date.now() - started,
				output,
				truncated: overflow || spilled,
				spillPath: spilled ? spillFile : null,
			});
		});
	});
}

/** Build an in-context preview from separate head and tail buffers. */
export function renderPreview(head: string, tail: string): string {
	const h = head.trim();
	const t = tail.trim();
	if (!h) return t || "";
	if (!t) return h;
	return `${h}\n… (middle elided) …\n${t}`;
}
