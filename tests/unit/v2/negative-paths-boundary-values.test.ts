/**
 * Negative path + boundary value tests for v2 durable-core.
 *
 * Polish & Hardening Sub-phase E:
 * - Every error code in critical unions has at least one test producing it
 * - Boundary values (empty arrays, max budgets reached, edge cases)
 */

import { describe, it, expect } from 'vitest';
import { buildValidationPerformedEvent } from '../../../src/v2/durable-core/domain/validation-event-builder.js';
import { buildExportBundle } from '../../../src/v2/durable-core/domain/bundle-builder.js';
import { buildBlockedNodeSnapshot } from '../../../src/v2/durable-core/domain/blocked-node-builder.js';
import { toCanonicalBytes } from '../../../src/v2/durable-core/canonical/jcs.js';
import { mergeContext } from '../../../src/v2/durable-core/domain/context-merge.js';
import { reasonToBlocker } from '../../../src/v2/durable-core/domain/reason-model.js';
import { MAX_VALIDATION_ISSUES_BYTES, MAX_VALIDATION_SUGGESTIONS_BYTES } from '../../../src/v2/durable-core/constants.js';
import type { JsonValue } from '../../../src/v2/durable-core/canonical/jcs.js';
import type { JsonObject } from '../../../src/v2/durable-core/canonical/json-types.js';

// ============================================================================
// Validation Event Builder — error code coverage
// ============================================================================

describe('buildValidationPerformedEvent negative paths', () => {
  const validArgs = {
    sessionId: 'sess_1',
    validationId: 'val_1',
    attemptId: 'att_1',
    contractRef: 'wr.validationCriteria',
    result: { valid: false, issues: ['Issue 1'], suggestions: ['Fix 1'] },
    scope: { runId: 'run_1', nodeId: 'node_1' },
    minted: { eventId: 'evt_1' },
  };

  it('VALIDATION_EVENT_INVARIANT_VIOLATION: empty sessionId', () => {
    const res = buildValidationPerformedEvent({ ...validArgs, sessionId: '' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_INVARIANT_VIOLATION');
  });

  it('VALIDATION_EVENT_INVARIANT_VIOLATION: empty validationId', () => {
    const res = buildValidationPerformedEvent({ ...validArgs, validationId: '' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_INVARIANT_VIOLATION');
  });

  it('VALIDATION_EVENT_INVARIANT_VIOLATION: empty attemptId', () => {
    const res = buildValidationPerformedEvent({ ...validArgs, attemptId: '' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_INVARIANT_VIOLATION');
  });

  it('VALIDATION_EVENT_INVARIANT_VIOLATION: empty contractRef', () => {
    const res = buildValidationPerformedEvent({ ...validArgs, contractRef: '' });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_INVARIANT_VIOLATION');
  });

  it('VALIDATION_EVENT_INVARIANT_VIOLATION: empty runId', () => {
    const res = buildValidationPerformedEvent({ ...validArgs, scope: { runId: '', nodeId: 'node_1' } });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_INVARIANT_VIOLATION');
  });

  it('VALIDATION_EVENT_INVARIANT_VIOLATION: empty eventId', () => {
    const res = buildValidationPerformedEvent({ ...validArgs, minted: { eventId: '' } });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_INVARIANT_VIOLATION');
  });

  it('VALIDATION_EVENT_TEXT_TOO_LARGE: single issue exceeds budget', () => {
    const hugeIssue = 'x'.repeat(MAX_VALIDATION_ISSUES_BYTES + 1);
    const res = buildValidationPerformedEvent({
      ...validArgs,
      result: { valid: false, issues: [hugeIssue], suggestions: [] },
    });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_TEXT_TOO_LARGE');
  });

  it('VALIDATION_EVENT_TEXT_TOO_LARGE: single suggestion exceeds budget', () => {
    const hugeSuggestion = 'y'.repeat(MAX_VALIDATION_SUGGESTIONS_BYTES + 1);
    const res = buildValidationPerformedEvent({
      ...validArgs,
      result: { valid: false, issues: [], suggestions: [hugeSuggestion] },
    });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('VALIDATION_EVENT_TEXT_TOO_LARGE');
  });

  it('succeeds with empty issues and suggestions', () => {
    const res = buildValidationPerformedEvent({
      ...validArgs,
      result: { valid: true, issues: [], suggestions: [] },
    });
    expect(res.isOk()).toBe(true);
  });

  it('truncates issues list at budget boundary', () => {
    // Create many small issues that together exceed budget
    const itemSize = 100;
    const itemCount = Math.ceil(MAX_VALIDATION_ISSUES_BYTES / itemSize) + 5;
    const issues = Array.from({ length: itemCount }, (_, i) => `Issue-${String(i).padStart(3, '0')}: ${'z'.repeat(itemSize - 20)}`);

    const res = buildValidationPerformedEvent({
      ...validArgs,
      result: { valid: false, issues, suggestions: [] },
    });
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      const event = res.value as any;
      const resultIssues = event.data.result.issues as readonly string[];
      expect(resultIssues.length).toBeLessThan(itemCount);
      // Should have truncation marker
      expect(resultIssues[resultIssues.length - 1]).toBe('[TRUNCATED]');
    }
  });
});

// ============================================================================
// JCS Canonicalization — error code coverage
// ============================================================================

describe('toCanonicalBytes negative paths', () => {
  it('CANONICAL_JSON_NON_FINITE_NUMBER: NaN', () => {
    const res = toCanonicalBytes(NaN as unknown as JsonValue);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('CANONICAL_JSON_NON_FINITE_NUMBER');
  });

  it('CANONICAL_JSON_NON_FINITE_NUMBER: Infinity', () => {
    const res = toCanonicalBytes(Infinity as unknown as JsonValue);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('CANONICAL_JSON_NON_FINITE_NUMBER');
  });

  it('CANONICAL_JSON_NON_FINITE_NUMBER: -Infinity', () => {
    const res = toCanonicalBytes(-Infinity as unknown as JsonValue);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('CANONICAL_JSON_NON_FINITE_NUMBER');
  });

  it('CANONICAL_JSON_UNSUPPORTED_VALUE: undefined in object', () => {
    // Undefined values are stripped during JSON serialization but function values fail
    const res = toCanonicalBytes((() => {}) as unknown as JsonValue);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('CANONICAL_JSON_UNSUPPORTED_VALUE');
  });

  it('produces stable bytes for empty object', () => {
    const res = toCanonicalBytes({} as JsonValue);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      expect(res.value).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(res.value as unknown as Uint8Array)).toBe('{}');
    }
  });

  it('produces stable bytes for empty array', () => {
    const res = toCanonicalBytes([] as unknown as JsonValue);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      expect(new TextDecoder().decode(res.value as unknown as Uint8Array)).toBe('[]');
    }
  });

  it('key ordering is deterministic (RFC 8785)', () => {
    const a = toCanonicalBytes({ z: 1, a: 2, m: 3 } as unknown as JsonValue);
    const b = toCanonicalBytes({ a: 2, m: 3, z: 1 } as unknown as JsonValue);
    expect(a.isOk() && b.isOk()).toBe(true);
    if (a.isOk() && b.isOk()) {
      const aStr = new TextDecoder().decode(a.value as unknown as Uint8Array);
      const bStr = new TextDecoder().decode(b.value as unknown as Uint8Array);
      expect(aStr).toBe(bStr);
      expect(aStr).toBe('{"a":2,"m":3,"z":1}');
    }
  });
});

// ============================================================================
// Context Merge — error code coverage
// ============================================================================

describe('mergeContext negative paths', () => {
  it('RESERVED_KEY_REJECTED: rejects __proto__ key', () => {
    // Use Object.create to safely test __proto__ key
    const delta = JSON.parse('{"__proto__": "test"}') as JsonObject;
    const res = mergeContext(undefined, delta);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('RESERVED_KEY_REJECTED');
  });

  it('RESERVED_KEY_REJECTED: rejects constructor key', () => {
    const res = mergeContext(undefined, { constructor: 'test' } as unknown as JsonObject);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('RESERVED_KEY_REJECTED');
  });

  it('succeeds with empty delta', () => {
    const res = mergeContext({ a: 1 } as unknown as JsonObject, {} as JsonObject);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual({ a: 1 });
  });

  it('succeeds with undefined delta (no-op)', () => {
    const res = mergeContext({ a: 1 } as unknown as JsonObject, undefined);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toEqual({ a: 1 });
  });

  it('null tombstones delete keys', () => {
    const res = mergeContext({ a: 1, b: 2 } as unknown as JsonObject, { a: null } as unknown as JsonObject);
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      expect(res.value).not.toHaveProperty('a');
      expect(res.value).toHaveProperty('b', 2);
    }
  });

  it('shallow merges (does not deep merge)', () => {
    const res = mergeContext(
      { nested: { x: 1, y: 2 } } as unknown as JsonObject,
      { nested: { x: 99 } } as unknown as JsonObject,
    );
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      // Shallow merge: delta replaces entire nested object
      expect(res.value).toEqual({ nested: { x: 99 } });
    }
  });
});

