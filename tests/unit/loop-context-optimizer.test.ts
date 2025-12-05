import { LoopContextOptimizer } from '../../src/application/services/loop-context-optimizer';
import { EnhancedContext, LoopStep, OptimizedLoopContext } from '../../src/types/workflow-types';

describe('LoopContextOptimizer', () => {
  let optimizer: LoopContextOptimizer;

  beforeEach(() => {
    optimizer = new LoopContextOptimizer();
  });

  describe('optimizeLoopContext', () => {
    it('should create optimized context for first iteration', () => {
      const context: EnhancedContext = {
        someVar: 'value',
        _currentLoop: {
          loopId: 'test-loop',
          loopStep: {
            id: 'test-loop',
            type: 'loop',
            title: 'Test Loop',
            prompt: 'Test prompt',
            loop: { type: 'for', count: 5, maxIterations: 100 },
            body: 'test-step'
          } as LoopStep
        }
      };

      const result = optimizer.optimizeLoopContext(context, 0);

      expect(result._currentLoop).toEqual({
        loopId: 'test-loop',
        loopType: 'for',
        iteration: 0,
        isFirstIteration: true
      });
      expect(result.someVar).toBe('value');
    });

    it('should add phase reference for subsequent iterations', () => {
      const loopStep: LoopStep = {
        id: 'test-loop',
        type: 'loop',
        title: 'Test Loop Phase',
        prompt: 'Test prompt',
        loop: { type: 'forEach', items: 'testArray', maxIterations: 1000 },
        body: [
          { id: 'step1', title: 'Step 1', prompt: 'Do step 1' },
          { id: 'step2', title: 'Step 2', prompt: 'Do step 2' }
        ],
        functionDefinitions: [
          { name: 'testFunc', definition: 'Test function' }
        ]
      };

      const context: EnhancedContext = {
        testArray: ['item1', 'item2'],
        _currentLoop: {
          loopId: 'test-loop',
          loopStep
        }
      };

      const result = optimizer.optimizeLoopContext(context, 1);

      expect(result._currentLoop?.isFirstIteration).toBe(false);
      expect(result._currentLoop?.phaseReference).toEqual({
        loopId: 'test-loop',
        phaseTitle: 'Test Loop Phase',
        totalSteps: 2,
        functionDefinitions: [
          { name: 'testFunc', definition: 'Test function' }
        ]
      });
    });

    it('should throw error if no active loop', () => {
      const context: EnhancedContext = {
        someVar: 'value'
      };

      expect(() => optimizer.optimizeLoopContext(context, 0))
        .toThrow('Cannot optimize context without active loop');
    });
  });

  describe('createPhaseReference', () => {
    it('should create phase reference with function definitions', () => {
      const loopStep: LoopStep = {
        id: 'test-loop',
        type: 'loop',
        title: 'Complex Loop',
        prompt: 'Test prompt',
        loop: { type: 'while', condition: { var: 'continueFlag', equals: true }, maxIterations: 100 },
        body: [
          { id: 'step1', title: 'Step 1', prompt: 'Do step 1' },
          { id: 'step2', title: 'Step 2', prompt: 'Do step 2' },
          { id: 'step3', title: 'Step 3', prompt: 'Do step 3' }
        ],
        functionDefinitions: [
          { name: 'processItem', definition: 'Process each item', scope: 'loop' }
        ]
      };

      const result = optimizer.createPhaseReference(loopStep);

      expect(result).toEqual({
        loopId: 'test-loop',
        phaseTitle: 'Complex Loop',
        totalSteps: 3,
        functionDefinitions: [
          { name: 'processItem', definition: 'Process each item', scope: 'loop' }
        ]
      });
    });

    it('should handle single step body', () => {
      const loopStep: LoopStep = {
        id: 'simple-loop',
        type: 'loop',
        title: 'Simple Loop',
        prompt: 'Test prompt',
        loop: { type: 'for', count: 10, maxIterations: 100 },
        body: 'single-step'
      };

      const result = optimizer.createPhaseReference(loopStep);

      expect(result.totalSteps).toBe(1);
      expect(result.functionDefinitions).toBeUndefined();
    });
  });

  describe('hasLoopItems', () => {
    it('should return true for forEach loop with items', () => {
      const context: EnhancedContext = {
        myItems: ['a', 'b', 'c']
      };
      const loopStep: LoopStep = {
        id: 'for-each-loop',
        type: 'loop',
        title: 'ForEach Loop',
        prompt: 'Test prompt',
        loop: { type: 'forEach', items: 'myItems', maxIterations: 1000 },
        body: 'step'
      };

      expect(optimizer.hasLoopItems(context, loopStep)).toBe(true);
    });

    it('should return false for forEach loop with empty array', () => {
      const context: EnhancedContext = {
        myItems: []
      };
      const loopStep: LoopStep = {
        id: 'for-each-loop',
        type: 'loop',
        title: 'ForEach Loop',
        prompt: 'Test prompt',
        loop: { type: 'forEach', items: 'myItems', maxIterations: 1000 },
        body: 'step'
      };

      expect(optimizer.hasLoopItems(context, loopStep)).toBe(false);
    });

    it('should return true for for loop with positive count', () => {
      const context: EnhancedContext = {};
      const loopStep: LoopStep = {
        id: 'for-loop',
        type: 'loop',
        title: 'For Loop',
        prompt: 'Test prompt',
        loop: { type: 'for', count: 5, maxIterations: 100 },
        body: 'step'
      };

      expect(optimizer.hasLoopItems(context, loopStep)).toBe(true);
    });

    it('should return false for for loop with zero count', () => {
      const context: EnhancedContext = {};
      const loopStep: LoopStep = {
        id: 'for-loop',
        type: 'loop',
        title: 'For Loop',
        prompt: 'Test prompt',
        loop: { type: 'for', count: 0, maxIterations: 100 },
        body: 'step'
      };

      expect(optimizer.hasLoopItems(context, loopStep)).toBe(false);
    });

    it('should return true for while/until loops', () => {
      const context: EnhancedContext = {};
      const whileLoop: LoopStep = {
        id: 'while-loop',
        type: 'loop',
        title: 'While Loop',
        prompt: 'Test prompt',
        loop: { type: 'while', condition: { var: 'flag', equals: true }, maxIterations: 100 },
        body: 'step'
      };

      expect(optimizer.hasLoopItems(context, whileLoop)).toBe(true);
    });
  });

  describe('stripLoopMetadata', () => {
    it('should minimize forEach loop arrays', () => {
      const context: EnhancedContext = {
        largeArray: Array(100).fill('item'),
        _loopState: {
          'test-loop': {
            iteration: 2,
            started: Date.now(),
            items: Array(100).fill('item'),
            index: 2
          }
        },
        _currentLoop: {
          loopId: 'test-loop',
          loopStep: {
            id: 'test-loop',
            type: 'loop',
            title: 'Test',
            prompt: 'Test',
            loop: { type: 'forEach', items: 'largeArray' },
            body: 'step'
          } as LoopStep
        }
      };

      const result = optimizer.stripLoopMetadata(context);
      const loopState = result._loopState?.['test-loop'];

      expect(loopState?.items).toHaveLength(1);
      expect(loopState?.items?.[0]).toBe('item');
      expect(loopState?.index).toBe(0);
    });

    it('should remove large arrays not being iterated', () => {
      const context: EnhancedContext = {
        unrelatedLargeArray: Array(50).fill('data'),
        smallArray: [1, 2, 3],
        _currentLoop: {
          loopId: 'test-loop',
          loopStep: {
            id: 'test-loop',
            type: 'loop',
            title: 'Test',
            prompt: 'Test',
            loop: { type: 'for', count: 3 },
            body: 'step'
          } as LoopStep
        }
      };

      const result = optimizer.stripLoopMetadata(context);

      expect(result.unrelatedLargeArray).toBeUndefined();
      expect(result.smallArray).toEqual([1, 2, 3]);
    });

    it('should handle contexts without loops', () => {
      const context: EnhancedContext = {
        someData: 'value'
      };

      const result = optimizer.stripLoopMetadata(context);

      expect(result.someData).toBe('value');
    });
  });
});