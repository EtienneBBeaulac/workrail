import { describe, it, expect } from 'vitest';
import { WorkflowStep, LoopStep, isLoopStep } from '../../src/types/workflow-types';

describe('Loop Type Definitions', () => {
  describe('isLoopStep type guard', () => {
    it('should correctly identify loop steps', () => {
      const loopStep: LoopStep = {
        id: 'test-loop',
        type: 'loop',
        title: 'Test Loop',
        prompt: 'Loop prompt',
        loop: {
          type: 'while',
          maxIterations: 10
        },
        body: 'process-step'
      };

      expect(isLoopStep(loopStep)).toBe(true);
    });

    it('should correctly identify non-loop steps', () => {
      const regularStep: WorkflowStep = {
        id: 'regular-step',
        title: 'Regular Step',
        prompt: 'Regular prompt'
      };

      expect(isLoopStep(regularStep)).toBe(false);
    });

    it('should handle steps with type property that is not loop', () => {
      const stepWithType = {
        id: 'other-step',
        title: 'Other Step',
        prompt: 'Other prompt',
        type: 'other'
      } as any;

      expect(isLoopStep(stepWithType)).toBe(false);
    });
  });
}); 