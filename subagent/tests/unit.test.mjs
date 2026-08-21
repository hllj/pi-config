// Unit tests for subagent/session-store.ts.
//
// Run via run-unit.sh (which copies session-store.ts + this file into a
// throwaway workspace with @earendil-works resolvable), or directly with
// Node >= 18:  cd <workdir> && node unit.test.mjs
//
// Node's type-stripping erases `import type`, so this exercises real logic.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import {
	resolveStoreDir,
	recordStart,
	recordEnd,
	listRuns,
	getRun,
	readRunTranscript,
	reconcileOrphans,
	pruneStore,
	formatDuration,
} from "./session-store.ts";

const STORE = path.join(os.tmpdir(), `subagent-unit-${Date.now()}-main`);
fs.rmSync(STORE, { recursive: true, force: true });

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

const base = (o = {}) => ({
	runId: "run-x",
	agent: "scout",
	agentSource: "user",
	task: "t",
	model: "m",
	mode: "single",
	parentSessionId: "p",
	parentSessionFile: "/p/s.jsonl",
	status: "running",
	startedAt: Date.now() - 1000,
	usage: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.001,
		contextTokens: 100,
		turns: 2,
	},
	...o,
});

console.log("== resolveStoreDir ==");
{
	const saved = process.env.PI_SUBAGENT_SESSION_DIR;
	delete process.env.PI_SUBAGENT_SESSION_DIR;
	const r1 = resolveStoreDir("/Users/hllj/.pi/agent/sessions/--Users-hllj--");
	if (r1 === "/Users/hllj/.pi/agent/subagents")
		ok("derived from session dir -> <root>/subagents");
	else fail("derived", r1);
	const r2 = resolveStoreDir(undefined);
	const expected = path.join(os.homedir(), ".pi/agent/subagents");
	if (r2 === expected) ok("fallback -> ~/.pi/agent/subagents");
	else fail("fallback", r2);
	const overridePath = path.join(os.tmpdir(), "override");
	process.env.PI_SUBAGENT_SESSION_DIR = overridePath;
	const r3 = resolveStoreDir("/x");
	if (r3 === overridePath) ok("PI_SUBAGENT_SESSION_DIR overrides");
	else fail("env", r3);
	if (saved === undefined) delete process.env.PI_SUBAGENT_SESSION_DIR;
	else process.env.PI_SUBAGENT_SESSION_DIR = saved;
}

console.log("== record + list + get + end ==");
{
	recordStart(base(), STORE);
	const rec = getRun("run-x", STORE);
	if (rec && rec.status === "running" && rec.usage.turns === 2)
		ok("getRun full record");
	else fail("getRun", "n/a");
	recordEnd(
		{
			...base(),
			status: "completed",
			endedAt: Date.now(),
			durationMs: 1500,
			exitCode: 0,
		},
		STORE,
	);
	const ended = getRun("run-x", STORE);
	if (ended?.status === "completed" && ended.durationMs === 1500)
		ok("recordEnd atomic rewrite");
	else fail("recordEnd", ended?.status);
	const list = listRuns({}, STORE);
	if (list.length === 1 && list[0].runId === "run-x")
		ok("listRuns newest-first");
	else fail("listRuns", list.length);
	if (listRuns({ status: "running" }, STORE).length === 0) ok("status filter");
	else fail("status filter");
	const byMode = listRuns({ mode: "workflow" }, STORE);
	if (byMode.length === 0) ok("mode filter (listRuns supports it)");
	else fail("mode filter", byMode.length);
	if (listRuns({ since: Date.now() + 1 }, STORE).length === 0)
		ok("since filter");
	else fail("since filter");
}

console.log("== atomicity / corrupt skip ==");
{
	fs.writeFileSync(path.join(STORE, "run-x", "record.json.tmp"), '{"broken');
	if (listRuns({}, STORE).length === 1) ok("stray .tmp ignored");
	else fail("tmp", "listed");
	fs.rmSync(path.join(STORE, "run-x", "record.json.tmp"));
	fs.mkdirSync(path.join(STORE, "run-corrupt"), { recursive: true });
	fs.writeFileSync(path.join(STORE, "run-corrupt", "record.json"), "{not json");
	if (listRuns({}, STORE).some((r) => r.runId === "run-corrupt"))
		fail("corrupt", "listed");
	else ok("corrupt record skipped");
}

