import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const COMPACT_THRESHOLD_TOKENS = 200_000;

/**
 * Tracks token usage across turns and reports true exactly once per upward
 * crossing of the compaction threshold — not on every turn spent above it.
 */
export class CompactionTrigger {
	private previousTokens: number | null | undefined;

	/** Feed the latest turn's token count; returns true iff this observation
	 *  is the one that first crosses above the threshold. */
	observe(currentTokens: number | null): boolean {
		if (currentTokens === null) return false;
		const crossedThreshold =
			this.previousTokens !== undefined &&
			this.previousTokens !== null &&
			this.previousTokens <= COMPACT_THRESHOLD_TOKENS;
		this.previousTokens = currentTokens;
		return crossedThreshold && currentTokens > COMPACT_THRESHOLD_TOKENS;
	}
}

/** Minimal slice of ExtensionContext that triggering compaction needs — kept
 *  narrow so it's cheap to fake in tests. `ExtensionContext` and
 *  `ExtensionCommandContext` both satisfy this structurally. */
export interface CompactionCtx {
	hasUI: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	isIdle(): boolean;
	compact(options?: {
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}): void;
}

/**
 * Notify through `ctx.ui`, tolerating a ctx that has gone stale by the time
 * this runs. `onComplete`/`onError` below fire from a fire-and-forget
 * `ctx.compact()` call, so they can land after the turn that captured `ctx`
 * has ended — e.g. a second command already started a new turn. Touching a
 * stale ctx's properties throws ("This extension ctx is stale after session
 * replacement or reload..."), which would otherwise crash the whole process
 * over what's just a best-effort status notification.
 */
function safeNotify(
	ctx: CompactionCtx,
	message: string,
	type?: "info" | "warning" | "error",
) {
	try {
		if (ctx.hasUI) {
			ctx.ui.notify(message, type);
		}
	} catch {
		/* ctx went stale (session reload/newSession/fork) between scheduling
		 * and this callback firing — nothing left to notify through. */
	}
}

/**
 * Builds a fire-and-forget compaction trigger with a re-entrancy guard.
 *
 * `AgentSession.compact()` (what `ctx.compact()` calls) keeps its in-flight
 * abort controller in a single shared field with no reentrancy guard of its
 * own: two overlapping calls (e.g. the automatic turn_end trigger firing
 * while a manual `/trigger-compact` is still summarizing) race on that field,
 * and whichever finishes first clears it out from under the other, which
 * then crashes with "Cannot read properties of undefined (reading 'signal')".
 * Guarding here — skip while one triggered by us is still in flight, or while
 * the session isn't idle (another compaction/turn is already running) — keeps
 * this extension from being a party to that race.
 */
export function createCompactionTrigger() {
	let inFlight = false;
	return (ctx: CompactionCtx, customInstructions?: string) => {
		if (inFlight || !ctx.isIdle()) {
			safeNotify(
				ctx,
				"Skipping compaction: agent is busy or a compaction is already running",
				"info",
			);
			return;
		}
		inFlight = true;
		safeNotify(ctx, "Compaction started", "info");
		ctx.compact({
			customInstructions,
			onComplete: () => {
				inFlight = false;
				safeNotify(ctx, "Compaction completed", "info");
			},
			onError: (error) => {
				inFlight = false;
				safeNotify(ctx, `Compaction failed: ${error.message}`, "error");
			},
		});
	};
}

export default function (pi: ExtensionAPI) {
	const trigger = new CompactionTrigger();
	const triggerCompaction = createCompactionTrigger();

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (trigger.observe(usage?.tokens ?? null)) {
			triggerCompaction(ctx);
		}
	});

	pi.registerCommand("trigger-compact", {
		description: "Trigger compaction immediately",
		handler: async (args, ctx) => {
			const instructions = args.trim() || undefined;
			triggerCompaction(ctx, instructions);
		},
	});
}
