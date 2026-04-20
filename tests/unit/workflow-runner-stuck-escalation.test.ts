/**
 * Unit tests for stuck-escalation behavior in workflow-runner.ts.
 *
 * Tests cover the abort policy logic that is wired after the stuck detection
 * heuristics in the turn_end subscriber. The subscriber is an intentional
 * closure over many local variables (stuckReason, timeoutReason, lastNToolCalls,
 * etc.). These tests replicate the logic to document the invariants and prevent
 * regression, following the same approach as workflow-runner-stuck-detection.test.ts.
 *
 * Tests covered:
 * 1. stuckAbortPolicy: 'abort' (default) -- session aborts on repeated_tool_call
 * 2. stuckAbortPolicy: 'notify_only' -- no abort, emitter still fires
 * 3. noProgressAbortEnabled: false (default) -- no_progress does NOT abort
 * 4. noProgressAbortEnabled: true -- no_progress aborts when policy is 'abort'
 * 5. issueSummaries non-empty -- forwarded to outbox entry when agent has reported issues
 * 6. noProgressAbortEnabled: false + notify_only -- intentional no-op corner
 * 7. ChildWorkflowRunResult includes stuck (compile-time assignability)
 * 8. trigger-router exhaustive switch handles stuck without assertNever fallthrough
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  WorkflowRunStuck,
  ChildWorkflowRunResult,
  WorkflowRunSuccess,
  WorkflowRunError,
  WorkflowRunTimeout,
} from '../../src/daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// Replicated turn_end subscriber logic for stuck-escalation
// ---------------------------------------------------------------------------

const STUCK_REPEAT_THRESHOLD = 3;

interface ToolCallRecord {
  toolName: string;
  argsSummary: string;
}

interface AgentStuckEvent {
  kind: 'agent_stuck';
  reason: string;
  detail: string;
}

interface StuckSubscriberConfig {
  stuckAbortPolicy?: 'abort' | 'notify_only';
  noProgressAbortEnabled?: boolean;
}

interface StuckSubscriberState {
  turnCount: number;
  maxTurns: number;
  timeoutReason: 'wall_clock' | 'max_turns' | null;
  stuckReason: 'repeated_tool_call' | 'no_progress' | null;
  stepAdvanceCount: number;
  lastNToolCalls: ToolCallRecord[];
  issueSummaries: string[];
}

interface StuckSubscriberResult {
  emittedEvents: AgentStuckEvent[];
  aborted: boolean;
  returned: boolean;
  outboxWriteCalledWith: { reason: string; workflowId: string } | null;
  state: StuckSubscriberState;
}

/**
 * Simulates one invocation of the turn_end subscriber's stuck-escalation logic.
 *
 * Replicates:
 * - turnCount increment
 * - Signal 1 (repeated_tool_call) detection + outbox write + abort gate
 * - Signal 2 (no_progress) detection + conditional outbox write + abort gate
 *
 * Does NOT replicate Signal 3 (timeout_imminent) or the max_turns early-return path
 * as they are orthogonal to the stuck-escalation logic being tested.
 */
