// Unit tests for trigger-compact.ts: threshold-crossing detection and the
// re-entrancy guard that stops overlapping ctx.compact() calls (which used to
// crash pi core with "Cannot read properties of undefined (reading 'signal')"
// when two manual compactions raced on its shared abort-controller field).
// Run directly with Node >= 22 (type-stripping): node tests/trigger-compact.test.ts
import {
	COMPACT_THRESHOLD_TOKENS,
	CompactionTrigger,
	createCompactionTrigger,
	type CompactionCtx,
} from "../trigger-compact.ts";

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

/* ---------------------------- CompactionTrigger --------------------------- */

{
	const t = new CompactionTrigger();
	check("null usage never triggers", t.observe(null), false);
	check(
		"first observation (no prior tokens) never triggers",
		t.observe(COMPACT_THRESHOLD_TOKENS + 1),
		false,
	);
	check(
		"staying above threshold on the next turn does not re-trigger",
		t.observe(COMPACT_THRESHOLD_TOKENS + 2),
		false,
	);
}

{
	const t = new CompactionTrigger();
	t.observe(1000); // below threshold, establishes baseline
	check(
		"crossing above threshold triggers exactly once",
		t.observe(COMPACT_THRESHOLD_TOKENS + 1),
		true,
	);
	check(
		"the very next turn (still above) does not re-trigger",
		t.observe(COMPACT_THRESHOLD_TOKENS + 500),
		false,
	);
}

{
	const t = new CompactionTrigger();
	t.observe(1000);
	t.observe(COMPACT_THRESHOLD_TOKENS + 1); // triggers, drops it after compaction
	t.observe(2000); // compaction succeeded, back under threshold
	check(
		"a second crossing after dropping back down triggers again",
		t.observe(COMPACT_THRESHOLD_TOKENS + 1),
		true,
	);
}

{
	const t = new CompactionTrigger();
	check(
		"sitting exactly at the threshold does not trigger",
		(() => {
			t.observe(COMPACT_THRESHOLD_TOKENS);
			return t.observe(COMPACT_THRESHOLD_TOKENS);
		})(),
		false,
	);
}

/* ------------------------------ fake context ------------------------------ */

function makeCtx(overrides: Partial<CompactionCtx> = {}): { ctx: CompactionCtx } {
	const ctx: CompactionCtx = {
		hasUI: true,
		ui: { notify: () => {} },
		isIdle: () => true,
		compact: () => {},
		...overrides,
	};
	return { ctx };
}

/* --------------------------- createCompactionTrigger --------------------------- */

{
	const trigger = createCompactionTrigger();
	let compactCalls = 0;
	const { ctx } = makeCtx({ compact: () => void compactCalls++ });
	trigger(ctx);
	check("idle context: compact() is invoked", compactCalls, 1);
}

{
	// The scenario that used to crash pi core: a second trigger fires while
	// the first compaction (started by us) hasn't called onComplete/onError
	// yet. The guard must skip the second call instead of letting it race.
	const trigger = createCompactionTrigger();
	let compactCalls = 0;
	const { ctx } = makeCtx({ compact: () => void compactCalls++ }); // never resolves
	trigger(ctx);
	trigger(ctx); // should be skipped: still in flight
	check(
		"overlapping trigger while in flight is skipped, not raced",
		compactCalls,
		1,
	);
}

{
	// After onComplete/onError fires, the guard must release so a later
	// threshold crossing can compact again.
	const trigger = createCompactionTrigger();
	let compactCalls = 0;
	let onComplete: (() => void) | undefined;
	const { ctx } = makeCtx({
		compact: (options) => {
			compactCalls++;
			onComplete = () => options?.onComplete?.(undefined);
		},
	});
	trigger(ctx);
	onComplete?.();
	trigger(ctx);
	check("guard releases after onComplete, allowing a later trigger", compactCalls, 2);
}

{
	const trigger = createCompactionTrigger();
	let compactCalls = 0;
	let onError: ((e: Error) => void) | undefined;
	const { ctx } = makeCtx({
		compact: (options) => {
			compactCalls++;
			onError = (e) => options?.onError?.(e);
		},
	});
	trigger(ctx);
	onError?.(new Error("boom"));
	trigger(ctx);
	check("guard releases after onError, allowing a later trigger", compactCalls, 2);
}

{
	// A concurrent compaction started elsewhere (manual /compact, core
	// overflow auto-compaction, another extension) shows up as !isIdle().
	// We must not pile onto it even though our own inFlight flag is clear.
	const trigger = createCompactionTrigger();
	let compactCalls = 0;
	const { ctx } = makeCtx({ isIdle: () => false, compact: () => void compactCalls++ });
	trigger(ctx);
	check("busy session (not idle) is never compacted onto", compactCalls, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
