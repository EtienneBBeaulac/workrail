/**
 * Unit tests for stuck detection heuristics in workflow-runner.ts.
 *
 * The turn_end subscriber and its stuck detection logic are inline closures
 * inside runWorkflow() and are not exported directly. These tests replicate
 * the logic to document the invariants and prevent regression.
 *
 * WHY replicate instead of extract: the subscriber is an intentional closure
 * over many local variables (turnCount, stepAdvanceCount, timeoutReason, etc.).
 * Extracting it purely for testability would require threading all those
 * variables as parameters, which would be a significant API change. These tests
 * document the contract instead -- same approach as cli-worktrain-logs.test.ts.
 *
 * Tests cover:
 * - Signal 3 (timeout_imminent) fires for max_turns path (Bug #559 fix)
 * - Signal 3 fires for wall_clock path (pre-existing behavior)
 * - Signal 3 does NOT fire when timeoutReason is null
 * - max_turns block exit condition
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Replicated turn_end subscriber logic
// (mirrors the relevant parts of the turn_end subscriber in workflow-runner.ts)
// ---------------------------------------------------------------------------

interface StuckEvent {
  kind: 'agent_stuck';
  sessionId: string;
  reason: string;
  detail: string;
}

interface SimulatedSubscriberState {
  turnCount: number;
  maxTurns: number;
  timeoutReason: 'wall_clock' | 'max_turns' | null;
  stepAdvanceCount: number;
}

interface SimulatedSubscriberResult {
  emittedEvents: StuckEvent[];
  aborted: boolean;
  returned: boolean; // subscriber returned early (max_turns or other early exit)
}

/**
 * Simulates one invocation of the turn_end subscriber's core logic.
 *
 * Replicates:
 *  - turnCount increment
 *  - max_turns check (includes timeout_imminent emit -- Bug #559 fix)
 *  - Signal 3 check (wall_clock path)
 *
 * Does NOT replicate Signal 1 (repeated_tool_call) or Signal 2 (no_progress)
 * as they are orthogonal to the timeout_imminent fix.
 */
function simulateTurnEnd(state: SimulatedSubscriberState): SimulatedSubscriberResult {
  const emittedEvents: StuckEvent[] = [];
  let aborted = false;
  let returned = false;

  const sessionId = 'test-session-id';

  // Replicate: turnCount++
  state.turnCount++;

  // Replicate: max-turn limit check (with Bug #559 fix inline emit)
  if (state.maxTurns > 0 && state.turnCount >= state.maxTurns && state.timeoutReason === null) {
    state.timeoutReason = 'max_turns';
    // WHY emit here: the return below exits before Signal 3 can run (Bug #559 fix).
    emittedEvents.push({
      kind: 'agent_stuck',
      sessionId,
      reason: 'timeout_imminent',
      detail: 'Max-turn limit reached',
    });
    aborted = true;
    returned = true;
    return { emittedEvents, aborted, returned };
  }

  // Replicate: Signal 3 -- wall-clock timeout path only
  if (state.timeoutReason !== null) {
    emittedEvents.push({
      kind: 'agent_stuck',
      sessionId,
      reason: 'timeout_imminent',
      detail: `${state.timeoutReason === 'wall_clock' ? 'Wall-clock timeout' : 'Max-turn limit'} reached`,
    });
  }

  return { emittedEvents, aborted, returned };
}

// ---------------------------------------------------------------------------
// Tests: timeout_imminent signal
// ---------------------------------------------------------------------------

