/**
 * Bash Tools Extension
 *
 * Context-economical file-system & verification tools for the agent. Built on
 * the Qwen SWE-bench Pro reproduction lesson (#179): structured, capped tools
 * beat raw bash because raw output bloats context and punishes the model with
 * everything-but-the-answer. Pi's built-ins already cover editing (edit),
 * reading (read + offset/limit), searching (grep, find, ls), so this extension
 * only fills the gaps they leave:
 *
 *   - `file_sizes`     → rank files by line count / byte size so the agent knows
 *     what to read fully vs. skim vs. skip. ⚠ marks context bloat.
 *   - `run_test`       → run a targeted test command with a timeout, returning a
 *     concise result (exit code + truncated tail) instead of raw bash output.
 *     Supports `expectFail` for TDD's RED phase and output caps to avoid bloat.
 *   - `capture_output` → run ANY command and read its FULL output from disk
 *     (spill-to-disk): captures everything to a temp file, keeps a ~2KB preview
 *     + path in context, so you can "check it all" without bloating context.
 *
 * The spill-to-disk capture logic lives in `capture.ts` (shared by run_test and
 * capture_output) — this file only adapts results into tool responses.
 *
 * Each tool shares the same contract:
 *   • returns ONLY a small, targeted signal — never whole files, never an
 *     unbounded dump;
 *   • skips junk (node_modules, .git, dist, …) out of the box;
 *   • supports a `root`/`cwd` that defaults to the working directory.
 *
 * Place the `bash-tools/` dir under ~/.pi/agent/extensions/ or .pi/extensions/
 * and run /reload (or restart pi).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import { runCaptured } from "./capture.ts";

// ─── Shared: ignores & glob utils ──────────────────────────────────────────────

/**
 * Directories/patterns we never descend into or rank by default. Users can
 * extend via the `ignore` param.
 */
const DEFAULT_IGNORES = [
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"build",
	"coverage",
	".cache",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".idea",
	".vscode",
	".DS_Store",
	"target",
];

/**
 * Convert a minimal glob (`*`, `**`, `?`, `[...]`) into a RegExp matched
 * against a forward-slash relative path.
 */
function globToRegExp(glob: string): RegExp {
	const src = String(glob).replace(/\\/g, "/");
	let re = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "*") {
			if (src[i + 1] === "*") {
				if (src[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 3;
					continue;
				}
				re += "(?:.*)";
				i += 2;
				continue;
			}
			re += "[^/]*";
			i += 1;
		} else if (c === "?") {
			re += "[^/]";
			i += 1;
		} else if (c === "[") {
			let j = i + 1;
			let cls = "";
			let closed = false;
			while (j < src.length) {
				if (src[j] === "]") {
					closed = true;
					break;
				}
				if (src[j] === "\\" && j + 1 < src.length) {
					cls += src[j + 1];
					j += 2;
				} else {
					cls += src[j];
					j += 1;
				}
			}
			if (closed) {
				re += `[${cls}]`;
				i = j + 1;
			} else {
				re += "\\[";
				i += 1;
			}
		} else if (c === "\\") {
			re += src[i + 1] ?? "";
			i += 2;
		} else if ("\\.*+?^${}()|[]".includes(c)) {
			re += "\\" + c;
			i += 1;
		} else {
			re += c;
			i += 1;
		}
	}
	return new RegExp(re);
}

/** True when a relative path should be skipped given a list of ignores. */
function isIgnored(rel: string, ignores: string[]): boolean {
	const seg = rel.replace(/\\/g, "/");
	for (const ig of ignores) {
		if (!ig) continue;
		if (ig.includes("*") || ig.includes("?")) {
			if (globToRegExp(ig).test(seg)) return true;
		} else if (seg === ig || seg.startsWith(ig + "/") || seg.endsWith("/" + ig)) {
			return true;
		}
	}
	return false;
}

function forwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}

function combineIgnores(extra?: string[]): string[] {
	return [
		...new Set([
			...DEFAULT_IGNORES,
			...((extra ?? []) as string[]).filter(Boolean),
		]),
	];
}

function resolveRoot(root?: string): string {
	try {
		return path.resolve(root ?? process.cwd());
	} catch {
		return process.cwd();
	}
}

// ─── Shared: directory walker ──────────────────────────────────────────────────