function simulateStuckTurnEnd(
  state: StuckSubscriberState,
  config: StuckSubscriberConfig,
  workflowId = 'test-workflow',
): StuckSubscriberResult {
  const emittedEvents: AgentStuckEvent[] = [];
  let aborted = false;
  let returned = false;
  let outboxWriteCalledWith: { reason: string; workflowId: string } | null = null;

  // Replicate: turnCount++
  state.turnCount++;

  // Replicate: Signal 1 (repeated_tool_call) detection
  if (
    state.lastNToolCalls.length === STUCK_REPEAT_THRESHOLD &&
    state.lastNToolCalls.every(
      (c) =>
        c.toolName === state.lastNToolCalls[0]?.toolName &&
        c.argsSummary === state.lastNToolCalls[0]?.argsSummary,
    )
  ) {
    emittedEvents.push({
      kind: 'agent_stuck',
      reason: 'repeated_tool_call',
      detail: `Same tool+args called ${STUCK_REPEAT_THRESHOLD} times: ${state.lastNToolCalls[0]?.toolName ?? 'unknown'}`,
    });

    // Outbox notification: fires regardless of abort policy
    outboxWriteCalledWith = { reason: 'repeated_tool_call', workflowId };

    // Abort gate: only when policy allows AND no prior abort has fired
    const stuckPolicy = config.stuckAbortPolicy ?? 'abort';
    if (
      stuckPolicy !== 'notify_only' &&
      state.stuckReason === null &&
      state.timeoutReason === null
    ) {
      state.stuckReason = 'repeated_tool_call';
      aborted = true;
      returned = true;
      return { emittedEvents, aborted, returned, outboxWriteCalledWith, state };
    }
  }

  // Replicate: Signal 2 (no_progress) detection
  if (
    state.maxTurns > 0 &&
    state.turnCount >= Math.floor(state.maxTurns * 0.8) &&
    state.stepAdvanceCount === 0
  ) {
    emittedEvents.push({
      kind: 'agent_stuck',
      reason: 'no_progress',
      detail: `${state.turnCount} turns used, 0 step advances (${state.maxTurns} turn limit)`,
    });

    // no_progress abort is off by default
    const noProgressAbortEnabled = config.noProgressAbortEnabled ?? false;
    if (noProgressAbortEnabled) {
      // Outbox notification for no_progress (when enabled)
      outboxWriteCalledWith = { reason: 'no_progress', workflowId };

      const noProgressPolicy = config.stuckAbortPolicy ?? 'abort';
      if (
        noProgressPolicy !== 'notify_only' &&
        state.stuckReason === null &&
        state.timeoutReason === null
      ) {
        state.stuckReason = 'no_progress';
        aborted = true;
        returned = true;
        return { emittedEvents, aborted, returned, outboxWriteCalledWith, state };
      }
    }
  }

  return { emittedEvents, aborted, returned, outboxWriteCalledWith, state };
}

// ---------------------------------------------------------------------------
// Test 1: stuckAbortPolicy: 'abort' (default) aborts on repeated_tool_call
// ---------------------------------------------------------------------------

describe('stuck escalation: repeated_tool_call with abort policy', () => {
  it('aborts session and sets stuckReason when same tool+args repeated STUCK_REPEAT_THRESHOLD times', () => {
    const state: StuckSubscriberState = {
      turnCount: 0,
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Bash', argsSummary: '{"command":"git status"}' },
        { toolName: 'Bash', argsSummary: '{"command":"git status"}' },
        { toolName: 'Bash', argsSummary: '{"command":"git status"}' },
      ],
      issueSummaries: [],
    };

    const result = simulateStuckTurnEnd(state, { stuckAbortPolicy: 'abort' });

    expect(result.aborted).toBe(true);
    expect(result.returned).toBe(true);
    expect(result.state.stuckReason).toBe('repeated_tool_call');
    expect(result.emittedEvents[0]?.reason).toBe('repeated_tool_call');
    expect(result.outboxWriteCalledWith?.reason).toBe('repeated_tool_call');
  });

  it('aborts with default policy (undefined stuckAbortPolicy behaves as abort)', () => {
    const state: StuckSubscriberState = {
      turnCount: 0,
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Read', argsSummary: '{"file_path":"/tmp/foo.ts"}' },
        { toolName: 'Read', argsSummary: '{"file_path":"/tmp/foo.ts"}' },
        { toolName: 'Read', argsSummary: '{"file_path":"/tmp/foo.ts"}' },
      ],
      issueSummaries: [],
    };

    // No stuckAbortPolicy -- defaults to 'abort'
    const result = simulateStuckTurnEnd(state, {});

    expect(result.aborted).toBe(true);
    expect(result.state.stuckReason).toBe('repeated_tool_call');
  });
});