console.log(
	"== normalization regression: missing usage fields must not crash ==",
);
{
	const d = path.join(STORE, "run-bare");
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(
		path.join(d, "record.json"),
		JSON.stringify({
			runId: "run-bare",
			agent: "worker",
			agentSource: "user",
			task: "crashed mid-run",
			model: "m",
			mode: "single",
			parentSessionId: "p",
			parentSessionFile: "/p",
			status: "orphaned",
			startedAt: Date.now(),
			usage: {}, // <-- the toFixed crash trigger
		}),
	);
	const bare = getRun("run-bare", STORE);
	if (!bare) fail("bare record read", "undefined");
	else if (
		typeof bare.usage.cost !== "number" ||
		typeof bare.usage.turns !== "number"
	) {
		fail(
			"bare normalized",
			`usage.cost=${bare.usage.cost} turns=${bare.usage.turns}`,
		);
	} else ok("missing usage fields coerced to numbers on read");
	let all;
	try {
		all = listRuns({}, STORE); // must not throw
	} catch (e) {
		fail("listRuns bare throws", String(e));
		all = [];
	}
	if (Array.isArray(all) && all.length >= 1)
		ok("listRuns no longer crashes on bare records");
	else fail("listRuns bare", all?.length);
	if (Array.isArray(all) && typeof all[0]?.usage?.cost === "number")
		ok("listed bare record has numeric cost");
	else fail("listed cost", all?.[0]?.usage?.cost);
}

console.log("== reconcileOrphans ==");
{
	const deadPid = 4194304;
	recordStart(base({ runId: "o-dead", pid: deadPid }), STORE);
	const child = spawn("sleep", ["30"], { stdio: "ignore" });
	recordStart(base({ runId: "o-live", pid: child.pid }), STORE);
	recordStart(
		base({ runId: "o-nopid-fresh", startedAt: Date.now() - 1000 }),
		STORE,
	);
	recordStart(
		base({ runId: "o-nopid-stale", startedAt: Date.now() - 11 * 60 * 1000 }),
		STORE,
	);
	recordStart(
		base({
			runId: "o-pid-hardstale",
			pid: deadPid,
			startedAt: Date.now() - 25 * 60 * 60 * 1000,
		}),
		STORE,
	);
	const orphaned = reconcileOrphans(STORE);
	if (getRun("o-dead", STORE)?.status === "orphaned") ok("dead pid -> orphaned");
	else fail("dead pid");
	if (getRun("o-live", STORE)?.status === "running")
		ok("live pid stays running");
	else fail("live pid");
	if (getRun("o-nopid-fresh", STORE)?.status === "running")
		ok("fresh no-pid stays running");
	else fail("fresh no-pid");
	if (getRun("o-nopid-stale", STORE)?.status === "orphaned")
		ok("stale no-pid (>10m) orphaned");
	else fail("stale no-pid");
	if (getRun("o-pid-hardstale", STORE)?.status === "orphaned")
		ok("24h hard window orphans stale running");
	else fail("hard stale");
	if (orphaned.length === 3) ok("returns newly orphaned (3)");
	else fail("orphan count", orphaned.length);
	child.kill("SIGKILL");
}

console.log("== pruneStore ==");
{
	const now = Date.now();
	recordStart(
		base({
			runId: "p-old1",
			startedAt: now - 20 * 86400000,
			status: "completed",
		}),
		STORE,
	);
	recordStart(
		base({ runId: "p-old2", startedAt: now - 20 * 86400000, status: "failed" }),
		STORE,
	);
	recordStart(
		base({
			runId: "p-hardstale-live-pid",
			pid: 4194304,
			startedAt: now - 20 * 86400000,
			status: "running",
		}),
		STORE,
	);
	const child = spawn("sleep", ["30"], { stdio: "ignore" });
	recordStart(
		base({
			runId: "p-live",
			pid: child.pid,
			startedAt: now - 1000,
			status: "running",
		}),
		STORE,
	);
	pruneStore(14, 100, STORE);
	if (!getRun("p-old1", STORE) && !getRun("p-old2", STORE))
		ok("run >14d removed");
	else fail("age remove");
	if (!getRun("p-hardstale-live-pid", STORE))
		ok(">14d running-with-pid prunable (not live)");
	else fail("hardstale prune");
	if (!getRun("p-live", STORE)) fail("live kept", "pruned");
	else ok("live run never pruned");
	child.kill("SIGKILL");
}

console.log("== pruneStore maxRuns cap (isolated) ==");
{
	const CAP = path.join(os.tmpdir(), `subagent-unit-${Date.now()}-cap`);
	fs.rmSync(CAP, { recursive: true, force: true });
	const now = Date.now();
	for (let i = 1; i <= 8; i++)
		recordStart(
			base({ runId: `c-${i}`, startedAt: now - i * 60000, status: "completed" }),
			CAP,
		);
	const removed = pruneStore(365, 5, CAP);
	const after = listRuns({}, CAP).filter((r) => r.runId.startsWith("c-"));
	if (after.length === 5) ok("cap keeps 5 newest");
	else fail("cap kept", after.length);
	if (removed === 3) ok("cap removed 3 oldest");
	else fail("cap removed", removed);
	if (after.some((r) => r.runId === "c-1")) ok("newest retained");
	else fail("newest");
	fs.rmSync(CAP, { recursive: true, force: true });
}

