/**
 * Unit tests for the named state transitions in src/daemon/state/session-state.ts.
 *
 * WHY these tests: the named transitions replace scattered direct field writes.
 * Each transition either enforces a nontrivial invariant or combines related
 * writes atomically. These tests verify the atomic-write and ring-buffer
 * invariants that the transitions exist to protect.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  advanceStep,
  recordCompletion,
  updateToken,
  setSessionId,
  recordToolCall,
} from '../../src/daemon/state/session-state.js';

describe('createSessionState', () => {
  it('returns a fresh state with correct zero values', () => {
    const state = createSessionState('initial-token');
    expect(state.currentContinueToken).toBe('initial-token');
    expect(state.isComplete).toBe(false);
    expect(state.lastStepNotes).toBeUndefined();
    expect(state.lastStepArtifacts).toBeUndefined();
    expect(state.workrailSessionId).toBeNull();
    expect(state.stepAdvanceCount).toBe(0);
    expect(state.lastNToolCalls).toEqual([]);
    expect(state.issueSummaries).toEqual([]);
    expect(state.pendingSteerParts).toEqual([]);
    expect(state.terminalSignal).toBeNull();
    expect(state.turnCount).toBe(0);
  });
});

describe('advanceStep', () => {
  it('pushes step text to steer queue, increments count, and updates token atomically', () => {
    const state = createSessionState('token-0');
    advanceStep(state, 'Step 1 text', 'token-1');

    expect(state.pendingSteerParts).toEqual(['Step 1 text']);
    expect(state.stepAdvanceCount).toBe(1);
    expect(state.currentContinueToken).toBe('token-1');
  });

  it('accumulates multiple advances without losing earlier values', () => {
    const state = createSessionState('token-0');
    advanceStep(state, 'Step 1', 'token-1');
    advanceStep(state, 'Step 2', 'token-2');

    expect(state.pendingSteerParts).toEqual(['Step 1', 'Step 2']);
    expect(state.stepAdvanceCount).toBe(2);
    expect(state.currentContinueToken).toBe('token-2');
  });

  it('only writes all three fields -- does not clobber other state', () => {
    const state = createSessionState('token-0');
    state.turnCount = 5; // set separately
    advanceStep(state, 'Step 1', 'token-1');

    // turnCount should not be affected
    expect(state.turnCount).toBe(5);
    expect(state.isComplete).toBe(false);
  });
});

describe('recordCompletion', () => {
  it('sets isComplete + lastStepNotes + lastStepArtifacts atomically', () => {
    const state = createSessionState('token');
    const artifacts = [{ kind: 'test' }];
    recordCompletion(state, 'Final notes', artifacts);

    expect(state.isComplete).toBe(true);
    expect(state.lastStepNotes).toBe('Final notes');
    expect(state.lastStepArtifacts).toEqual(artifacts);
  });

  it('accepts undefined notes and undefined artifacts', () => {
    const state = createSessionState('token');
    recordCompletion(state, undefined);

    expect(state.isComplete).toBe(true);
    expect(state.lastStepNotes).toBeUndefined();
    expect(state.lastStepArtifacts).toBeUndefined();
  });

  it('does not clobber other fields', () => {
    const state = createSessionState('token');
    state.stepAdvanceCount = 3;
    recordCompletion(state, 'done');

    expect(state.stepAdvanceCount).toBe(3);
    expect(state.currentContinueToken).toBe('token');
  });
});

describe('updateToken', () => {
  it('updates only currentContinueToken', () => {
    const state = createSessionState('old-token');
    state.stepAdvanceCount = 2;
    updateToken(state, 'retry-token');

    expect(state.currentContinueToken).toBe('retry-token');
    expect(state.stepAdvanceCount).toBe(2); // unchanged
    expect(state.pendingSteerParts).toEqual([]); // unchanged
  });
});

describe('setSessionId', () => {
  it('sets workrailSessionId from null', () => {
    const state = createSessionState('token');
    expect(state.workrailSessionId).toBeNull();
    setSessionId(state, 'sess_abc123');
    expect(state.workrailSessionId).toBe('sess_abc123');
  });

  it('does not affect other fields', () => {
    const state = createSessionState('token');
    state.turnCount = 7;
    setSessionId(state, 'sess_xyz');
    expect(state.turnCount).toBe(7);
  });
});

describe('recordToolCall (ring buffer)', () => {
  it('pushes a tool call and trims to threshold', () => {
    const state = createSessionState('token');
    recordToolCall(state, 'bash', 'args1', 3);
    recordToolCall(state, 'read', 'args2', 3);
    recordToolCall(state, 'bash', 'args3', 3);

    // Buffer is now full at threshold=3
    expect(state.lastNToolCalls).toHaveLength(3);
    expect(state.lastNToolCalls[0]).toEqual({ toolName: 'bash', argsSummary: 'args1' });
    expect(state.lastNToolCalls[2]).toEqual({ toolName: 'bash', argsSummary: 'args3' });
  });

  it('evicts oldest entry when threshold is exceeded', () => {
    const state = createSessionState('token');
    recordToolCall(state, 'bash', 'args1', 3);
    recordToolCall(state, 'read', 'args2', 3);
    recordToolCall(state, 'write', 'args3', 3);
    // Exceeds threshold -- args1 is evicted
    recordToolCall(state, 'bash', 'args4', 3);

    expect(state.lastNToolCalls).toHaveLength(3);
    expect(state.lastNToolCalls[0]).toEqual({ toolName: 'read', argsSummary: 'args2' });
    expect(state.lastNToolCalls[2]).toEqual({ toolName: 'bash', argsSummary: 'args4' });
  });

  it('respects the exact threshold -- no off-by-one', () => {
    const state = createSessionState('token');
    const threshold = 3;
    for (let i = 1; i <= threshold; i++) {
      recordToolCall(state, `tool${i}`, `args${i}`, threshold);
    }
    expect(state.lastNToolCalls).toHaveLength(threshold);

    // One more -- still exactly threshold length
    recordToolCall(state, 'toolExtra', 'argsExtra', threshold);
    expect(state.lastNToolCalls).toHaveLength(threshold);
  });
});
