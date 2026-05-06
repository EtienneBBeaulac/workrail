/**
 * TerminalSignal discriminated union and the setTerminalSignal gate.
 *
 * WHY a separate module: TerminalSignal and its gate function are the most
 * invariant-critical piece of SessionState. Isolating them makes the
 * constraint visible and keeps the architecture test target narrow.
 *
 * WHY first-writer-wins: invariant 1.4 (stuck takes priority over timeout)
 * is enforced structurally. The first signal set is authoritative; all
 * subsequent calls are silent no-ops. This replaces scattered
 * `if (state.stuckReason === null)` guards with a single named setter.
 *
 * WHY this module has no node: or SDK imports: it is part of the functional
 * core. It must be importable in any test context without I/O stubs.
 */

import type { SessionState } from './session-state.js';

/**
 * The terminal signal that ended a workflow session.
 *
 * WHY a discriminated union (not stuckReason + timeoutReason separately):
 * Two independent nullable fields that must never both be set is a textbook
 * "illegal state representable" violation. This union makes stuck AND timeout
 * simultaneously structurally impossible.
 */
export type TerminalSignal =
  | { readonly kind: 'stuck'; readonly reason: 'repeated_tool_call' | 'no_progress' | 'stall' }
  | { readonly kind: 'timeout'; readonly reason: 'wall_clock' | 'max_turns' };

/**
 * Set the terminal signal for a session (first-writer-wins).
 *
 * WHY first-writer-wins: invariant 1.4 requires stuck to take priority over
 * timeout. Rather than requiring every mutation site to check the current value,
 * this setter enforces the invariant in one place. The first signal set is the
 * authoritative terminal reason; all subsequent calls are no-ops.
 *
 * WHY returns boolean: callers that want to abort only when they were the first
 * writer can branch on the return value instead of reading back the field.
 * Avoids the fragile `state.terminalSignal?.reason === X` pattern at call sites.
 *
 * WHY a plain function (not a class method): SessionState is a plain object.
 * A free function keeps the mutation surface explicit without introducing a
 * class wrapper. The convention is: only call setTerminalSignal() -- never
 * write state.terminalSignal directly.
 *
 * @returns true if the signal was set (this call was the first writer), false if
 *   a prior signal already existed (this call was a no-op).
 */
export function setTerminalSignal(state: SessionState, signal: TerminalSignal): boolean {
  if (state.terminalSignal === null) {
    state.terminalSignal = signal;
    return true;
  }
  return false;
}
