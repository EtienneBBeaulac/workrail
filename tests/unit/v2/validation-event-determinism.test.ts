import { describe, it, expect } from 'vitest';
import { buildValidationPerformedEvent } from '../../../src/v2/durable-core/domain/validation-event-builder.js';

describe('Validation event determinism (100x replay)', () => {
  it('100x replay produces identical events', () => {
    const args = {
      sessionId: 'sess_test',
      validationId: 'val_1',
      attemptId: 'attempt_1',
      contractRef: 'wr.validationCriteria',
      scope: { runId: 'run_1', nodeId: 'node_1' },
      minted: { eventId: 'evt_1' },
      result: {
        valid: false,
        issues: ['Issue B', 'Issue A', 'Issue A'], // Duplicates, unordered
        suggestions: ['Fix 2', 'Fix 1'], // Unordered
        warnings: undefined,
      },
    };

    // Build 100 times
    const events = [];
    for (let i = 0; i < 100; i++) {
      const eventRes = buildValidationPerformedEvent(args);
      expect(eventRes.isOk()).toBe(true);
      events.push(eventRes._unsafeUnwrap());
    }

    // Verify all identical (JSON string comparison for deep equality)
    const first = JSON.stringify(events[0]);
    for (const event of events) {
      expect(JSON.stringify(event)).toBe(first);
    }

    // Verify deterministic ordering (sorted, deduped)
    expect(events[0]!.data.result.issues).toEqual(['Issue A', 'Issue B']);
    expect(events[0]!.data.result.suggestions).toEqual(['Fix 1', 'Fix 2']);
  });

  it('identical issues in different order produce identical events', () => {
    const args1 = {
      sessionId: 'sess_test',
      validationId: 'val_1',
      attemptId: 'attempt_1',
      contractRef: 'wr.test',
      scope: { runId: 'run_1', nodeId: 'node_1' },
      minted: { eventId: 'evt_1' },
      result: {
        valid: false,
        issues: ['C', 'A', 'B'],
        suggestions: ['Z', 'X', 'Y'],
        warnings: undefined,
      },
    };

    const args2 = {
      ...args1,
      result: {
        valid: false,
        issues: ['A', 'B', 'C'],
        suggestions: ['X', 'Y', 'Z'],
        warnings: undefined,
      },
    };

    const event1Res = buildValidationPerformedEvent(args1);
    const event2Res = buildValidationPerformedEvent(args2);

    expect(event1Res.isOk()).toBe(true);
    expect(event2Res.isOk()).toBe(true);

    expect(JSON.stringify(event1Res._unsafeUnwrap())).toBe(JSON.stringify(event2Res._unsafeUnwrap()));
  });

  it('truncation is deterministic when budget exceeded', () => {
    const manyIssues = Array.from({ length: 1000 }, (_, i) => `Issue ${String(i).padStart(4, '0')}`);

    const events = [];
    for (let i = 0; i < 10; i++) {
      const eventRes = buildValidationPerformedEvent({
        sessionId: 'sess_test',
        validationId: 'val_big',
        attemptId: 'attempt_big',
        contractRef: 'wr.test',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        minted: { eventId: `evt_${i}` },
        result: {
          valid: false,
          issues: manyIssues,
          suggestions: [],
          warnings: undefined,
        },
      });
      expect(eventRes.isOk()).toBe(true);
      events.push(eventRes._unsafeUnwrap());
    }

    // All events truncate identically
    const firstIssues = JSON.stringify(events[0]!.data.result.issues);
    for (const event of events) {
      expect(JSON.stringify(event.data.result.issues)).toBe(firstIssues);
    }

    // Verify truncation marker present
    const issues = events[0]!.data.result.issues;
    expect(issues[issues.length - 1]).toBe('[TRUNCATED]');

    // Verify total bytes under budget
    const totalBytes = issues.reduce((sum, s) => sum + new TextEncoder().encode(s).length, 0);
    expect(totalBytes).toBeLessThanOrEqual(4096); // MAX_VALIDATION_ISSUES_BYTES
  });
});