async function* walkFiles(
	root: string,
	ignore: string[],
	maxDepth: number,
): AsyncGenerator<string> {
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (stack.length) {
		const { dir, depth } = stack.pop()!;
		if (depth > maxDepth) continue;
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (let i = entries.length - 1; i >= 0; i--) {
			const ent = entries[i];
			if (ent.isDirectory()) {
				const rel = forwardSlash(path.relative(root, path.join(dir, ent.name)));
				if (isIgnored(rel, ignore)) continue;
				if (depth + 1 > maxDepth) continue;
				stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
			} else if (ent.isFile()) {
				const rel = forwardSlash(path.relative(root, path.join(dir, ent.name)));
				if (isIgnored(rel, ignore)) continue;
				yield path.join(dir, ent.name);
			}
		}
	}
}

// ─── file_sizes ───────────────────────────────────────────────────────────────

function humanSize(n: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	const digits = i === 0 ? 0 : v >= 10 ? 0 : 1;
	return `${v.toFixed(digits)} ${units[i]}`;
}

const MAX_COUNT_LINES = 2_000_000;

/** Count lines of a file without loading it fully into memory. */
async function countLines(file: string): Promise<number> {
	let fh;
	try {
		fh = await fs.open(file, "r");
	} catch {
		return -1;
	}
	const buf = Buffer.alloc(64 * 1024);
	let count = 0;
	let offset = 0;
	try {
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, 64 * 1024, offset);
			if (bytesRead === 0) break;
			for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) count++;
			offset += bytesRead;
			if (count >= MAX_COUNT_LINES) break;
		}
	} catch {
		count = -1;
	} finally {
		await fh.close();
	}
	return count;
}

async function collectSizes(
	root: string,
	glob: string | undefined,
	minLines: number,
	ignore: string[],
	maxDepth: number,
): Promise<Array<{ rel: string; lines: number; size: number }>> {
	const re = glob ? globToRegExp(glob) : null;
	const out: Array<{ rel: string; lines: number; size: number }> = [];
	for await (const file of walkFiles(root, ignore, maxDepth)) {
		const rel = forwardSlash(path.relative(root, file));
		if (re && !re.test(rel)) continue;
		const lines = await countLines(file);
		if (lines < 0) continue;
		if (minLines > 0 && lines < minLines) continue;
		let size = 0;
		try {
			size = (await fs.stat(file)).size;
		} catch {
			/* keep size 0 */
		}
		out.push({ rel, lines, size });
	}
	out.sort((a, b) => b.lines - a.lines || b.size - a.size);
	return out;
}

// ─── run_test ─────────────────────────────────────────────────────────────────

const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 40_000;
/** Budget for the in-context preview when output was spilled (~2 KB). */
const DEFAULT_PREVIEW_BYTES = 2_048;

// Capture + spill-to-disk lives in capture.ts (shared by run_test and
// capture_output); this section only adapts the result into a tool response.

/** Extract a best-effort "passed X / failed Y" summary from runner output. */
function countSummary(output: string): string | null {
	const m =
		output.match(/(\d+)\s+(passed|failed|error)\\s/g) ??
		output.match(/(\d+) passed[,\s]+(\d+) failed/i);
	if (m && m[0].match(/passed|failed/i)) return m[0].trim();
	return null;
}

/**
 * Render captured output as a concise head + tail with an elision note, so a
 * long test log stays context-friendly.
 */
function renderOutput(
	output: string,
	tailLines: number,
): {
	body: string;
	note: string;
} {
	const lines = output.split("\n");
	if (lines.length <= 40) return { body: output.trim(), note: "" };
	const head = lines.slice(0, 12);
	const tail = lines.slice(-tailLines);
	const elided = lines.length - head.length - tail.length;
	let note = "";
	if (elided > 0) {
		note = `\n… ${elided} lines elided (head + tail shown) …`;
	}
	return { body: `${head.join("\n")}${note}\n${tail.join("\n")}`.trim(), note };
}

