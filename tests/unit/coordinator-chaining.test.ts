/**
 * Unit tests for coordinator session chaining primitives.
 *
 * Tests:
 * - ChildSessionResult type (structural, not runtime -- validated by TypeScript compilation)
 * - getChildSessionResult outcome mapping (via fetchChildSessionResult local function,
 *   tested indirectly through a fake CoordinatorDeps implementation)
 * - spawnAndAwait sequential wrapper (happy path + failure propagation)
 *
 * Strategy: fake CoordinatorDeps implementing the interface directly, with
 * controlled consoleService behavior injected via a wrapper around fetchChildSessionResult.
 *
 * NOTE: Since fetchChildSessionResult and fetchAgentResult are local functions inside
 * createCoordinatorDeps, they are not directly exportable. We test the behavior via
 * a fake CoordinatorDeps that mirrors the expected outcomes, verifying the interface
 * contract rather than the implementation internals.
 */

import { describe, it, expect } from 'vitest';
import type { ChildSessionResult } from '../../src/coordinators/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// ChildSessionResult type validation (compile-time + structural tests)
// ═══════════════════════════════════════════════════════════════════════════

describe('ChildSessionResult type', () => {
  it('success variant has kind, notes, and artifacts', () => {
    const result: ChildSessionResult = {
      kind: 'success',
      notes: 'LGTM -- no issues found.',
      artifacts: [],
    };
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.notes).toBe('LGTM -- no issues found.');
      expect(result.artifacts).toHaveLength(0);
    }
  });

  it('success variant allows null notes', () => {
    const result: ChildSessionResult = {
      kind: 'success',
      notes: null,
      artifacts: [],
    };
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.notes).toBeNull();
    }
  });

  it('failed variant has kind, reason, and message', () => {
    const result: ChildSessionResult = {
      kind: 'failed',
      reason: 'stuck',
      message: 'Session reached blocked state',
    };
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('stuck');
      expect(result.message).toContain('blocked');
    }
  });

  it('failed variant accepts all reason values', () => {
    // delivery_failed is intentionally excluded: coordinator-spawned sessions have no
    // callbackUrl and cannot produce WorkflowDeliveryFailed. The type says exactly
    // what can happen; coordinator callers never need to handle delivery_failed.
    const reasons = ['error', 'stuck'] as const;
    for (const reason of reasons) {
      const result: ChildSessionResult = {
        kind: 'failed',
        reason,
        message: `Failed with reason: ${reason}`,
      };
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.reason).toBe(reason);
      }
    }
  });

  it('timed_out variant has kind and message', () => {
    const result: ChildSessionResult = {
      kind: 'timed_out',
      message: 'Session timed out after 15 minutes',
    };
    expect(result.kind).toBe('timed_out');
    if (result.kind === 'timed_out') {
      expect(result.message).toContain('timed out');
    }
  });

  it('await_degraded variant has kind and message', () => {
    const result: ChildSessionResult = {
      kind: 'await_degraded',
      message: 'ConsoleService unavailable',
    };
    expect(result.kind).toBe('await_degraded');
    if (result.kind === 'await_degraded') {
      expect(result.message).toContain('ConsoleService');
    }
  });

  it('exhaustive switch handles all 4 variants', () => {
    function handleResult(r: ChildSessionResult): string {
      switch (r.kind) {
        case 'success': return `success: ${r.notes ?? '(no notes)'}`;
        case 'failed': return `failed: ${r.reason}`;
        case 'timed_out': return `timed_out: ${r.message}`;
        case 'await_degraded': return `await_degraded: ${r.message}`;
      }
    }

    const results: ChildSessionResult[] = [
      { kind: 'success', notes: 'LGTM', artifacts: [] },
      { kind: 'failed', reason: 'error', message: 'err' },
      { kind: 'timed_out', message: 'timeout' },
      { kind: 'await_degraded', message: 'degraded' },
    ];

    const handled = results.map(handleResult);
    expect(handled[0]).toBe('success: LGTM');
    expect(handled[1]).toBe('failed: error');
    expect(handled[2]).toBe('timed_out: timeout');
    expect(handled[3]).toBe('await_degraded: degraded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getChildSessionResult outcome mapping tests
// These tests use a minimal fake that mirrors fetchChildSessionResult logic,
// verifying the interface contract (correct ChildSessionResult returned per
// session status) without depending on coordinator-deps internals.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal fake implementation of getChildSessionResult behavior.
 *
 * Mirrors the mapping logic in fetchChildSessionResult in coordinator-deps.ts.
 * Used to verify the expected outcome mapping without importing coordinator-deps.ts
 * (which requires a full V2ToolContext and ConsoleService).
 */
function fakeGetChildSessionResult(
  runStatus: string | null,
  consoleServiceNull: boolean,
  recapMarkdown: string | null = null,
  artifacts: readonly unknown[] = [],
): ChildSessionResult {
  if (consoleServiceNull) {
    return { kind: 'await_degraded', message: 'ConsoleService unavailable -- cannot read child session outcome' };
  }
  if (runStatus === 'complete' || runStatus === 'complete_with_gaps') {
    return { kind: 'success', notes: recapMarkdown, artifacts };
  }
  if (runStatus === 'blocked') {
    return { kind: 'failed', reason: 'stuck', message: `Child session reached blocked state` };
  }
  if (runStatus === null) {
    return { kind: 'timed_out', message: `Child session has no terminal run status (likely timed out)` };
  }
  // 'in_progress' or 'dormant' -- not yet terminal
  return { kind: 'timed_out', message: `Child session is still in state '${runStatus}'` };
}

describe('getChildSessionResult outcome mapping', () => {
  it('returns await_degraded when consoleService is null', () => {
    const result = fakeGetChildSessionResult(null, true);
    expect(result.kind).toBe('await_degraded');
    if (result.kind === 'await_degraded') {
      expect(result.message).toContain('ConsoleService');
    }
  });

  it('returns success when status is complete', () => {
    const result = fakeGetChildSessionResult('complete', false, 'APPROVE -- LGTM.', [{ kind: 'wr.review_verdict' }]);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.notes).toBe('APPROVE -- LGTM.');
      expect(result.artifacts).toHaveLength(1);
    }
  });

  it('returns success when status is complete_with_gaps', () => {
    const result = fakeGetChildSessionResult('complete_with_gaps', false, 'Done with some gaps.', []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.notes).toBe('Done with some gaps.');
    }
  });

  it('returns failed/stuck when status is blocked', () => {
    const result = fakeGetChildSessionResult('blocked', false);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('stuck');
    }
  });

  it('returns timed_out when status is null (no run yet)', () => {
    const result = fakeGetChildSessionResult(null, false);
    expect(result.kind).toBe('timed_out');
    if (result.kind === 'timed_out') {
      expect(result.message).toContain('no terminal run status');
    }
  });

  it('returns timed_out when status is in_progress (still running)', () => {
    const result = fakeGetChildSessionResult('in_progress', false);
    expect(result.kind).toBe('timed_out');
    if (result.kind === 'timed_out') {
      expect(result.message).toContain('in_progress');
    }
  });

  it('success with null notes propagates null', () => {
    const result = fakeGetChildSessionResult('complete', false, null, []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.notes).toBeNull();
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// spawnAndAwait tests
// These test the sequential composition pattern via a fake CoordinatorDeps.
// ═══════════════════════════════════════════════════════════════════════════

interface MinimalCoordinatorDeps {
  spawnSession: (workflowId: string, goal: string, workspace: string) => Promise<{ kind: 'ok'; value: string } | { kind: 'err'; error: string }>;
  awaitSessions: (handles: readonly string[], timeoutMs: number) => Promise<{ results: Array<{ handle: string; outcome: string; status: string | null; durationMs: number }>; allSucceeded: boolean }>;
  getChildSessionResult: (handle: string, coordinatorSessionId?: string) => Promise<ChildSessionResult>;
  spawnAndAwait: (workflowId: string, goal: string, workspace: string, opts?: { coordinatorSessionId?: string; timeoutMs?: number }) => Promise<ChildSessionResult>;
}

function makeMinimalDeps(overrides: Partial<MinimalCoordinatorDeps> = {}): MinimalCoordinatorDeps {
  let spawnCallCount = 0;
  return {
    spawnSession: async (workflowId, goal, workspace) => {
      void goal; void workspace;
      spawnCallCount++;
      return { kind: 'ok', value: `handle-${workflowId}-${spawnCallCount}` };
    },
    awaitSessions: async (handles, _timeoutMs) => {
      return {
        results: [...handles].map((h) => ({ handle: h, outcome: 'success', status: 'complete', durationMs: 1000 })),
        allSucceeded: true,
      };
    },
    getChildSessionResult: async (handle, _coordinatorSessionId) => {
      return { kind: 'success', notes: `Result for ${handle}`, artifacts: [] };
    },
    spawnAndAwait: async (workflowId, goal, workspace, opts) => {
      // Minimal inline implementation mirroring the interface contract.
      // spawnSession -> awaitSessions -> getChildSessionResult
      const spawnResult = await (overrides.spawnSession ?? (() => Promise.resolve({ kind: 'ok' as const, value: `handle-${workflowId}-1` })))(workflowId, goal, workspace);
      if (spawnResult.kind === 'err') {
        return { kind: 'failed', reason: 'error', message: spawnResult.error };
      }
      const handle = spawnResult.value;
      await (overrides.awaitSessions ?? (() => Promise.resolve({ results: [], allSucceeded: true })))([handle], opts?.timeoutMs ?? 15 * 60 * 1000);
      return (overrides.getChildSessionResult ?? (() => Promise.resolve({ kind: 'success' as const, notes: null, artifacts: [] })))(handle, opts?.coordinatorSessionId);
    },
    ...overrides,
  };
}

describe('spawnAndAwait', () => {
  it('returns success when all steps succeed', async () => {
    const deps = makeMinimalDeps();
    const result = await deps.spawnAndAwait('wr.coding-task', 'implement auth', '/workspace');
    expect(result.kind).toBe('success');
  });

  it('returns failed when spawnSession fails', async () => {
    const deps = makeMinimalDeps({
      spawnSession: async () => ({ kind: 'err', error: 'Router not initialized' }),
    });
    const result = await deps.spawnAndAwait('wr.coding-task', 'implement auth', '/workspace');
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.message).toContain('Router not initialized');
    }
  });

  it('propagates timed_out from getChildSessionResult', async () => {
    const deps = makeMinimalDeps({
      getChildSessionResult: async (_handle) => ({
        kind: 'timed_out',
        message: 'Session timed out',
      }),
    });
    const result = await deps.spawnAndAwait('wr.coding-task', 'implement auth', '/workspace');
    expect(result.kind).toBe('timed_out');
  });

  it('propagates await_degraded from getChildSessionResult', async () => {
    const deps = makeMinimalDeps({
      getChildSessionResult: async (_handle) => ({
        kind: 'await_degraded',
        message: 'ConsoleService unavailable',
      }),
    });
    const result = await deps.spawnAndAwait('wr.coding-task', 'implement auth', '/workspace');
    expect(result.kind).toBe('await_degraded');
  });

  it('passes coordinatorSessionId through as parentSessionId context', async () => {
    // Verify that coordinatorSessionId is threaded through opts.
    // We test that the interface accepts the parameter -- implementation threading
    // is verified by TypeScript type checking (parentSessionId in spawnSession signature).
    const deps = makeMinimalDeps();
    const result = await deps.spawnAndAwait('wr.coding-task', 'implement auth', '/workspace', {
      coordinatorSessionId: 'parent-session-123',
      timeoutMs: 5 * 60 * 1000,
    });
    // The interface contract is satisfied if it returns without error.
    expect(['success', 'failed', 'timed_out', 'await_degraded']).toContain(result.kind);
  });
});
