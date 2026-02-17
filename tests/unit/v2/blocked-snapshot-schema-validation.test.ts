import { describe, it, expect } from 'vitest';
import { BlockedSnapshotV1Schema } from '../../../src/v2/durable-core/schemas/execution-snapshot/blocked-snapshot.js';

describe('BlockedSnapshotV1 schema validation (discriminated union enforcement)', () => {
  it('rejects terminal_block with retryAttemptId (illegal state)', () => {
    const invalidTerminal = {
      kind: 'terminal_block',
      reason: { kind: 'invariant_violation' },
      retryAttemptId: 'attempt_123', // Illegal for terminal
      blockers: { blockers: [{ code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' }, message: 'Test' }] },
    };

    const result = BlockedSnapshotV1Schema.safeParse(invalidTerminal);
    expect(result.success).toBe(false);
  });

  it('rejects retryable_block without retryAttemptId (required field)', () => {
    const invalidRetryable = {
      kind: 'retryable_block',
      reason: { kind: 'invalid_required_output', contractRef: 'wr.test' },
      validationRef: 'val_123',
      blockers: { blockers: [{ code: 'INVALID_REQUIRED_OUTPUT', pointer: { kind: 'output_contract', contractRef: 'wr.test' }, message: 'Test' }] },
      // Missing retryAttemptId
    };

    const result = BlockedSnapshotV1Schema.safeParse(invalidRetryable);
    expect(result.success).toBe(false);
  });

  it('rejects retryable_block with terminal reason (wrong reason type)', () => {
    const invalidRetryable = {
      kind: 'retryable_block',
      reason: { kind: 'invariant_violation' }, // Terminal reason in retryable block
      retryAttemptId: 'attempt_123',
      validationRef: 'val_123',
      blockers: { blockers: [{ code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' }, message: 'Test' }] },
    };

    const result = BlockedSnapshotV1Schema.safeParse(invalidRetryable);
    expect(result.success).toBe(false);
  });

  it('accepts valid retryable_block', () => {
    const validRetryable = {
      kind: 'retryable_block',
      reason: { kind: 'invalid_required_output', contractRef: 'wr.test' },
      retryAttemptId: 'attempt_retry_abc',
      validationRef: 'validation_attempt_abc',
      blockers: {
        blockers: [{
          code: 'INVALID_REQUIRED_OUTPUT',
          pointer: { kind: 'output_contract', contractRef: 'wr.test' },
          message: 'Output failed validation',
        }],
      },
    };

    const result = BlockedSnapshotV1Schema.safeParse(validRetryable);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('retryable_block');
      expect(result.data.retryAttemptId).toBe('attempt_retry_abc');
    }
  });

  it('accepts valid terminal_block without retryAttemptId', () => {
    const validTerminal = {
      kind: 'terminal_block',
      reason: { kind: 'invariant_violation' },
      validationRef: 'validation_123',
      blockers: {
        blockers: [{
          code: 'INVARIANT_VIOLATION',
          pointer: { kind: 'context_budget' },
          message: 'Invariant violated',
        }],
      },
    };

    const result = BlockedSnapshotV1Schema.safeParse(validTerminal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('terminal_block');
      expect('retryAttemptId' in result.data).toBe(false);
    }
  });
});
