/**
 * Structured output validation ("expect" contract)
 *
 * When a caller passes an `expect` JSON Schema to a subagent invocation, the
 * agent's final message must be exactly one JSON value conforming to that
 * schema. This module builds the prompt directive and validates the final text
 * fail-soft: parse errors and schema mismatches are reported as strings rather
 * than thrown.
 *
 * Validation uses `Value.Check` from `typebox/value`. The runtime resolves
 * `typebox` through the extension loader's node_modules (same source as the
 * `Type` builder used for tool schemas), so schemas built with either import
 * validate consistently.
 */

import { Value } from "typebox/value";

/** Cap on the schema rendered into the agent prompt, to avoid bloat. */
const MAX_SCHEMA_PROMPT_CHARS = 4000;

/** The prompt block appended to the agent's system prompt when `expect` is set. */
export function buildExpectPromptBlock(schema: unknown): string {
	let rendered: string;
	try {
		rendered = JSON.stringify(schema, null, 2);
	} catch {
		rendered = String(schema);
	}
	if (rendered.length > MAX_SCHEMA_PROMPT_CHARS) {
		rendered = `${rendered.slice(0, MAX_SCHEMA_PROMPT_CHARS)}\n... [schema truncated]`;
	}
	return [
		"",
		"## Output contract",
		"Your final message MUST be exactly one JSON value (no prose, no markdown fences, no trailing text) conforming to this JSON Schema:",
		"```json",
		rendered,
		"```",
	].join("\n");
}

/**
 * Parse the agent's final text into a JSON value. Tries, in order: the raw
 * text; a single leading/trailing markdown-fence wrapper stripped; a fenced
 * code block found ANYWHERE in the text (observed live: a model prepending a
 * one-sentence summary before a ```json fence — a leading/trailing strip
 * alone doesn't catch this since the text doesn't *start* with the fence);
 * and finally the widest {...} or [...] span in the text. First candidate
 * that parses wins. Returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function tryParseJson(
	text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = text.trim();
	if (trimmed === "") {
		return { ok: false, error: "final message is empty" };
	}

	const candidates: string[] = [trimmed];

	const unwrapped = trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	if (unwrapped !== trimmed) candidates.push(unwrapped);

	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch) candidates.push(fenceMatch[1].trim());

	const objectMatch = trimmed.match(/\{[\s\S]*\}/);
	if (objectMatch) candidates.push(objectMatch[0]);
	const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
	if (arrayMatch) candidates.push(arrayMatch[0]);

	for (const candidate of candidates) {
		try {
			return { ok: true, value: JSON.parse(candidate) };
		} catch {
			/* try the next candidate */
		}
	}
	return {
		ok: false,
		error: "final message is not valid JSON (even after stripping fences and salvage)",
	};
}

export interface ExpectValidationResult {
	ok: boolean;
	/** Parsed value on success; undefined on failure. */
	value?: unknown;
	/** Human-readable reason on failure. */
	error?: string;
}

/**
 * Validate a final agent message against an `expect` schema.
 * Returns the parsed value on success; on failure a descriptive error string.
 */
export function validateStructuredOutput(
	schema: unknown,
	finalText: string,
): ExpectValidationResult {
	if (schema === null || typeof schema !== "object") {
		// Not a real schema — treat as no contract (fail open).
		return { ok: true };
	}
	const parsed = tryParseJson(finalText);
	if (!parsed.ok) {
		return { ok: false, error: (parsed as { error: string }).error };
	}
	let valid = false;
	try {
		valid = Value.Check(schema as never, parsed.value);
	} catch {
		valid = false;
	}
	if (!valid) {
		return {
			ok: false,
			error: "parsed JSON does not conform to the expected schema",
		};
	}
	return { ok: true, value: parsed.value };
}
