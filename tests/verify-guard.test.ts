// Unit tests for verify-guard.ts pure classification logic.
// Run directly with Node >= 22 (type-stripping):  node tests/verify-guard.test.ts
import {
	classifyTurn,
	verifyNudgeMessage,
	type TurnTool,
} from "../verify-guard.ts";

declare const process: { exit(code?: number): never };

let passed = 0;
let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
		console.log(`✓ ${name}`);
	} else {
		failed++;
		console.log(`✗ ${name}\n  expected: ${e}\n  actual:   ${a}`);
	}
};

const t = (name: string, command?: string): TurnTool =>
	command === undefined ? { name } : { name, command };

/* ---- mutations count ---- */
check("edit counts as mutation", classifyTurn([t("edit")]).mutations, 1);
check("write counts as mutation", classifyTurn([t("write")]).mutations, 1);
check(
	"read/bash/tool calls are not mutations",
	classifyTurn([t("read"), t("bash"), t("run_test")]).mutations,
	0,
);

/* ---- verification detection ---- */
check(
	"run_test is verification",
	classifyTurn([t("run_test")]).verifications,
	1,
);
check(
	"lsp_diagnostics is verification",
	classifyTurn([t("lsp_diagnostics")]).verifications,
	1,
);
check(
	"lens_diagnostics is verification",
	classifyTurn([t("lens_diagnostics")]).verifications,
	1,
);
check(
	"bash npm test is verification",
	classifyTurn([t("bash", "npm test")]).verifications,
	1,
);
check(
	"bash npm run check is verification",
	classifyTurn([t("bash", "npm run check")]).verifications,
	1,
);
check(
	"capture_output lint is verification",
	classifyTurn([t("capture_output", "npm run lint")]).verifications,
	1,
);
check(
	"bash ls is NOT verification",
	classifyTurn([t("bash", "ls -la")]).verifications,
	0,
);

/* ---- verdict ---- */
check(
	"edit + no verify → needs nudge",
	classifyTurn([t("edit")]).needsVerifyNudge,
	true,
);
check(
	"edit + write + no verify → needs nudge",
	classifyTurn([t("edit"), t("write")]).needsVerifyNudge,
	true,
);
check(
	"edit + run_test → verified, no nudge",
	classifyTurn([t("edit"), t("run_test")]).needsVerifyNudge,
	false,
);
check(
	"edit + bash npm test → verified, no nudge",
	classifyTurn([t("edit"), t("bash", "npm test")]).needsVerifyNudge,
	false,
);
check(
	"read-only turn → never nudges",
	classifyTurn([t("read"), t("bash", "ls")]).needsVerifyNudge,
	false,
);
check("empty turn → never nudges", classifyTurn([]).needsVerifyNudge, false);

/* ---- message shape ---- */
const msg = verifyNudgeMessage({
	mutations: 2,
	verifications: 0,
	needsVerifyNudge: true,
});
check("nudge mentions file count", msg.includes("2 file(s)"), true);
check(
	"nudge names verify as gate",
	msg.includes("verify before declaring done"),
	true,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