// ─── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── file_sizes ──────────────────────────────────────────────────────────
	pi.registerTool({
		name: "file_sizes",
		label: "File sizes (context-bloat guard)",
		description:
			"Rank files under a directory by line count (desc) and byte size — so you know which files are big (potentially context-bloating) before you read them. " +
			"Output is a table of rel-path | lines | size. Optional `glob` restricts to a subset; `minLines` drops small files. " +
			"Large files are flagged (⚠) so you read them in slices rather than whole. " +
			"This is the context-bloat guard: run it before choosing what to read.",
		promptSnippet: "See which files are large before reading",
		promptGuidelines: [
			"Run file_sizes when choosing which file to read — pick the small relevant file, and read big ones in slices to keep context small.",
			"Combine with glob to scope the scan to a subsystem before ranking.",
		],
		parameters: Type.Object({
			root: Type.Optional(
				Type.String({
					description: "Directory to scan. Defaults to the working directory.",
				}),
			),
			glob: Type.Optional(
				Type.String({
					description:
						"Restrict ranking to files whose relative path matches this glob (e.g. 'src/**/*.ts').",
				}),
			),
			minLines: Type.Optional(
				Type.Number({
					description: "Ignore files with fewer than this many lines. Default 0.",
					minimum: 0,
				}),
			),
			ignore: Type.Optional(
				Type.Array(Type.String(), {
					description: "Extra path/glob patterns to ignore.",
				}),
			),
			maxDepth: Type.Optional(
				Type.Number({
					description: "Maximum recursion depth. Default 16.",
					minimum: 1,
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max files to report, largest first. Default 30.",
					minimum: 1,
				}),
			),
		}),
		async execute(_callId, params, _signal, _ctx) {
			const rootAbs = resolveRoot(params.root);
			try {
				const list = await collectSizes(
					rootAbs,
					params.glob,
					params.minLines ?? 0,
					combineIgnores(params.ignore),
					Math.max(1, params.maxDepth ?? 16),
				);
				const limit = Math.max(1, params.limit ?? 30);
				const shown = list.slice(0, limit);
				const truncated = list.length > limit;
				if (!shown.length) {
					return {
						content: [
							{
								type: "text",
								text: `(no files meet the criteria${params.glob ? ` for glob ${JSON.stringify(params.glob)}` : ""}) under ${rootAbs}`,
							},
						],
						details: { root: rootAbs, count: 0 },
					};
				}
				const linesTotal = shown.reduce((a, r) => a + r.lines, 0);
				const head = "Files by line count, largest first (root: " + rootAbs + ")";
				const rowsText = shown
					.map((r) => {
						const flag = r.lines >= 500 ? " ⚠️" : "";
						return (
							String(r.lines).padStart(6) +
							" lines " +
							humanSize(r.size).padStart(9) +
							"  " +
							r.rel +
							flag
						);
					})
					.join("\n");
				let trailer = `\n\nTotal shown: ${shown.length} files, ${linesTotal.toLocaleString()} lines`;
				if (truncated)
					trailer += ` · ${list.length - shown.length} more skipped; narrow glob or raise \`limit\`.`;
				const big = shown.filter((r) => r.lines >= 500);
				if (big.length) {
					trailer +=
						"\n\n⚠️ Large files flagged — read via offset/limit slices, not whole, to keep context small.";
				}
				return {
					content: [{ type: "text", text: `${head}\n\n${rowsText}${trailer}` }],
					details: {
						root: rootAbs,
						count: list.length,
						truncated,
						largest: shown[0]?.rel,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `file_sizes failed: ${message}` }],
					details: { root: rootAbs, error: message },
					isError: true,
				};
			}
		},
	});

	// ── run_test ────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "run_test",
		label: "Run a targeted test",
		description:
			"Run a single test command (or narrow verification) in a subprocess with a hard timeout, returning a CONCISE result — " +
			"pass/fail, exit code, duration, and a small preview of the output — instead of raw context-bloating output. " +
			"Context-bloat guard (Claude Code 'Layer 0' pattern): if output exceeds `maxOutputBytes`, the FULL log is spilled to a " +
			"temp file on disk and context keeps only ~2KB preview + the file path, so nothing is lost but nothing floods the window. " +
			"Use `expectFail` during TDD's RED phase (treats a failing/nonzero result as the expected/good outcome).",
		promptSnippet: "Run a test with a timeout and concise result",
		promptGuidelines: [
			"Prefer `run_test` over a raw `bash` test call when all you need is pass/fail + the tail: it returns a compact summary, not full output.",
			"Set `timeoutMs` for tests that may hang — the process is killed on timeout, never left running.",
			"In RED-GREEN-REFACTOR, pass `expectFail: true` at the failing-assertion stage so a 'fail' is reported as the expected outcome. When output is spilled to disk (over `maxOutputBytes`), read the spill file in slices if you need the middle.",
			"Keep `maxOutputBytes` small (default 40K) — it doubles as the spill threshold that keeps over-large logs out of context.",
		],
		parameters: Type.Object({
			command: Type.String({
				description:
					"Shell command to run (e.g. 'npm test', 'pytest tests/test_a.py').",
			}),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory to run in. Defaults to the working directory.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: `Hard timeout in ms. Default ${DEFAULT_TEST_TIMEOUT_MS} (120s). Process is killed on exceed.`,
					minimum: 1,
				}),
			),
			expectFail: Type.Optional(
				Type.Boolean({
					description:
						"Treat a failing/nonzero result as the desired outcome (TDD RED phase). Default false.",
				}),
			),
			maxOutputBytes: Type.Optional(
				Type.Number({
					description: `Cap on captured combined output bytes. Default ${DEFAULT_MAX_OUTPUT_BYTES}. Lower it to keep context smaller.`,
					minimum: 512,
				}),
			),
			tailLines: Type.Optional(
				Type.Number({
					description: "How many tail lines to show alongside the head. Default 40.",
					minimum: 1,
				}),
			),
		}),
		async execute(_callId, params, signal, _onUpdate, _ctx) {
			const cwd = resolveRoot(params.cwd);
			const timeoutMs = params.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
			const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
			const tailLines = Math.max(1, params.tailLines ?? 40);
			const expectFail = params.expectFail ?? false;
			try {
				const result = await runCaptured(params.command, cwd, {
					timeoutMs,
					maxOutputBytes,
					signal,
				});

				const pass = result.code === 0 && !result.timedOut;
				const verdict = expectFail ? !pass : pass;
				let statusText = "FAIL";
				if (result.timedOut) statusText = "TIMED OUT";
				else if (verdict) statusText = "PASS";
				const passed = countSummary(result.output);

				const summary =
					`${statusText} · exit ${result.code ?? "n/a"}` +
					` · ${result.durationMs}ms` +
					`${result.signal ? ` · signal ${result.signal}` : ""}` +
					` · ${result.outputBytes.toLocaleString()}B output` +
					`${result.truncated ? ` · truncated (head+tail shown)` : ""}` +
					`${passed ? ` · ${passed}` : ""}` +
					`${result.timedOut ? ` · timeout ${timeoutMs}ms` : ""}`;

				let bodyText = "\n\n(no output)";
				if (result.output) {
					// runCaptured already built a preview for spilled output; for
					// non-spilled it still fits, so render head+tail for long-ish ones.
					if (result.spillPath) {
						bodyText =
							`\n\n<preview>\n${result.output}\n</preview>\n` +
							`Full output spilled to disk (not in context): ${result.spillPath}\n` +
							`Read it in slices with read(file, offset, limit) if you need the middle.`;
					} else {
						const { body, note } = renderOutput(result.output, tailLines);
						bodyText = body ? `\n\n${body}${note}` : "\n\n(no output)";
					}
				}

				return {
					content: [{ type: "text", text: `${summary}${bodyText}` }],
					details: {
						command: params.command,
						cwd,
						exitCode: result.code,
						timedOut: result.timedOut,
						signal: result.signal,
						durationMs: result.durationMs,
						outputBytes: result.outputBytes,
						truncated: result.truncated,
						spillPath: result.spillPath,
						expectFail,
						success: verdict,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `run_test failed: ${message}` }],
					details: { command: params.command, error: message },
					isError: true,
				};
			}
		},
	});

	// ── capture_output ────────────────────────────────────────────────────────
	// The general-purpose spill-to-disk surface: run ANY command and read its
	// FULL output from disk — while keeping only a small preview in context
	// (the Claude Code "Layer 0" pattern, now reusable beyond run_test).
	pi.registerTool({
		name: "capture_output",
		label: "Run a command and read its full output from disk",
		description:
			"Run an arbitrary shell command and capture its output with the spill-to-disk mechanism. " +
			"The FULL output is always streamed to a temp file (so you can 'check it all'), while the context keeps only a ~2KB preview + the file path — " +
			"nothing is lost, nothing floods the window (Claude Code 'Layer 0' pattern). " +
			"Use it for any command whose output is too big to inline (builds, greps, logs, tooling dumps) — then read slices of the spill file on demand. " +
			"Unlike run_test (pass/fail + TDD), this is the general-purpose 'give me everything, but keep context small' tool.",
		promptSnippet:
			"Run a command; spill its full output to disk; read it all in slices",
		promptGuidelines: [
			"Prefer this over raw `bash` when you need the FULL output of a large command but don't want it in context. The full output goes to a temp file; read it in slices with read(file, offset, limit).",
			"Use `alwaysSpill: true` to always write full output to disk even when it would fit inline — best for reliably inspecting everything.",
			"Set `tailLines`/`headLines` to widen the in-context preview if you need more of the head or tail.",
			"Drop the spill file with rm when done to free disk space.",
		],
		parameters: Type.Object({
			command: Type.String({
				description:
					"Shell command to run (e.g. 'npm run build', 'cat logs/app.log', 'git log --oneline -500').",
			}),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory to run in. Defaults to the working directory.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: `Hard timeout in ms. Default ${DEFAULT_TEST_TIMEOUT_MS} (120s). Process is killed on exceed.`,
					minimum: 1,
				}),
			),
			alwaysSpill: Type.Optional(
				Type.Boolean({
					description:
						"Always write the full output to a temp file (even small output), keeping only a preview in context. Default false — spills only when output exceeds the cap.",
				}),
			),
			tailLines: Type.Optional(
				Type.Number({
					description:
						"How many tail lines to keep in the in-context preview alongside the head. Default 60.",
					minimum: 1,
				}),
			),
			previewBytes: Type.Optional(
				Type.Number({
					description: `Budget for the in-context preview (head+tail). Default ${DEFAULT_PREVIEW_BYTES}.`,
					minimum: 256,
				}),
			),
		}),
		async execute(_callId, params, signal, _onUpdate, _ctx) {
			const cwd = resolveRoot(params.cwd);
			const timeoutMs = params.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
			const alwaysSpill = params.alwaysSpill ?? true;
			const tailLines = Math.max(1, params.tailLines ?? 60);
			try {
				const result = await runCaptured(params.command, cwd, {
					timeoutMs,
					maxOutputBytes: params.previewBytes ?? DEFAULT_PREVIEW_BYTES,
					previewBytes: params.previewBytes ?? DEFAULT_PREVIEW_BYTES,
					alwaysSpill,
					signal,
				});

				const statusText = result.timedOut
					? "TIMED OUT"
					: result.code === 0
						? "OK"
						: "EXIT " + (result.code ?? "n/a");
				const summary =
					`${statusText} · exit ${result.code ?? "n/a"}` +
					` · ${result.durationMs}ms` +
					`${result.signal ? ` · signal ${result.signal}` : ""}` +
					` · ${result.outputBytes.toLocaleString()}B output` +
					`${result.timedOut ? ` · timeout ${timeoutMs}ms` : ""}`;

				let bodyText = "\n\n(no output)";
				if (result.output) {
					if (result.spillPath) {
						bodyText =
							`\n\n<preview>\n${result.output}\n</preview>\n` +
							`Full output spilled to disk (not in context): ${result.spillPath}\n` +
							`Read all of it with read("${result.spillPath}", offset, limit), or slices below.`;
					} else {
						const { body, note } = renderOutput(result.output, tailLines);
						bodyText = body ? `\n\n${body}${note}` : "\n\n(no output)";
					}
				}

				return {
					content: [{ type: "text", text: `${summary}${bodyText}` }],
					details: {
						command: params.command,
						cwd,
						exitCode: result.code,
						timedOut: result.timedOut,
						signal: result.signal,
						durationMs: result.durationMs,
						outputBytes: result.outputBytes,
						truncated: result.truncated,
						alwaysSpill,
						previewBytes: params.previewBytes ?? DEFAULT_PREVIEW_BYTES,
						spillPath: result.spillPath,
						success: result.code === 0 && !result.timedOut,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `capture_output failed: ${message}` }],
					details: { command: params.command, error: message },
					isError: true,
				};
			}
		},
	});
}
