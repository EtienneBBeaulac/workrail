import { describe, it, expect } from 'vitest';
import { buildBlockedNodeSnapshot } from '../../../src/v2/durable-core/domain/blocked-node-builder.js';
import type { ExecutionSnapshotFileV1 } from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { asAttemptId } from '../../../src/v2/durable-core/ids/index.js';

describe('buildBlockedNodeSnapshot', () => {
  const sha256 = new NodeSha256V2();

  const runningSnapshot: ExecutionSnapshotFileV1 = {
    v: 1,
    kind: 'execution_snapshot',
    enginePayload: {
      v: 1,
      engineState: {
        kind: 'running',
        completed: { kind: 'set', values: [] },
        loopStack: [],
        pending: { kind: 'some', step: { stepId: 'step1' as any, loopPath: [] } },
      },
    },
  };

  it('builds retryable_block for contract violation reasons', () => {
    const result = buildBlockedNodeSnapshot({
      priorSnapshot: runningSnapshot,
      primaryReason: { kind: 'invalid_required_output', contractRef: 'wr.validationCriteria' },
      attemptId: asAttemptId('attempt_1'),
      validationRef: 'validation_1',
      blockers: { blockers: [{ code: 'INVALID_REQUIRED_OUTPUT', pointer: { kind: 'output_contract', contractRef: 'wr.test' }, message: 'Invalid output' }] },
      sha256,
    });

    expect(result.isOk()).toBe(true);
    const snapshot = result._unsafeUnwrap();
    expect(snapshot.enginePayload.engineState.kind).toBe('blocked');
    if (snapshot.enginePayload.engineState.kind === 'blocked') {
      expect(snapshot.enginePayload.engineState.blocked.kind).toBe('retryable_block');
      expect(snapshot.enginePayload.engineState.blocked.retryAttemptId).toBeDefined();
    }
  });

  it('builds terminal_block for user-only dependency', () => {
    const result = buildBlockedNodeSnapshot({
      priorSnapshot: runningSnapshot,
      primaryReason: { kind: 'user_only_dependency', detail: 'needs_user_secret_or_token', stepId: 'step1' },
      attemptId: asAttemptId('attempt_2'),
      validationRef: 'validation_2',
      blockers: { blockers: [{ code: 'USER_ONLY_DEPENDENCY', pointer: { kind: 'workflow_step', stepId: 'step1' }, message: 'Needs user secret' }] },
      sha256,
    });

    expect(result.isOk()).toBe(true);
    const snapshot = result._unsafeUnwrap();
    expect(snapshot.enginePayload.engineState.kind).toBe('blocked');
    if (snapshot.enginePayload.engineState.kind === 'blocked') {
      expect(snapshot.enginePayload.engineState.blocked.kind).toBe('terminal_block');
      expect('retryAttemptId' in snapshot.enginePayload.engineState.blocked).toBe(false);
    }
  });

  it('returns error if priorSnapshot.engineState.kind !== "running"', () => {
    const completedSnapshot: ExecutionSnapshotFileV1 = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: { kind: 'complete' },
      },
    };

    const result = buildBlockedNodeSnapshot({
      priorSnapshot: completedSnapshot,
      primaryReason: { kind: 'invalid_required_output', contractRef: 'wr.test' },
      attemptId: asAttemptId('attempt_3'),
      validationRef: 'validation_3',
      blockers: { blockers: [{ code: 'INVALID_REQUIRED_OUTPUT', pointer: { kind: 'output_contract', contractRef: 'wr.test' }, message: 'msg' }] },
      sha256,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('BLOCKED_NODE_UNSUPPORTED_STATE');
    }
  });

  it('retryAttemptId is deterministic (same attemptId → same retryAttemptId)', () => {
    const args = {
      priorSnapshot: runningSnapshot,
      primaryReason: { kind: 'missing_required_output', contractRef: 'wr.test' } as const,
      attemptId: asAttemptId('attempt_deterministic'),
      validationRef: 'validation_det',
      blockers: { blockers: [{ code: 'MISSING_REQUIRED_OUTPUT', pointer: { kind: 'output_contract', contractRef: 'wr.test' }, message: 'msg' }] },
      sha256,
    };

    const result1 = buildBlockedNodeSnapshot(args);
    const result2 = buildBlockedNodeSnapshot(args);

    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);

    const retry1 = result1._unsafeUnwrap().enginePayload.engineState.blocked;
    const retry2 = result2._unsafeUnwrap().enginePayload.engineState.blocked;

    if (retry1.kind === 'retryable_block' && retry2.kind === 'retryable_block') {
      expect(retry1.retryAttemptId).toBe(retry2.retryAttemptId);
    }
  });
});
