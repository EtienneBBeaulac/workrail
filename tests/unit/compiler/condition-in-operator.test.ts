/**
 * Tests for the 'in' operator added to condition-evaluator.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCondition, validateCondition } from '../../../src/utils/condition-evaluator.js';

describe('evaluateCondition — in operator', () => {
  it('returns true when the variable value is in the array', () => {
    expect(evaluateCondition({ var: 'mode', in: ['STANDARD', 'THOROUGH'] }, { mode: 'STANDARD' })).toBe(true);
    expect(evaluateCondition({ var: 'mode', in: ['STANDARD', 'THOROUGH'] }, { mode: 'THOROUGH' })).toBe(true);
  });

  it('returns false when the variable value is not in the array', () => {
    expect(evaluateCondition({ var: 'mode', in: ['STANDARD', 'THOROUGH'] }, { mode: 'QUICK' })).toBe(false);
  });

  it('returns false when the variable is undefined and array has no null/undefined entry', () => {
    expect(evaluateCondition({ var: 'mode', in: ['STANDARD', 'THOROUGH'] }, {})).toBe(false);
  });

  it('returns true when the variable is null/undefined and array contains null', () => {
    expect(evaluateCondition({ var: 'mode', in: [null] }, {})).toBe(true);
  });

  it('returns false for an empty in array', () => {
    expect(evaluateCondition({ var: 'mode', in: [] }, { mode: 'STANDARD' })).toBe(false);
  });

  it('uses case-insensitive comparison (via lenientEquals)', () => {
    expect(evaluateCondition({ var: 'mode', in: ['standard', 'thorough'] }, { mode: 'STANDARD' })).toBe(true);
  });

  it('works with numeric values', () => {
    expect(evaluateCondition({ var: 'level', in: [1, 2, 3] }, { level: 2 })).toBe(true);
    expect(evaluateCondition({ var: 'level', in: [1, 2, 3] }, { level: 5 })).toBe(false);
  });

  it('composes with logical and', () => {
    const condition = {
      and: [
        { var: 'mode', in: ['STANDARD', 'THOROUGH'] },
        { var: 'risk', equals: 'High' },
      ],
    };
    expect(evaluateCondition(condition, { mode: 'STANDARD', risk: 'High' })).toBe(true);
    expect(evaluateCondition(condition, { mode: 'QUICK', risk: 'High' })).toBe(false);
  });
});

describe('validateCondition — in operator', () => {
  it('accepts in as a supported operator without throwing', () => {
    expect(() => validateCondition({ var: 'mode', in: ['A', 'B'] })).not.toThrow();
  });

  it('rejects an unknown operator alongside in', () => {
    expect(() => validateCondition({ var: 'mode', unknown_op: 'value' })).toThrow();
  });
});
