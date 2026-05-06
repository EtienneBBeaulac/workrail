/**
 * Miscellaneous tests for runner/ module shapes, TurnEndSubscriberContext,
 * and cross-cutting runner concerns.
 */

import { describe, it, expect } from 'vitest';
import type { TurnEndSubscriberContext } from '../../src/daemon/runner/agent-loop-runner.js';
import type { FinalizationContext, SessionOutcome } from '../../src/daemon/runner/runner-types.js';
import { WORKTREES_DIR } from '../../src/daemon/runner/runner-types.js';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// TurnEndSubscriberContext -- type shape verification
// ---------------------------------------------------------------------------

describe('TurnEndSubscriberContext shape', () => {
  it('has all required readonly fields', () => {
    // This test is compile-time verification via assignment.
    // If any field is missing from the type, this assignment will fail to compile.
    const ctx: Omit<TurnEndSubscriberContext, 'agent' | 'state'> = {
      stuckConfig: {
        maxTurns: 200,
        stuckAbortPolicy: 'abort',
        noProgressAbortEnabled: false,
        stuckRepeatThreshold: 3,
      },
      sessionId: 'sess-001',
      workflowId: 'wr.test',
      emitter: undefined,
      conversationPath: '/tmp/conv.jsonl',
      lastFlushedRef: { count: 0 },
      stuckRepeatThreshold: 3,
    };
    expect(ctx.sessionId).toBe('sess-001');
    expect(ctx.lastFlushedRef.count).toBe(0);
  });

  it('lastFlushedRef is a mutable object (shared by reference)', () => {
    const ref = { count: 0 };
    const ctx = { lastFlushedRef: ref };
    // Simulate incrementing from subscriber
    ctx.lastFlushedRef.count++;
    // Original ref must be updated
    expect(ref.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SessionOutcome discriminated union
// ---------------------------------------------------------------------------

describe('SessionOutcome discriminated union', () => {
  it('completed variant has stopReason', () => {
    const outcome: SessionOutcome = { kind: 'completed', stopReason: 'end_turn' };
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.stopReason).toBe('end_turn');
      expect(outcome.errorMessage).toBeUndefined();
    }
  });

  it('aborted variant has optional errorMessage', () => {
    const outcome: SessionOutcome = { kind: 'aborted', errorMessage: 'API timeout' };
    expect(outcome.kind).toBe('aborted');
    if (outcome.kind === 'aborted') {
      expect(outcome.errorMessage).toBe('API timeout');
    }
  });

  it('aborted without errorMessage is valid', () => {
    const outcome: SessionOutcome = { kind: 'aborted' };
    expect(outcome.kind).toBe('aborted');
    if (outcome.kind === 'aborted') {
      expect(outcome.errorMessage).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// FinalizationContext shape
// ---------------------------------------------------------------------------

describe('FinalizationContext shape', () => {
  it('has all required fields for finalizeSession', () => {
    const ctx: FinalizationContext = {
      sessionId: 'local-001',
      workrailSessionId: 'sess_abc',
      startMs: Date.now() - 1000,
      stepAdvanceCount: 5,
      branchStrategy: 'none',
      statsDir: '/tmp/stats',
      sessionsDir: '/tmp/sessions',
      conversationPath: '/tmp/conv.jsonl',
      emitter: undefined,
      daemonRegistry: undefined,
      workflowId: 'wr.test',
    };
    expect(ctx.sessionId).toBe('local-001');
    expect(ctx.stepAdvanceCount).toBe(5);
  });

  it('branchStrategy can be undefined', () => {
    const ctx: FinalizationContext = {
      sessionId: 'local-001',
      workrailSessionId: null,
      startMs: Date.now(),
      stepAdvanceCount: 0,
      branchStrategy: undefined,
      statsDir: '/tmp',
      sessionsDir: '/tmp',
      conversationPath: '/tmp/conv.jsonl',
      emitter: undefined,
      daemonRegistry: undefined,
      workflowId: 'wr.test',
    };
    expect(ctx.branchStrategy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WORKTREES_DIR constant
// ---------------------------------------------------------------------------

describe('WORKTREES_DIR constant', () => {
  it('points to ~/.workrail/worktrees', () => {
    const expected = path.join(os.homedir(), '.workrail', 'worktrees');
    expect(WORKTREES_DIR).toBe(expected);
  });

  it('is an absolute path', () => {
    expect(path.isAbsolute(WORKTREES_DIR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Architecture: runner/ index re-exports expected symbols
// ---------------------------------------------------------------------------

describe('runner/index.ts exports', async () => {
  it('exports all expected symbols', async () => {
    const runnerIndex = await import('../../src/daemon/runner/index.js');
    expect(typeof runnerIndex.WORKTREES_DIR).toBe('string');
    expect(typeof runnerIndex.getSchemas).toBe('function');
    expect(typeof runnerIndex.constructTools).toBe('function');
    expect(typeof runnerIndex.finalizeSession).toBe('function');
    expect(typeof runnerIndex.buildPreAgentSession).toBe('function');
    expect(typeof runnerIndex.buildTurnEndSubscriber).toBe('function');
    expect(typeof runnerIndex.buildAgentCallbacks).toBe('function');
    expect(typeof runnerIndex.buildAgentReadySession).toBe('function');
    expect(typeof runnerIndex.runAgentLoop).toBe('function');
  });
});