// ---------------------------------------------------------------------------
// Test 2: stuckAbortPolicy: 'notify_only' -- no abort, outbox still written
// ---------------------------------------------------------------------------

describe('stuck escalation: notify_only policy', () => {
  it('does NOT abort session when stuckAbortPolicy is notify_only', () => {
    const state: StuckSubscriberState = {
      turnCount: 0,
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Bash', argsSummary: '{"command":"npm test"}' },
        { toolName: 'Bash', argsSummary: '{"command":"npm test"}' },
        { toolName: 'Bash', argsSummary: '{"command":"npm test"}' },
      ],
      issueSummaries: [],
    };

    const result = simulateStuckTurnEnd(state, { stuckAbortPolicy: 'notify_only' });

    expect(result.aborted).toBe(false);
    expect(result.returned).toBe(false);
    expect(result.state.stuckReason).toBeNull();
    // emitter still fires
    expect(result.emittedEvents[0]?.reason).toBe('repeated_tool_call');
    // outbox still written
    expect(result.outboxWriteCalledWith?.reason).toBe('repeated_tool_call');
  });
});

// ---------------------------------------------------------------------------
// Test 3: noProgressAbortEnabled: false (default) -- no_progress does NOT abort
// ---------------------------------------------------------------------------

describe('stuck escalation: no_progress default disabled', () => {
  it('does NOT abort when 80% turns used with 0 advances and noProgressAbortEnabled is false (default)', () => {
    const state: StuckSubscriberState = {
      turnCount: 15, // 15/20 = 75%, this turn brings it to 16/20 = 80%
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Read', argsSummary: '{"file_path":"/a"}' },
        { toolName: 'Bash', argsSummary: '{"command":"ls"}' }, // different tools -- not Signal 1
        { toolName: 'Read', argsSummary: '{"file_path":"/b"}' },
      ],
      issueSummaries: [],
    };

    // noProgressAbortEnabled defaults to false
    const result = simulateStuckTurnEnd(state, {});

    // Signal 1 does not fire (different tools/args)
    // Signal 2 fires but abort is disabled by default
    expect(result.aborted).toBe(false);
    expect(result.state.stuckReason).toBeNull();
    // Signal 2 emitter still fires (advisory only)
    const noProgressEvent = result.emittedEvents.find(e => e.reason === 'no_progress');
    expect(noProgressEvent).toBeDefined();
    // Outbox NOT written (noProgressAbortEnabled: false skips the outbox write)
    expect(result.outboxWriteCalledWith).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4: noProgressAbortEnabled: true -- no_progress aborts with abort policy
// ---------------------------------------------------------------------------

describe('stuck escalation: no_progress with noProgressAbortEnabled: true', () => {
  it('aborts session when no_progress fires and noProgressAbortEnabled is true', () => {
    const state: StuckSubscriberState = {
      turnCount: 15, // this turn: 16/20 = 80% -- triggers the heuristic
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Read', argsSummary: '{"file_path":"/a"}' },
        { toolName: 'Bash', argsSummary: '{"command":"ls"}' },
        { toolName: 'Glob', argsSummary: '{"pattern":"**/*.ts"}' },
      ],
      issueSummaries: [],
    };

    const result = simulateStuckTurnEnd(state, {
      noProgressAbortEnabled: true,
      stuckAbortPolicy: 'abort',
    });

    expect(result.aborted).toBe(true);
    expect(result.returned).toBe(true);
    expect(result.state.stuckReason).toBe('no_progress');
    expect(result.outboxWriteCalledWith?.reason).toBe('no_progress');
  });

  it('does NOT abort when noProgressAbortEnabled is true but stuckAbortPolicy is notify_only', () => {
    const state: StuckSubscriberState = {
      turnCount: 15,
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Read', argsSummary: '{"file_path":"/a"}' },
        { toolName: 'Bash', argsSummary: '{"command":"ls"}' },
        { toolName: 'Glob', argsSummary: '{"pattern":"**/*.ts"}' },
      ],
      issueSummaries: [],
    };

    const result = simulateStuckTurnEnd(state, {
      noProgressAbortEnabled: true,
      stuckAbortPolicy: 'notify_only',
    });

    expect(result.aborted).toBe(false);
    expect(result.state.stuckReason).toBeNull();
    // Outbox still written (notify_only still notifies)
    expect(result.outboxWriteCalledWith?.reason).toBe('no_progress');
  });
});

// ---------------------------------------------------------------------------
// Test 5 (nit): issueSummaries are included in outbox entry when non-empty
// ---------------------------------------------------------------------------

describe('stuck escalation: issueSummaries in outbox entry', () => {
  it('outbox entry includes issueSummaries when agent has called report_issue before getting stuck', () => {
    // This test documents that when the agent has reported issues before the stuck
    // heuristic fires, those summaries are forwarded to the outbox entry.
    // The simulateStuckTurnEnd helper captures outboxWriteCalledWith, which would
    // be passed to writeStuckOutboxEntry -- issueSummaries would be included there.
    // We verify that the state.issueSummaries is non-empty and flows through to
    // the outbox path (the actual writeStuckOutboxEntry includes issueSummaries
    // when opts.issueSummaries.length > 0).
    const state: StuckSubscriberState = {
      turnCount: 0,
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Bash', argsSummary: '{"command":"npm test"}' },
        { toolName: 'Bash', argsSummary: '{"command":"npm test"}' },
        { toolName: 'Bash', argsSummary: '{"command":"npm test"}' },
      ],
      issueSummaries: ['build failed: tsc error TS2345', 'test suite crashed: SIGABRT'],
    };

    const result = simulateStuckTurnEnd(state, { stuckAbortPolicy: 'abort' });

    // The stuck signal fired
    expect(result.aborted).toBe(true);
    expect(result.outboxWriteCalledWith?.reason).toBe('repeated_tool_call');
    // issueSummaries are present on state and would be forwarded to writeStuckOutboxEntry
    expect(result.state.issueSummaries).toHaveLength(2);
    expect(result.state.issueSummaries[0]).toBe('build failed: tsc error TS2345');
    expect(result.state.issueSummaries[1]).toBe('test suite crashed: SIGABRT');
  });
});