// ============================================================================
// Reason Model — error code coverage
// ============================================================================

describe('reasonToBlocker negative paths', () => {
  it('INVALID_DELIMITER_SAFE_ID: rejects keys with invalid characters', () => {
    const res = reasonToBlocker({
      kind: 'missing_context_key',
      key: 'invalid@key/with:delimiters',
    });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('INVALID_DELIMITER_SAFE_ID');
  });

  it('INVALID_CONTRACT_REF: rejects empty contractRef', () => {
    const res = reasonToBlocker({
      kind: 'missing_required_output',
      contractRef: '',
    });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('INVALID_CONTRACT_REF');
  });

  it('succeeds with valid reason', () => {
    const res = reasonToBlocker({
      kind: 'context_budget_exceeded',
    });
    expect(res.isOk()).toBe(true);
  });
});

// ============================================================================
// Bundle Builder — error code coverage
// ============================================================================

describe('buildExportBundle negative paths', () => {
  it('BUNDLE_BUILD_EMPTY_EVENTS: rejects empty event array', () => {
    const res = buildExportBundle({
      sessionId: 'sess_1',
      events: [],
      manifest: [],
      snapshots: new Map(),
      pinnedWorkflows: new Map(),
    });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('BUNDLE_BUILD_EMPTY_EVENTS');
  });
});

// ============================================================================
// Blocked Node Builder — error code coverage
// ============================================================================

describe('buildBlockedNodeSnapshot negative paths', () => {
  it('BLOCKED_NODE_UNSUPPORTED_STATE: rejects complete state', () => {
    const res = buildBlockedNodeSnapshot({
      priorSnapshot: {
        v: 1,
        snapshotRef: 'snap_1',
        enginePayload: { engineState: { kind: 'complete' } },
      } as any,
      blockerReport: { blockers: [{ kind: 'missing_required_output', message: 'test' }] } as any,
      blockedAttemptId: 'att_1',
      minted: { nodeId: 'node_1', snapshotRef: 'snap_2' },
      sha256: { sha256: (data: Uint8Array) => 'sha256:' + '0'.repeat(64) } as any,
    });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.code).toBe('BLOCKED_NODE_UNSUPPORTED_STATE');
  });
});
