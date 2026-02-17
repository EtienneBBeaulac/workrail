import { describe, expect, it } from 'vitest';
import { buildValidationPerformedEvent } from '../../../src/v2/durable-core/domain/validation-event-builder.js';
import { MAX_VALIDATION_ISSUES_BYTES } from '../../../src/v2/durable-core/constants.js';

describe('buildValidationPerformedEvent', () => {
  it('is deterministic: sorts + dedupes issues/suggestions (order-independent)', () => {
    const base = {
      sessionId: 'sess_test',
      validationId: 'val_1',
      attemptId: 'attempt_1',
      contractRef: 'wr.contracts.some_contract',
      scope: { runId: 'run_1', nodeId: 'node_1' },
      minted: { eventId: 'evt_1' },
    } as const;

    const r1 = buildValidationPerformedEvent({
      ...base,
      result: {
        valid: false,
        issues: ['b', 'a', 'a'],
        suggestions: ['z', 'y', 'y'],
        warnings: undefined,
      },
    });

    const r2 = buildValidationPerformedEvent({
      ...base,
      result: {
        valid: false,
        issues: ['a', 'b'],
        suggestions: ['y', 'z'],
        warnings: undefined,
      },
    });

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    expect(r1._unsafeUnwrap()).toEqual(r2._unsafeUnwrap());
  });

  it('truncates deterministically and appends a truncation marker item when needed', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `issue-${String(i).padStart(6, '0')}`);

    const res = buildValidationPerformedEvent({
      sessionId: 'sess_test',
      validationId: 'val_2',
      attemptId: 'attempt_2',
      contractRef: 'wr.contracts.some_contract',
      scope: { runId: 'run_1', nodeId: 'node_1' },
      minted: { eventId: 'evt_2' },
      result: { valid: false, issues: many, suggestions: [], warnings: undefined },
    });

    expect(res.isOk()).toBe(true);
    const evt = res._unsafeUnwrap();

    const issues = evt.data.result.issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[issues.length - 1]).toBe('[TRUNCATED]');

    const totalBytes = issues.reduce((sum, s) => sum + new TextEncoder().encode(s).length, 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_VALIDATION_ISSUES_BYTES);
  });
});
