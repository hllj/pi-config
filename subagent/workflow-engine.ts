/**
 * Workflow Engine for Subagents
 *
 * Extends chain logic with:
 * - Condition evaluation (outputContains, exitCodeEquals)
 * - Error recovery (retry/skip/fallback/abort)
 * - Approval gates
 * - State persistence
 */

export type StepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped"
	| "waiting_approval";

export interface StepCondition {
	type: "outputContains" | "exitCodeEquals";
	value: string | number;
}

export interface ErrorHandler {
	strategy: "retry" | "skip" | "fallback" | "abort";
	maxRetries?: number;
	fallbackAgent?: string;
	fallbackTask?: string;
}

export interface WorkflowStep {
	agent: string;
	task: string;
	cwd?: string;
	condition?: StepCondition;
	errorHandler?: ErrorHandler;
	requiresApproval?: boolean;
	/**
	 * Consecutive steps sharing a parallelGroup id run concurrently (bounded by
	 * MAX_CONCURRENCY). Only CONSECUTIVE steps are grouped; reusing an id
	 * non-consecutively starts a separate group. Within a group, `{previous}`
	 * substitutes the output preceding the group.
	 */
	parallelGroup?: string;
	timeoutMs?: number;
	contextFiles?: string[];
	expect?: unknown;
}

