/**
 * Unit tests for session-recovery-policy.ts.
 *
 * Tests: evaluateRecovery()
 *
 * Strategy: pure function -- all cases are exhaustively enumerable.
 * No I/O, no mocks, no async.
 */

import { describe, it, expect } from 'vitest';
import { evaluateRecovery } from '../../src/daemon/session-recovery-policy.js';

describe('evaluateRecovery()', () => {
  // ---------------------------------------------------------------------------
  // stepAdvances === 0 -> discard
  // ---------------------------------------------------------------------------

  it('discards when stepAdvances is 0 and age is 0', () => {
    expect(evaluateRecovery({ stepAdvances: 0, ageMs: 0 })).toBe('discard');
  });

  it('discards when stepAdvances is 0 and age is under 2 minutes', () => {
    expect(evaluateRecovery({ stepAdvances: 0, ageMs: 60_000 })).toBe('discard');
  });

  it('discards when stepAdvances is 0 and age is exactly 2 minutes', () => {
    expect(evaluateRecovery({ stepAdvances: 0, ageMs: 2 * 60 * 1000 })).toBe('discard');
  });

  it('discards when stepAdvances is 0 and age is over 1 hour', () => {
    expect(evaluateRecovery({ stepAdvances: 0, ageMs: 60 * 60 * 1000 })).toBe('discard');
  });

  // ---------------------------------------------------------------------------
  // stepAdvances >= 1 -> resume
  // ---------------------------------------------------------------------------

  it('resumes when stepAdvances is 1 and age is 0', () => {
    expect(evaluateRecovery({ stepAdvances: 1, ageMs: 0 })).toBe('resume');
  });

  it('resumes when stepAdvances is 1 and age is large', () => {
    expect(evaluateRecovery({ stepAdvances: 1, ageMs: 60 * 60 * 1000 })).toBe('resume');
  });

  it('resumes when stepAdvances is 3 and age is 10 minutes', () => {
    expect(evaluateRecovery({ stepAdvances: 3, ageMs: 10 * 60 * 1000 })).toBe('resume');
  });

  it('resumes when stepAdvances is a large number', () => {
    expect(evaluateRecovery({ stepAdvances: 50, ageMs: 30 * 60 * 1000 })).toBe('resume');
  });

  // ---------------------------------------------------------------------------
  // Exhaustiveness: the return type is 'resume' | 'discard' (no other values)
  // ---------------------------------------------------------------------------

  it('only returns resume or discard', () => {
    const validValues = new Set<string>(['resume', 'discard']);
    const samples: Array<{ stepAdvances: number; ageMs: number }> = [
      { stepAdvances: 0, ageMs: 0 },
      { stepAdvances: 0, ageMs: 999_999 },
      { stepAdvances: 1, ageMs: 0 },
      { stepAdvances: 5, ageMs: 100_000 },
    ];
    for (const input of samples) {
      expect(validValues.has(evaluateRecovery(input))).toBe(true);
    }
  });
});