console.log("== pruneStore env retention override (isolated) ==");
{
	const RT = path.join(os.tmpdir(), `subagent-unit-${Date.now()}-rt`);
	fs.rmSync(RT, { recursive: true, force: true });
	const saved = process.env.PI_SUBAGENT_RETENTION_DAYS;
	const now = Date.now();
	recordStart(
		base({
			runId: "rt-old1",
			startedAt: now - 2 * 86400000,
			status: "completed",
		}),
		RT,
	);
	recordStart(
		base({ runId: "rt-old2", startedAt: now - 2 * 86400000, status: "failed" }),
		RT,
	);
	recordStart(
		base({ runId: "rt-fresh", startedAt: now - 1000, status: "completed" }),
		RT,
	);
	delete process.env.PI_SUBAGENT_RETENTION_DAYS;
	if (pruneStore(14, 100, RT) === 0) ok("default 14d keeps 2-day-old");
	else fail("default remove");
	process.env.PI_SUBAGENT_RETENTION_DAYS = "1";
	if (pruneStore(14, 100, RT) === 2) ok("override=1 removes 2-day-old");
	else fail("override");
	delete process.env.PI_SUBAGENT_RETENTION_DAYS;
	const left = listRuns({}, RT).map((r) => r.runId);
	if (left.length === 1 && left[0] === "rt-fresh") ok("fresh retained");
	else fail("remaining", left.join(","));
	process.env.PI_SUBAGENT_RETENTION_DAYS = "0";
	const rm = pruneStore(14, 100, RT); // 0 rejected by the n>0 guard -> default 14d
	if (rm === 0) ok("retention=0 rejected -> default (nothing removed)");
	else fail("zero", rm);
	if (saved === undefined) delete process.env.PI_SUBAGENT_RETENTION_DAYS;
	else process.env.PI_SUBAGENT_RETENTION_DAYS = saved;
	fs.rmSync(RT, { recursive: true, force: true });
}
console.log("== formatDuration ==");
{
	if (formatDuration(500) === "500ms") ok("500ms");
	else fail("500", formatDuration(500));
	if (formatDuration(2500)?.includes("s")) ok("seconds");
	else fail("s", formatDuration(2500));
	if (formatDuration(150000)?.includes("2m")) ok("minutes");
	else fail("m", formatDuration(150000));
	if (formatDuration(undefined) === "—") ok("undefined dash");
	else fail("undef", formatDuration(undefined));
}

console.log("== readRunTranscript (SessionManager.open) ==");
{
	const dir = path.join(STORE, "transcript");
	fs.mkdirSync(dir, { recursive: true });
	const sf = path.join(dir, "2026-08-21_session.jsonl");
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: "01abc",
		timestamp: "2026-08-21T00:00:00.000Z",
		cwd: "/tmp",
	});
	const m1 = JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-08-21T00:00:00.001Z",
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
	const m2 = JSON.stringify({
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp: "2026-08-21T00:00:00.002Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "found 3 files" }],
		},
	});
	fs.writeFileSync(sf, [header, m1, m2].join("\n") + "\n");
	recordStart(base({ runId: "transcript", sessionFile: sf }), STORE);
	const t = readRunTranscript("transcript", STORE);
	if (!t) fail("transcript", "undefined");
	else {
		if (t.messages.length === 2) ok("2 messages (SessionManager.open)");
		else fail("msg count", t.messages.length);
		if (t.header?.id === "01abc") ok("header parsed");
		else fail("header", JSON.stringify(t.header));
		if (t.messages[0].role === "user" && t.messages[1].role === "assistant")
			ok("roles ordered");
		else fail("roles");
	}
}

console.log("== readRunTranscript JSONL fallback ==");
{
	const d2 = path.join(STORE, "trans-fallback");
	fs.mkdirSync(d2, { recursive: true });
	const hdr = JSON.stringify({
		type: "session",
		version: 3,
		id: "01xyz",
		timestamp: "2026-08-21T00:00:00.000Z",
		cwd: "/tmp",
	});
	const msg = JSON.stringify({
		type: "message",
		id: "f1",
		parentId: null,
		timestamp: "2026-08-21T00:00:00.001Z",
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
	fs.writeFileSync(path.join(d2, "x_session.jsonl"), hdr + "\n" + msg + "\n");
	const t2 = readRunTranscript("trans-fallback", STORE);
	if (t2?.messages?.length === 1) ok("fallback JSONL parse");
	else fail("fallback", t2?.messages?.length);
}

console.log("");
console.log(`SUITE: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