export interface WorkflowStepResult {
	step: WorkflowStep;
	stepIndex: number;
	status: StepStatus;
	output?: string;
	exitCode?: number;
	error?: string;
	retryCount?: number;
	approvalGranted?: boolean;
	startTime?: number;
	endTime?: number;
	/** Token usage for this step's dispatch, when known (undefined for skipped/never-run steps). */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface WorkflowState {
	id: string;
	name?: string;
	steps: WorkflowStep[];
	results: WorkflowStepResult[];
	currentStepIndex: number;
	status: "running" | "completed" | "failed" | "paused";
	startTime: number;
	endTime?: number;
	error?: string;
	/** Set when this state was resumed from a prior session (via resume_workflow). */
	resumedFromStepIndex?: number;
	resumedAt?: number;
	/** Optional whole-workflow token budget (input+output+cache, summed across steps). */
	budgetTokens?: number;
	/** Percent thresholds (60, 85) already nudged for, so a resume doesn't repeat one. */
	budgetNudgesSent?: number[];
}

/**
 * Evaluate a step condition based on previous output
 */
export function evaluateCondition(
	condition: StepCondition,
	output: string,
	exitCode: number,
): boolean {
	// Validate inputs
	if (output === undefined || output === null) {
		console.warn(
			`evaluateCondition: output is ${output}, treating as empty string`,
		);
		output = "";
	}

	switch (condition.type) {
		case "outputContains": {
			const searchValue = String(condition.value);
			return output.toLowerCase().includes(searchValue.toLowerCase());
		}
		case "exitCodeEquals": {
			const expectedCode = Number(condition.value);
			if (Number.isNaN(expectedCode)) {
				console.error(`Invalid exitCode value: ${condition.value}`);
				return false;
			}
			return exitCode === expectedCode;
		}
		default: {
			console.error(`Unknown condition type: ${(condition as any).type}`);
			return false; // Fail safe: don't execute step with unknown condition
		}
	}
}

/**
 * Check if a step should be executed based on its condition
 */
export function shouldExecuteStep(
	step: WorkflowStep,
	previousOutput: string,
	previousExitCode: number,
): boolean {
	if (!step.condition) return true;
	return evaluateCondition(step.condition, previousOutput, previousExitCode);
}

/**
 * Determine error handling strategy for a failed step
 */
export function handleStepError(
	step: WorkflowStep,
	result: WorkflowStepResult,
): {
	action: "retry" | "skip" | "fallback" | "abort";
	fallbackStep?: WorkflowStep;
} {
	const handler = step.errorHandler ?? { strategy: "abort" };
	const retryCount = result.retryCount ?? 0;

	if (handler.strategy === "retry") {
		const maxRetries = handler.maxRetries ?? 3;
		if (retryCount < maxRetries) {
			return { action: "retry" };
		}
		// Max retries exceeded, abort
		return { action: "abort" };
	}

	if (
		handler.strategy === "fallback" &&
		handler.fallbackAgent &&
		handler.fallbackTask
	) {
		return {
			action: "fallback",
			fallbackStep: {
				agent: handler.fallbackAgent,
				task: handler.fallbackTask,
				cwd: step.cwd,
			},
		};
	}

	return { action: handler.strategy };
}

/**
 * Generate a unique workflow ID
 */
export function generateWorkflowId(): string {
	return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create initial workflow state
 */
export function createWorkflowState(
	steps: WorkflowStep[],
	name?: string,
	budgetTokens?: number,
): WorkflowState {
	return {
		id: generateWorkflowId(),
		name,
		steps,
		results: steps.map((step, index) => ({
			step,
			stepIndex: index,
			status: "pending",
		})),
		currentStepIndex: 0,
		status: "running",
		startTime: Date.now(),
		...(budgetTokens !== undefined && budgetTokens > 0 ? { budgetTokens } : {}),
	};
}

/** Sum of known per-step token usage recorded so far (input+output+cache). */
export function totalWorkflowTokens(state: WorkflowState): number {
	return state.results.reduce((sum, r) => {
		if (!r.usage) return sum;
		return sum + r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
	}, 0);
}

const BUDGET_NUDGE_THRESHOLDS = [60, 85] as const;

/**
 * Given cumulative token usage against a workflow's budget, return the
 * highest not-yet-sent threshold percent newly crossed, or undefined if
 * none (no budget set, or nothing new to report). Caller should append the
 * returned percent to the workflow's budgetNudgesSent so it isn't repeated.
 */
export function nextBudgetThresholdCrossed(
	totalTokens: number,
	budgetTokens: number | undefined,
	alreadySent: number[] | undefined,
): number | undefined {
	if (!budgetTokens || budgetTokens <= 0) return undefined;
	const sent = new Set(alreadySent ?? []);
	const pct = (totalTokens / budgetTokens) * 100;
	let result: number | undefined;
	for (const t of BUDGET_NUDGE_THRESHOLDS) {
		if (pct >= t && !sent.has(t)) result = t;
	}
	return result;
}

/** Advisory text for a crossed budget threshold — never stops the workflow. */
export function formatBudgetNudge(
	percent: number,
	totalTokens: number,
	budgetTokens: number,
	nextStep?: { index: number; agent: string },
): string {
	const remaining = Math.max(0, budgetTokens - totalTokens);
	const next = nextStep
		? `Next ready step: #${nextStep.index + 1} (${nextStep.agent}).`
		: "No further steps queued.";
	return `Workflow budget nudge: ~${percent}% of the ${budgetTokens}-token budget used (${totalTokens} tokens so far, ~${remaining} remaining). ${next} Advisory only — the workflow keeps running.`;
}

/**
 * Update workflow state with step result
 */
export function updateWorkflowState(
	state: WorkflowState,
	stepIndex: number,
	update: Partial<WorkflowStepResult>,
): WorkflowState {
	const results = [...state.results];
	results[stepIndex] = { ...results[stepIndex], ...update };

	return {
		...state,
		results,
	};
}

/**
 * Mark workflow as completed
 */
export function completeWorkflow(state: WorkflowState): WorkflowState {
	return {
		...state,
		status: "completed",
		endTime: Date.now(),
	};
}

/**
 * Mark workflow as failed
 */
export function failWorkflow(
	state: WorkflowState,
	error: string,
): WorkflowState {
	return {
		...state,
		status: "failed",
		endTime: Date.now(),
		error,
	};
}

/**
 * Mark workflow as paused (waiting for approval)
 */
export function pauseWorkflow(state: WorkflowState): WorkflowState {
	return {
		...state,
		status: "paused",
	};
}

/**
 * Resume workflow from paused state
 */
export function resumeWorkflow(state: WorkflowState): WorkflowState {
	return {
		...state,
		status: "running",
	};
}

/**
 * First step (by stepIndex) that has not reached a terminal status
 * (completed/skipped/failed). Used by resume_workflow to pick up where a
 * paused/interrupted workflow left off.
 */
export function getFirstIncompleteStepIndex(state: WorkflowState): number {
	for (let i = 0; i < state.results.length; i++) {
		const status = state.results[i].status;
		if (status !== "completed" && status !== "skipped" && status !== "failed") {
			return i;
		}
	}
	return state.results.length;
}

/**
 * Prepare a (paused/failed/completed) workflow state for re-execution.
 * Steps strictly before `fromStep` keep their results; steps at and after it are
 * reset to pending (output/error/retryCount cleared). If `fromStep` lands
 * mid-group, the reset is widened to the start of that step's whole
 * parallelGroup so an interrupted parallel group re-runs together.
 */
export function prepareResume(
	state: WorkflowState,
	fromStep?: number,
): WorkflowState {
	const start = Math.max(
		0,
		fromStep === undefined ? getFirstIncompleteStepIndex(state) : fromStep,
	);

	// If the resume point lands mid-group, widen to the group start.
	let effectiveStart = start;
	if (start < state.steps.length && state.steps[start].parallelGroup) {
		let groupStart = start;
		while (
			groupStart > 0 &&
			state.steps[groupStart - 1].parallelGroup ===
				state.steps[start].parallelGroup
		) {
			groupStart--;
		}
		effectiveStart = groupStart;
	}

	const results = state.results.map((r) => {
		if (r.stepIndex >= effectiveStart) {
			return {
				step: r.step,
				stepIndex: r.stepIndex,
				status: "pending",
				approvalGranted: r.approvalGranted,
				startTime: undefined,
			} as WorkflowStepResult;
		}
		return r;
	});

	return {
		...state,
		results,
		currentStepIndex: effectiveStart,
		status: "running",
		endTime: undefined,
		error: undefined,
		resumedFromStepIndex: effectiveStart,
		resumedAt: Date.now(),
	};
}

/**
 * Workflow state for hydration: if a previously persisted running/paused state
 * is loaded into a fresh session, mark it paused rather than auto-resuming.
 * Mirrors monitor's "never auto-restart on hydration" rule.
 */
export function hydrateWorkflowState(state: WorkflowState): WorkflowState {
	if (state.status === "running" || state.status === "paused") {
		return {
			...state,
			status: "paused",
			error: state.error ?? "Interrupted by session restart",
		};
	}
	return state;
}

export function getWorkflowSummary(state: WorkflowState): string {
	const completed = state.results.filter((r) => r.status === "completed").length;
	const failed = state.results.filter((r) => r.status === "failed").length;
	const skipped = state.results.filter((r) => r.status === "skipped").length;
	const duration = state.endTime
		? state.endTime - state.startTime
		: Date.now() - state.startTime;

	let summary = `Workflow ${state.name ?? state.id}`;
	summary += `\nStatus: ${state.status}`;
	summary += `\nSteps: ${completed}/${state.steps.length} completed`;
	if (failed > 0) summary += `, ${failed} failed`;
	if (skipped > 0) summary += `, ${skipped} skipped`;
	summary += `\nDuration: ${Math.round(duration / 1000)}s`;

	return summary;
}
