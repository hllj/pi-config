// Unit tests for subagent/expect.ts (structured-output "expect" contract).
//
// Run via run-expect.sh (copies the CURRENT expect.ts into a throwaway
// workspace with typebox resolvable), or directly with Node >= 22 from a
// workspace where `typebox` resolves: node expect.test.mjs

import {
	buildExpectPromptBlock,
	tryParseJson,
	validateStructuredOutput,
} from "./expect.ts";

let passed = 0;
let failed = 0;
const fail = (n, m) => {
	failed++;
	console.log(`  ✗ ${n}: ${m}`);
};
const ok = (n) => {
	passed++;
	console.log(`  ✓ ${n}`);
};
const assertEq = (n, actual, expected) => {
	if (JSON.stringify(actual) === JSON.stringify(expected)) ok(n);
	else fail(n, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const assertTrue = (n, cond) => (cond ? ok(n) : fail(n, "expected true"));

console.log("== tryParseJson: happy paths ==");
{
	assertEq("bare JSON object", tryParseJson('{"a":1}'), { ok: true, value: { a: 1 } });
	assertEq("bare JSON array", tryParseJson("[1,2,3]"), { ok: true, value: [1, 2, 3] });
	assertEq(
		"leading/trailing ```json fence only",
		tryParseJson('```json\n{"a":1}\n```'),
		{ ok: true, value: { a: 1 } },
	);
	assertEq(
		"leading/trailing bare ``` fence",
		tryParseJson('```\n{"a":1}\n```'),
		{ ok: true, value: { a: 1 } },
	);
}

console.log("== tryParseJson: prose-around-JSON (regression — observed live from a real watchdog run) ==");
{
	// Captured verbatim from a real reviewer dispatch (subagent run store,
	// runId sg-1789198636512-gar6g0d): the model explained itself in prose,
	// THEN fenced the JSON — a leading/trailing-fence strip alone misses this
	// because the text doesn't *start* with the fence.
	const real = 'The diff adds a trivially correct `add()` function with proper export to a repo that contains only this single file (no test framework, no package.json). No bug, no unsafe change, no scope drift, no loop risk. A test-gap flag would be a nitpick given the repo has zero test infrastructure — nothing genuinely fits the five categories.\n\n```json\n{\n  "findings": []\n}\n```';
	const result = tryParseJson(real);
	assertTrue("parses despite leading prose before the fence", result.ok === true);
	assertEq("extracts the correct JSON value", result.ok ? result.value : null, { findings: [] });
}
{
	const trailingProse = '{"findings": []}\n\nLet me know if you need anything else.';
	const result = tryParseJson(trailingProse);
	assertTrue("parses despite trailing prose after bare JSON", result.ok === true);
	assertEq("extracts the correct value", result.ok ? result.value : null, { findings: [] });
}
{
	const bothSides = 'Sure, here is the result:\n```json\n{"a": [1,2,3]}\n```\nHope that helps!';
	const result = tryParseJson(bothSides);
	assertTrue("parses with prose on both sides of a fenced block", result.ok === true);
	assertEq("extracts the correct value", result.ok ? result.value : null, { a: [1, 2, 3] });
}

console.log("== tryParseJson: failure cases ==");
{
	assertEq("empty string", tryParseJson(""), { ok: false, error: "final message is empty" });
	assertEq("whitespace-only", tryParseJson("   \n  "), { ok: false, error: "final message is empty" });
	const noJson = tryParseJson("I looked at the file and everything seems fine, no issues found.");
	assertTrue("prose with no JSON anywhere fails", noJson.ok === false);
}

console.log("== validateStructuredOutput ==");
{
	const schema = { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] };
	const realWithProse = 'Looks clean overall.\n\n```json\n{"findings": []}\n```';
	const result = validateStructuredOutput(schema, realWithProse);
	assertTrue("validates the salvaged JSON against the schema", result.ok === true);
	assertEq("value matches", result.value, { findings: [] });

	const badShape = validateStructuredOutput(schema, '{"wrong": true}');
	assertTrue("schema mismatch still fails", badShape.ok === false);

	const nonSchema = validateStructuredOutput(null, "anything at all");
	assertTrue("no real schema -> fail-open (ok)", nonSchema.ok === true);
}

console.log("== buildExpectPromptBlock ==");
{
	const block = buildExpectPromptBlock({ type: "object" });
	assertTrue("includes the output-contract heading", block.includes("Output contract"));
	assertTrue("includes the rendered schema", block.includes('"type": "object"'));
}

console.log(`SUITE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
