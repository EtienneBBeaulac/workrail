import type { SessionState } from '../workflow-runner.js';

/**
 * Drain `state.pendingSteerParts` and inject the combined message into the
 * next agent turn via `agent.steer()`.
 *
 * Pure effect: mutates `state.pendingSteerParts` (clears the array) and calls
 * `agent.steer()`. Does nothing when the queue is empty or the session is
 * complete.
 *
 * WHY extracted: step injection is a single-purpose side effect with a clear
 * input/output contract. Extracting it makes `buildTurnEndSubscriber` readable
 * as a thin composition of named responsibilities.
 */
export function injectPendingSteps(
  state: SessionState,
  agent: { steer(msg: { role: 'user'; content: string; timestamp: number }): void },
): void {
  if (state.pendingSteerParts.length > 0 && !state.isComplete) {
    const joined = state.pendingSteerParts.join('\n\n');
    state.pendingSteerParts.length = 0;
    agent.steer({ role: 'user', content: joined, timestamp: Date.now() });
  }
}
