import { LoopExecutionContext } from '../../src/application/services/loop-execution-context';
import { LoopConfig, LoopStep, EnhancedContext } from '../../src/types/workflow-types';

describe('LoopExecutionContext - Enhanced Features', () => {
  describe('getMinimalContext', () => {
    it('should generate minimal context for forEach loop', () => {
      const loopConfig: LoopConfig = {
        type: 'forEach',
        items: 'testItems',
        itemVar: 'currentItem',
        indexVar: 'currentIndex',
        maxIterations: 1000
      };

      const existingState = {
        iteration: 2,
        started: Date.now(),
        items: ['a', 'b', 'c', 'd'],
        index: 2
      };

      const context: EnhancedContext = {
        testItems: ['a', 'b', 'c', 'd'],
        otherData: 'should be preserved'
      };

      const loopContext = new LoopExecutionContext('test-loop', loopConfig, existingState);
      const result = loopContext.getMinimalContext(context);

      expect(result._currentLoop).toEqual({
        loopId: 'test-loop',
        loopType: 'forEach',
        iteration: 2,
        isFirstIteration: false
      });
      expect(result.currentItem).toBe('c');
      expect(result.currentIndex).toBe(2);
      expect(result.currentIteration).toBe(3);
      expect(result.otherData).toBe('should be preserved');
      // Should not include full items array
      expect(result.testItems).toBeUndefined();
    });

    it('should handle for loop minimal context', () => {
      const loopConfig: LoopConfig = {
        type: 'for',
        count: 10,
        iterationVar: 'i',
        maxIterations: 100
      };

      const existingState = {
        iteration: 5,
        started: Date.now()
      };

      const context: EnhancedContext = {};

      const loopContext = new LoopExecutionContext('for-loop', loopConfig, existingState);
      const result = loopContext.getMinimalContext(context);

      expect(result._currentLoop?.loopType).toBe('for');
      expect(result._currentLoop?.iteration).toBe(5);
      expect(result.i).toBe(6);
    });
  });

  describe('getPhaseReference', () => {
    it('should create phase reference from loop step', () => {
      const loopStep: LoopStep = {
        id: 'test-loop',
        type: 'loop',
        title: 'Process Items Loop',
        prompt: 'Process each item',
        loop: { type: 'forEach', items: 'items' },
        body: [
          { id: 'step1', title: 'Step 1', prompt: 'Do step 1' },
          { id: 'step2', title: 'Step 2', prompt: 'Do step 2' },
          { id: 'step3', title: 'Step 3', prompt: 'Do step 3' }
        ],
        functionDefinitions: [
          { name: 'validateItem', definition: 'Validates item format' }
        ]
      };

      const loopContext = new LoopExecutionContext('test-loop', loopStep.loop);
      const result = loopContext.getPhaseReference(loopStep);

      expect(result).toEqual({
        loopId: 'test-loop',
        phaseTitle: 'Process Items Loop',
        totalSteps: 3,
        functionDefinitions: [
          { name: 'validateItem', definition: 'Validates item format' }
        ]
      });
    });
  });

  describe('injectVariables with minimal mode', () => {
    it('should use minimal context when minimal=true', () => {
      const loopConfig: LoopConfig = {
        type: 'forEach',
        items: 'data',
        itemVar: 'item',
        maxIterations: 1000
      };

      const existingState = {
        iteration: 1,
        started: Date.now(),
        items: ['x', 'y', 'z'],
        index: 1
      };

      const context: EnhancedContext = {
        data: ['x', 'y', 'z']
      };

      const loopContext = new LoopExecutionContext('loop', loopConfig, existingState);
      const result = loopContext.injectVariables(context, true);

      // Should have OptimizedLoopContext structure
      expect(result._currentLoop).toHaveProperty('loopType');
      expect(result._currentLoop).toHaveProperty('isFirstIteration');
      expect(result._currentLoop?.loopType).toBe('forEach');
      expect(result.item).toBe('y');
    });

    it('should use full context when minimal=false', () => {
      const loopConfig: LoopConfig = {
        type: 'forEach',
        items: 'data',
        itemVar: 'item',
        maxIterations: 1000
      };

      const existingState = {
        iteration: 0,
        started: Date.now(),
        items: ['x', 'y', 'z'],
        index: 0
      };

      const context: EnhancedContext = {
        data: ['x', 'y', 'z']
      };

      const loopContext = new LoopExecutionContext('loop', loopConfig, existingState);
      const result = loopContext.injectVariables(context, false);

      // Should inject all variables as before
      expect(result._loopState?.['loop']).toBeDefined();
      expect(result.item).toBe('x');
      expect(result.currentIteration).toBe(1);
    });
  });

  describe('isFirstIteration', () => {
    it('should return true for iteration 0', () => {
      const loopContext = new LoopExecutionContext('loop', { type: 'for', count: 5, maxIterations: 100 });
      expect(loopContext.isFirstIteration()).toBe(true);
    });

    it('should return false for subsequent iterations', () => {
      const existingState = {
        iteration: 3,
        started: Date.now()
      };
      const loopContext = new LoopExecutionContext('loop', { type: 'for', count: 5, maxIterations: 100 }, existingState);
      expect(loopContext.isFirstIteration()).toBe(false);
    });
  });

  describe('isEmpty', () => {
    it('should detect empty forEach loop', () => {
      const loopConfig: LoopConfig = {
        type: 'forEach',
        items: 'emptyArray',
        maxIterations: 1000
      };
      const context: EnhancedContext = {
        emptyArray: []
      };

      const loopContext = new LoopExecutionContext('loop', loopConfig);
      expect(loopContext.isEmpty(context)).toBe(true);
    });

    it('should detect non-empty forEach loop', () => {
      const loopConfig: LoopConfig = {
        type: 'forEach',
        items: 'array',
        maxIterations: 1000
      };
      const context: EnhancedContext = {
        array: [1, 2, 3]
      };

      const loopContext = new LoopExecutionContext('loop', loopConfig);
      expect(loopContext.isEmpty(context)).toBe(false);
    });

    it('should detect zero-count for loop', () => {
      const loopConfig: LoopConfig = {
        type: 'for',
        count: 0,
        maxIterations: 100
      };
      const context: EnhancedContext = {};

      const loopContext = new LoopExecutionContext('loop', loopConfig);
      expect(loopContext.isEmpty(context)).toBe(true);
    });

    it('should handle while loop with false condition', () => {
      const loopConfig: LoopConfig = {
        type: 'while',
        condition: { var: 'continueFlag', equals: true },
        maxIterations: 100
      };
      const context: EnhancedContext = {
        continueFlag: false
      };

      const loopContext = new LoopExecutionContext('loop', loopConfig);
      expect(loopContext.isEmpty(context)).toBe(true);
    });

    it('should handle until loop with true condition', () => {
      const loopConfig: LoopConfig = {
        type: 'until',
        condition: { var: 'counter', equals: 0 },
        maxIterations: 100
      };
      const context: EnhancedContext = {
        counter: 0
      };

      const loopContext = new LoopExecutionContext('loop', loopConfig);
      expect(loopContext.isEmpty(context)).toBe(true);
    });
  });
});