describe('workflow-runner stuck detection: timeout_imminent (Signal 3)', () => {
  describe('max_turns path (Bug #559 fix)', () => {
    it('emits timeout_imminent when turnCount reaches maxTurns', () => {
      const state: SimulatedSubscriberState = {
        turnCount: 9,
        maxTurns: 10,
        timeoutReason: null,
        stepAdvanceCount: 0,
      };

      const result = simulateTurnEnd(state);

      expect(result.emittedEvents).toHaveLength(1);
      expect(result.emittedEvents[0]).toMatchObject({
        kind: 'agent_stuck',
        reason: 'timeout_imminent',
        detail: 'Max-turn limit reached',
      });
    });

    it('aborts and returns early (does not fall through to Signal 3 check)', () => {
      const state: SimulatedSubscriberState = {
        turnCount: 9,
        maxTurns: 10,
        timeoutReason: null,
        stepAdvanceCount: 0,
      };

      const result = simulateTurnEnd(state);

      expect(result.aborted).toBe(true);
      expect(result.returned).toBe(true);
      // Only ONE timeout_imminent event -- not double-emitted via Signal 3
      expect(result.emittedEvents.filter((e) => e.reason === 'timeout_imminent')).toHaveLength(1);
    });

    it('sets timeoutReason to max_turns before emitting', () => {
      const state: SimulatedSubscriberState = {
        turnCount: 9,
        maxTurns: 10,
        timeoutReason: null,
        stepAdvanceCount: 0,
      };

      simulateTurnEnd(state);

      expect(state.timeoutReason).toBe('max_turns');
    });

    it('does NOT emit timeout_imminent when wall_clock already fired (first-writer-wins)', () => {
      // If wall_clock already set timeoutReason, the max_turns guard (=== null) skips it.
      const state: SimulatedSubscriberState = {
        turnCount: 9,
        maxTurns: 10,
        timeoutReason: 'wall_clock', // wall_clock fired first
        stepAdvanceCount: 0,
      };

      const result = simulateTurnEnd(state);

      // Signal 3 fires for wall_clock, not max_turns block
      expect(result.aborted).toBe(false);
      expect(result.returned).toBe(false);
      const timeoutEvents = result.emittedEvents.filter((e) => e.reason === 'timeout_imminent');
      expect(timeoutEvents).toHaveLength(1);
      expect(timeoutEvents[0]?.detail).toBe('Wall-clock timeout reached');
    });

    it('does NOT emit when turnCount is below maxTurns', () => {
      const state: SimulatedSubscriberState = {
        turnCount: 7,
        maxTurns: 10,
        timeoutReason: null,
        stepAdvanceCount: 0,
      };

      const result = simulateTurnEnd(state);

      expect(result.aborted).toBe(false);
      expect(result.emittedEvents.filter((e) => e.reason === 'timeout_imminent')).toHaveLength(0);
    });
  });

  describe('wall_clock path (pre-existing behavior)', () => {
    it('emits timeout_imminent via Signal 3 when wall_clock timeout has fired', () => {
      // Simulate: wall_clock timeout fires (sets timeoutReason externally),
      // then a subsequent turn_end fires.
      const state: SimulatedSubscriberState = {
        turnCount: 5,
        maxTurns: 10, // not reached yet
        timeoutReason: 'wall_clock', // set by setTimeout callback
        stepAdvanceCount: 0,
      };

      const result = simulateTurnEnd(state);

      expect(result.emittedEvents).toHaveLength(1);
      expect(result.emittedEvents[0]).toMatchObject({
        kind: 'agent_stuck',
        reason: 'timeout_imminent',
        detail: 'Wall-clock timeout reached',
      });
    });

    it('does NOT abort from the max_turns block when wall_clock fires', () => {
      const state: SimulatedSubscriberState = {
        turnCount: 5,
        maxTurns: 10,
        timeoutReason: 'wall_clock',
        stepAdvanceCount: 0,
      };

      const result = simulateTurnEnd(state);

      // The max_turns block is skipped (timeoutReason !== null), so no early abort
      expect(result.aborted).toBe(false);
    });
  });

  describe('no timeout (normal operation)', () => {
    it('does NOT emit timeout_imminent when timeoutReason is null and maxTurns not reached', () => {
      const state: SimulatedSubscriberState = {
        turnCount: 3,
        maxTurns: 10,
        timeoutReason: null,
        stepAdvanceCount: 2,
      };

      const result = simulateTurnEnd(state);

      expect(result.emittedEvents.filter((e) => e.reason === 'timeout_imminent')).toHaveLength(0);
    });

    it('does NOT abort when no limit is hit', () => {
      const state: SimulatedSubscriberState = {
        turnCount: 3,
        maxTurns: 10,
        timeoutReason: null,
        stepAdvanceCount: 2,
      };

      const result = simulateTurnEnd(state);

      expect(result.aborted).toBe(false);
    });
  });
});
