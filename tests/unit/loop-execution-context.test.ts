import { describe, vi, it, expect, beforeEach, jest } from 'vitest';
import { LoopExecutionContext } from '../../src/application/services/loop-execution-context';
import { LoopConfig } from '../../src/types/workflow-types';
import { ConditionContext } from '../../src/utils/condition-evaluator';

describe('LoopExecutionContext', () => {
  let mockDateNow: jest.SpiedFunction<typeof Date.now>;
  
  beforeEach(() => {
    mockDateNow = vi.spyOn(Date, 'now');
    mockDateNow.mockReturnValue(1000000);
  });

  afterEach(() => {
    mockDateNow.mockRestore();
  });

  describe('constructor', () => {
    it('should initialize with default state', () => {
      const config: LoopConfig = {
        type: 'while',
        maxIterations: 10
      };
      
      const context = new LoopExecutionContext('test-loop', config);
      const state = context.getCurrentState();
      
      expect(state.iteration).toBe(0);
      expect(state.started).toBe(1000000);
      expect(state.warnings).toEqual([]);
    });

    it('should initialize forEach loop with index', () => {
      const config: LoopConfig = {
        type: 'forEach',
        items: 'myItems',
        maxIterations: 10
      };
      
      const context = new LoopExecutionContext('test-loop', config);
      const state = context.getCurrentState();
      
      expect(state.index).toBe(0);
    });

    it('should use existing state if provided', () => {
      const config: LoopConfig = {
        type: 'while',
        maxIterations: 10
      };
      
      const existingState = {
        iteration: 5,
        started: 500000,
        warnings: ['existing warning']
      };
      
      const context = new LoopExecutionContext('test-loop', config, existingState);
      const state = context.getCurrentState();
      
      expect(state.iteration).toBe(5);
      expect(state.started).toBe(500000);
      expect(state.warnings).toEqual(['existing warning']);
    });
  });

  describe('incrementIteration', () => {
    it('should increment iteration counter', () => {
      const config: LoopConfig = {
        type: 'while',
        maxIterations: 10
      };
      
      const context = new LoopExecutionContext('test-loop', config);
      context.incrementIteration();
      
      expect(context.getCurrentState().iteration).toBe(1);
    });

    it('should increment index for forEach loops', () => {
      const config: LoopConfig = {
        type: 'forEach',
        items: 'myItems',
        maxIterations: 10
      };
      
      const context = new LoopExecutionContext('test-loop', config);
      const executionContext: ConditionContext = { myItems: ['a', 'b', 'c'] };
      context.initializeForEach(executionContext);
      
      context.incrementIteration();
      expect(context.getCurrentState().index).toBe(1);
    });
  });

  describe('shouldContinue', () => {
    describe('iteration limits', () => {
      it('should stop when max iterations reached', () => {
        const config: LoopConfig = {
          type: 'for',
          count: 10,
          maxIterations: 5
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        const executionContext: ConditionContext = {};
        
        // Simulate 5 iterations
        for (let i = 0; i < 5; i++) {
          expect(context.shouldContinue(executionContext)).toBe(true);
          context.incrementIteration();
        }
        
        // 6th iteration should fail
        expect(context.shouldContinue(executionContext)).toBe(false);
        expect(context.getCurrentState().warnings).toContain('Maximum iterations (5) reached');
      });
    });

    describe('execution time limits', () => {
      it('should stop when execution time exceeded', () => {
        const config: LoopConfig = {
          type: 'while',
          condition: { var: 'continue', equals: true },
          maxIterations: 100
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        const executionContext: ConditionContext = { continue: true };
        
        // Mock time passing beyond 5 minutes
        mockDateNow.mockReturnValue(1000000 + 6 * 60 * 1000);
        
        expect(context.shouldContinue(executionContext)).toBe(false);
        expect(context.getCurrentState().warnings).toContain('Maximum execution time (300s) exceeded');
      });
    });

    describe('while loops', () => {
      it('should continue while condition is true', () => {
        const config: LoopConfig = {
          type: 'while',
          condition: { var: 'continue', equals: true },
          maxIterations: 10
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        
        expect(context.shouldContinue({ continue: true })).toBe(true);
        expect(context.shouldContinue({ continue: false })).toBe(false);
      });
    });

    describe('until loops', () => {
      it('should continue until condition is true', () => {
        const config: LoopConfig = {
          type: 'until',
          condition: { var: 'done', equals: true },
          maxIterations: 10
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        
        expect(context.shouldContinue({ done: false })).toBe(true);
        expect(context.shouldContinue({ done: true })).toBe(false);
      });
    });

    describe('for loops', () => {
      it('should iterate exact number of times with numeric count', () => {
        const config: LoopConfig = {
          type: 'for',
          count: 3,
          maxIterations: 10
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        const executionContext: ConditionContext = {};
        
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(false);
      });

      it('should resolve count from context variable', () => {
        const config: LoopConfig = {
          type: 'for',
          count: 'iterations',
          maxIterations: 10
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        const executionContext: ConditionContext = { iterations: 2 };
        
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(false);
      });
    });

    describe('forEach loops', () => {
      it('should iterate over array items', () => {
        const config: LoopConfig = {
          type: 'forEach',
          items: 'myItems',
          maxIterations: 10
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        const executionContext: ConditionContext = { myItems: ['a', 'b', 'c'] };
        
        context.initializeForEach(executionContext);
        
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(true);
        context.incrementIteration();
        expect(context.shouldContinue(executionContext)).toBe(false);
      });

      it('should handle empty arrays', () => {
        const config: LoopConfig = {
          type: 'forEach',
          items: 'myItems',
          maxIterations: 10
        };
        
        const context = new LoopExecutionContext('test-loop', config);
        const executionContext: ConditionContext = { myItems: [] };
        
        context.initializeForEach(executionContext);
        expect(context.shouldContinue(executionContext)).toBe(false);
      });
    });
  });

  describe('initializeForEach', () => {
    it('should initialize items from context', () => {
      const config: LoopConfig = {
        type: 'forEach',
        items: 'myItems',
        maxIterations: 10
      };

      const context = new LoopExecutionContext('test-loop', config);
      const executionContext: ConditionContext = { myItems: ['a', 'b', 'c'] };

      context.initializeForEach(executionContext);
      const state = context.getCurrentState();

      expect(state.items).toEqual(['a', 'b', 'c']);
      expect(state.index).toBe(0);
    });

    it('should handle non-array values', () => {
      const config: LoopConfig = {
        type: 'forEach',
        items: 'myItems',
        maxIterations: 10
      };

      const context = new LoopExecutionContext('test-loop', config);
      const executionContext: ConditionContext = { myItems: 'not an array' };

      context.initializeForEach(executionContext);
      const state = context.getCurrentState();

      expect(state.items).toEqual([]);
      expect(state.warnings).toContain("Expected array for forEach items 'myItems', got string");
    });

    it('should reset items and index when called multiple times', () => {
      const config: LoopConfig = {
        type: 'forEach',
        items: 'myItems',
        maxIterations: 10
      };

      const context = new LoopExecutionContext('test-loop', config);

      const firstContext: ConditionContext = { myItems: ['first', 'second'] };
      context.initializeForEach(firstContext);
      context.incrementIteration(); // advance index
      expect(context.getCurrentState().index).toBe(1);

      const secondContext: ConditionContext = { myItems: ['x', 'y', 'z'] };
      context.initializeForEach(secondContext);
      const state = context.getCurrentState();

      expect(state.items).toEqual(['x', 'y', 'z']);
      expect(state.index).toBe(0);
    });
  });

  describe('injectVariables', () => {
    it('should inject iteration counter with default name', () => {
      const config: LoopConfig = {
        type: 'while',
        maxIterations: 10
      };
      
      const loopContext = new LoopExecutionContext('test-loop', config);
      loopContext.incrementIteration();
      loopContext.incrementIteration();
      
      const context: ConditionContext = { existingVar: 'value' };
      const enhanced = loopContext.injectVariables(context);
      
      expect(enhanced.currentIteration).toBe(3);
      expect(enhanced.existingVar).toBe('value');
      expect(enhanced._loopState?.['test-loop'].iteration).toBe(2);
    });

    it('should inject iteration counter with custom name', () => {
      const config: LoopConfig = {
        type: 'while',
        maxIterations: 10,
        iterationVar: 'myCounter'
      };
      
      const loopContext = new LoopExecutionContext('test-loop', config);
      loopContext.incrementIteration();
      
      const enhanced = loopContext.injectVariables({});
      
      expect(enhanced.myCounter).toBe(2);
      expect(enhanced.currentIteration).toBeUndefined();
    });

    it('should inject forEach variables', () => {
      const config: LoopConfig = {
        type: 'forEach',
        items: 'myItems',
        maxIterations: 10,
        itemVar: 'item',
        indexVar: 'idx'
      };
      
      const loopContext = new LoopExecutionContext('test-loop', config);
      const executionContext: ConditionContext = { myItems: ['apple', 'banana', 'cherry'] };
      
      loopContext.initializeForEach(executionContext);
      loopContext.incrementIteration(); // Move to second item
      
      const enhanced = loopContext.injectVariables(executionContext);
      
      expect(enhanced.item).toBe('banana');
      expect(enhanced.idx).toBe(1);
      expect(enhanced.currentIteration).toBe(2);
    });

    it('should inject warnings', () => {
      const config: LoopConfig = {
        type: 'for',
        count: 3,
        maxIterations: 2
      };
      
      const loopContext = new LoopExecutionContext('test-loop', config);
      const context: ConditionContext = {};
      
      // Force warning by exceeding max iterations
      loopContext.incrementIteration();
      loopContext.incrementIteration();
      loopContext.shouldContinue(context); // This will add warning
      
      const enhanced = loopContext.injectVariables(context);
      
      expect(enhanced._warnings?.loops?.['test-loop']).toContain('Maximum iterations (2) reached');
    });
  });

  describe('helper methods', () => {
    it('should return loop ID', () => {
      const config: LoopConfig = {
        type: 'while',
        maxIterations: 10
      };
      
      const context = new LoopExecutionContext('my-loop-id', config);
      expect(context.getLoopId()).toBe('my-loop-id');
    });

    it('should return loop config copy', () => {
      const config: LoopConfig = {
        type: 'while',
        maxIterations: 10
      };
      
      const context = new LoopExecutionContext('test-loop', config);
      const returnedConfig = context.getLoopConfig();
      
      expect(returnedConfig).toEqual(config);
      expect(returnedConfig).not.toBe(config); // Should be a copy
    });
  });
}); 