/**
 * Subagent timeout resolution. Dependency-free so it can be unit-tested in a
 * bare workspace (tests/run-timeout.sh).
 *
 * A per-call `timeoutMs` beats the agent frontmatter's `timeoutMs`, but never
 * goes below the frontmatter's `minTimeoutMs`. The floor exists because the
 * dispatching model picks per-call timeouts without knowing how long the
 * agent's turns take: in pi-bench runs the parent gave `reviewer` 180-300s
 * while single reviewer turns took 100-285s, so it was killed mid-thought
 * with no verdict and then re-dispatched.
 */

export interface AgentTimeoutConfig {
	timeoutMs?: number;
	minTimeoutMs?: number;
}

export function resolveSubagentTimeoutMs(
	callTimeoutMs: number | undefined,
	agent: AgentTimeoutConfig,
): number | undefined {
	const timeout = callTimeoutMs ?? agent.timeoutMs;
	if (timeout === undefined) return undefined;
	const floor = agent.minTimeoutMs;
	return floor !== undefined && floor > 0 ? Math.max(timeout, floor) : timeout;
}
