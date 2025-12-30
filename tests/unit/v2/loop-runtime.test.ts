import { describe, it, expect } from 'vitest';
import {
  canContinueLoop,
  nextIteration,
  validateLoopAdvance,
  isIterationWithinBounds,
} from '../../../src/v2/durable-core/domain/loop-runtime';

describe('loop-runtime', () => {
  describe('canContinueLoop', () => {
    it('returns true at iteration 0 with maxIterations > 0', () => {
      expect(canContinueLoop(0, 5)).toBe(true);
      expect(canContinueLoop(0, 1)).toBe(true);
    });

    it('returns true at iteration maxIterations - 1 (last allowed)', () => {
      expect(canContinueLoop(4, 5)).toBe(true);
      expect(canContinueLoop(0, 1)).toBe(true);
    });

    it('returns false at iteration === maxIterations (would be over limit)', () => {
      expect(canContinueLoop(5, 5)).toBe(false);
      expect(canContinueLoop(1, 1)).toBe(false);
    });

    it('returns false when iteration > maxIterations', () => {
      expect(canContinueLoop(6, 5)).toBe(false);
      expect(canContinueLoop(10, 5)).toBe(false);
    });

    it('returns false when maxIterations is 0 (no iterations allowed)', () => {
      expect(canContinueLoop(0, 0)).toBe(false);
    });
  });

  describe('nextIteration', () => {
    it('increments iteration by 1', () => {
      expect(nextIteration(0)).toBe(1);
      expect(nextIteration(1)).toBe(2);
      expect(nextIteration(99)).toBe(100);
    });
  });

  describe('isIterationWithinBounds', () => {
    it('returns true when iteration < maxIterations', () => {
      expect(isIterationWithinBounds(0, 5)).toBe(true);
      expect(isIterationWithinBounds(4, 5)).toBe(true);
    });

    it('returns false when iteration >= maxIterations', () => {
      expect(isIterationWithinBounds(5, 5)).toBe(false);
      expect(isIterationWithinBounds(6, 5)).toBe(false);
    });
  });

  describe('validateLoopAdvance', () => {
    it('returns Ok(nextIteration) when advance is allowed', () => {
      const result = validateLoopAdvance('test-loop', 0, 5);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(1);
    });

    it('returns Ok for last allowed advance (iteration maxIterations-2 -> maxIterations-1)', () => {
      // iteration 3 -> 4 is allowed when maxIterations=5 (iterations 0-4 allowed)
      const result = validateLoopAdvance('test-loop', 3, 5);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(4);
    });

    it('returns Err when advance would exceed maxIterations', () => {
      // iteration 4 -> 5 is NOT allowed when maxIterations=5
      const result = validateLoopAdvance('test-loop', 4, 5);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('LOOP_MAX_ITERATIONS_REACHED');
        expect(result.error.loopId).toBe('test-loop');
        expect(result.error.iteration).toBe(4);
        expect(result.error.maxIterations).toBe(5);
      }
    });

    it('returns Err when already at or past maxIterations', () => {
      const result = validateLoopAdvance('test-loop', 5, 5);
      expect(result.isErr()).toBe(true);
    });

    it('includes descriptive error message', () => {
      const result = validateLoopAdvance('my-loop', 4, 5);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain('my-loop');
        expect(result.error.message).toContain('5');
      }
    });
  });

  describe('iteration semantics (locked)', () => {
    it('iteration is 0-based: first iteration is 0', () => {
      // Lock: iteration indexing is 0-based
      expect(canContinueLoop(0, 1)).toBe(true); // iteration 0 is allowed
      expect(canContinueLoop(1, 1)).toBe(false); // iteration 1 is NOT allowed (only 0)
    });

    it('maxIterations is a count: maxIterations=5 allows iterations 0-4', () => {
      // Lock: maxIterations meaning is count, not max index
      for (let i = 0; i < 5; i++) {
        expect(canContinueLoop(i, 5)).toBe(true);
      }
      expect(canContinueLoop(5, 5)).toBe(false);
    });
  });
});