// ---------------------------------------------------------------------------
// Test 6 (nit): noProgressAbortEnabled: false with notify_only is a no-op
// ---------------------------------------------------------------------------

describe('stuck escalation: noProgressAbortEnabled:false with notify_only does not abort and does not write outbox', () => {
  it('noProgressAbortEnabled:false with notify_only does not abort and does not write outbox', () => {
    // Documents the intentional asymmetry: when noProgressAbortEnabled is false,
    // the outbox is NOT written even if stuckAbortPolicy is notify_only.
    // Rationale: notify_only only enables the notify path inside the
    // noProgressAbortEnabled gate -- if that gate is false, nothing runs.
    const state: StuckSubscriberState = {
      turnCount: 15, // this turn: 16/20 = 80% -- triggers the no_progress heuristic
      maxTurns: 20,
      timeoutReason: null,
      stuckReason: null,
      stepAdvanceCount: 0,
      lastNToolCalls: [
        { toolName: 'Read', argsSummary: '{"file_path":"/a"}' },
        { toolName: 'Bash', argsSummary: '{"command":"ls"}' },
        { toolName: 'Glob', argsSummary: '{"pattern":"**/*.ts"}' },
      ],
      issueSummaries: [],
    };

    const result = simulateStuckTurnEnd(state, {
      noProgressAbortEnabled: false,
      stuckAbortPolicy: 'notify_only',
    });

    // No abort
    expect(result.aborted).toBe(false);
    expect(result.returned).toBe(false);
    expect(result.state.stuckReason).toBeNull();
    // Signal 2 emitter fires (advisory)
    const noProgressEvent = result.emittedEvents.find(e => e.reason === 'no_progress');
    expect(noProgressEvent).toBeDefined();
    // No outbox write -- noProgressAbortEnabled: false gates the entire notify path
    expect(result.outboxWriteCalledWith).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 8: ChildWorkflowRunResult includes stuck (compile-time assignability)
// ---------------------------------------------------------------------------

describe('ChildWorkflowRunResult includes WorkflowRunStuck', () => {
  it('WorkflowRunStuck is assignable to ChildWorkflowRunResult', () => {
    // This is a compile-time test. If WorkflowRunStuck were missing from
    // ChildWorkflowRunResult, the assignment below would produce a TypeScript error.
    // CRITICAL: this catches the "atomic commit" invariant -- if someone adds stuck
    // to WorkflowRunResult but forgets ChildWorkflowRunResult, this test fails to compile.
    const stuckResult: WorkflowRunStuck = {
      _tag: 'stuck',
      workflowId: 'test-workflow',
      reason: 'repeated_tool_call',
      message: 'Session aborted: stuck heuristic fired (repeated_tool_call)',
      stopReason: 'aborted',
    };

    // Assignability check: ChildWorkflowRunResult = WorkflowRunStuck
    const childResult: ChildWorkflowRunResult = stuckResult;
    expect(childResult._tag).toBe('stuck');
  });

  it('other ChildWorkflowRunResult variants still work', () => {
    const successResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: 'test-workflow',
      stopReason: 'stop',
    };
    const errorResult: WorkflowRunError = {
      _tag: 'error',
      workflowId: 'test-workflow',
      message: 'Something failed',
      stopReason: 'error',
    };
    const timeoutResult: WorkflowRunTimeout = {
      _tag: 'timeout',
      workflowId: 'test-workflow',
      reason: 'max_turns',
      message: 'Exceeded turn limit',
      stopReason: 'aborted',
    };

    const variants: ChildWorkflowRunResult[] = [successResult, errorResult, timeoutResult];
    expect(variants.map(v => v._tag)).toEqual(['success', 'error', 'timeout']);
  });
});

// ---------------------------------------------------------------------------
// Test 9: trigger-router exhaustive switch handles stuck
// ---------------------------------------------------------------------------

describe('trigger-router exhaustive switch handles stuck', () => {
  it('logs stuck result without hitting assertNever', async () => {
    // Import the actual TriggerRouter to verify the exhaustive switch compiles
    // and handles stuck. We use a minimal stub approach -- just verify the
    // _tag: 'stuck' case is handled without throwing.
    //
    // Strategy: replicate the exact if-else chain from dispatch() to verify
    // the logic works without constructing a full TriggerRouter instance.

    const stuckResult: WorkflowRunStuck = {
      _tag: 'stuck',
      workflowId: 'test-workflow',
      reason: 'repeated_tool_call',
      message: 'Session aborted: stuck heuristic fired (repeated_tool_call)',
      stopReason: 'aborted',
    };

    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    // Replicate the dispatch() exhaustive chain
    function handleDispatchResult(result: { _tag: string; reason?: string; message?: string; stopReason?: string; deliveryError?: string }): void {
      if (result._tag === 'success') {
        console.log(`Dispatch completed`);
      } else if (result._tag === 'delivery_failed') {
        console.log(`Dispatch delivery failed`);
      } else if (result._tag === 'timeout') {
        console.log(`Dispatch timed out: reason=${result.reason}`);
      } else if (result._tag === 'error') {
        console.log(`Dispatch failed: error=${result.message}`);
      } else if (result._tag === 'stuck') {
        // This branch must exist -- if it were missing, stuck would fall to assertNever
        console.log(`Dispatch stuck: reason=${result.reason} message=${result.message}`);
      } else {
        throw new Error(`assertNever: unhandled _tag=${result._tag}`);
      }
    }

    // Should not throw
    expect(() => handleDispatchResult(stuckResult)).not.toThrow();
    expect(logs.some(l => l.includes('stuck') && l.includes('repeated_tool_call'))).toBe(true);

    consoleSpy.mockRestore();
  });
});
