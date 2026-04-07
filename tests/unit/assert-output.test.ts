/**
 * Tests for the assertOutput() dev/test-only invariant helper.
 *
 * assertOutput() is the replacement for production Schema.parse() calls that
 * validated server-produced data. The parse() calls were removed because:
 * - "validate at boundaries, trust inside" -- internal typed data needs no runtime parse
 * - TypeScript 'as T' assertions provide compile-time safety at zero runtime cost
 *
 * assertOutput() preserves the valuable cross-field invariants (blocker sort order,
 * continueToken presence) for development and test environments only.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Import the module after tests define what to expect -- this is TDD:
// the test file is written first, then the implementation makes it pass.
import {
  assertOutput,
  assertBlockerReportInvariants,
  assertContinueTokenPresence,
} from '../../src/mcp/assert-output.js';

// ---------------------------------------------------------------------------
// assertOutput() -- the generic dev/test gate
// ---------------------------------------------------------------------------

describe('assertOutput()', () => {
  afterEach(() => {
    // Restore WORKRAIL_DEV after each test that modifies it
    delete process.env['WORKRAIL_DEV'];
  });

  it('runs the check when WORKRAIL_DEV=1', () => {
    process.env['WORKRAIL_DEV'] = '1';
    const data = { value: 42 };
    expect(() =>
      assertOutput(data, () => { throw new Error('invariant violated'); })
    ).toThrow('invariant violated');
  });

  it('is a no-op when WORKRAIL_DEV is unset', () => {
    delete process.env['WORKRAIL_DEV'];
    const data = { value: 42 };
    // Should not throw even though the check would fail
    expect(() =>
      assertOutput(data, () => { throw new Error('invariant violated'); })
    ).not.toThrow();
  });

  it('returns the data unchanged (pass-through)', () => {
    process.env['WORKRAIL_DEV'] = '1';
    const data = { foo: 'bar', nested: { x: 1 } };
    const result = assertOutput(data, () => {});
    expect(result).toBe(data); // same reference, no copy
  });

  it('does not mutate the data', () => {
    process.env['WORKRAIL_DEV'] = '1';
    const data = { count: 5 };
    assertOutput(data, (d) => { void d; }); // read-only check
    expect(data.count).toBe(5);
  });

  it('passes the data to the check function', () => {
    process.env['WORKRAIL_DEV'] = '1';
    const data = { x: 99 };
    let received: typeof data | undefined;
    assertOutput(data, (d) => { received = d; });
    expect(received).toBe(data);
  });
});

// ---------------------------------------------------------------------------
// assertBlockerReportInvariants() -- blocker sort order check
// ---------------------------------------------------------------------------

describe('assertBlockerReportInvariants()', () => {
  const baseBlocker = {
    code: 'USER_ONLY_DEPENDENCY' as const,
    pointer: { kind: 'context_budget' as const },
    message: 'test',
  };

  it('accepts a single blocker (trivially sorted)', () => {
    expect(() =>
      assertBlockerReportInvariants({
        blockers: [baseBlocker],
      })
    ).not.toThrow();
  });

  it('accepts correctly sorted blockers (lexicographic ascending by composite key)', () => {
    expect(() =>
      assertBlockerReportInvariants({
        blockers: [
          { code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' as const }, message: 'a' },
          { code: 'USER_ONLY_DEPENDENCY', pointer: { kind: 'context_budget' as const }, message: 'b' },
        ],
      })
    ).not.toThrow();
  });

  it('rejects unsorted blockers (descending order)', () => {
    // USER_ONLY_DEPENDENCY > INVARIANT_VIOLATION lexicographically
    expect(() =>
      assertBlockerReportInvariants({
        blockers: [
          { code: 'USER_ONLY_DEPENDENCY', pointer: { kind: 'context_budget' as const }, message: 'b' },
          { code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' as const }, message: 'a' },
        ],
      })
    ).toThrow(/sorted/i);
  });

  it('accepts sorted blockers with context_key pointers', () => {
    expect(() =>
      assertBlockerReportInvariants({
        blockers: [
          { code: 'MISSING_CONTEXT_KEY', pointer: { kind: 'context_key' as const, key: 'alpha' }, message: 'a' },
          { code: 'MISSING_CONTEXT_KEY', pointer: { kind: 'context_key' as const, key: 'beta' }, message: 'b' },
        ],
      })
    ).not.toThrow();
  });

  it('rejects unsorted blockers with context_key pointers', () => {
    expect(() =>
      assertBlockerReportInvariants({
        blockers: [
          { code: 'MISSING_CONTEXT_KEY', pointer: { kind: 'context_key' as const, key: 'beta' }, message: 'b' },
          { code: 'MISSING_CONTEXT_KEY', pointer: { kind: 'context_key' as const, key: 'alpha' }, message: 'a' },
        ],
      })
    ).toThrow(/sorted/i);
  });
});

// ---------------------------------------------------------------------------
// assertContinueTokenPresence() -- cross-field check from V2ContinueWorkflowOutputSchema
// ---------------------------------------------------------------------------

describe('assertContinueTokenPresence()', () => {
  it('accepts a response with pending step and continueToken present', () => {
    expect(() =>
      assertContinueTokenPresence({
        pending: { stepId: 'step-1', title: 'Step 1', prompt: 'Do the thing' },
        continueToken: 'ct_ABCDEFGHIJKLMNOPQRSTUVWX',
      })
    ).not.toThrow();
  });

  it('accepts a response with no pending step and no continueToken', () => {
    expect(() =>
      assertContinueTokenPresence({
        pending: null,
        continueToken: undefined,
      })
    ).not.toThrow();
  });

  it('rejects a response with pending step but missing continueToken', () => {
    expect(() =>
      assertContinueTokenPresence({
        pending: { stepId: 'step-1', title: 'Step 1', prompt: 'Do the thing' },
        continueToken: undefined,
      })
    ).toThrow(/continueToken/i);
  });
});
