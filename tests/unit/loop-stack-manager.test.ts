import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { LoopStackManager } from '../../src/application/services/loop-stack-manager';
import { LoopStepResolver } from '../../src/application/services/loop-step-resolver';
import { Workflow, WorkflowStep, createWorkflow, createBundledSource, WorkflowDefinition } from '../../src/types/workflow';
import { LoopStep, LoopStackFrame, EnhancedContext } from '../../src/types/workflow-types';
import { 
  LoopStackCorruptionError, 
  EmptyLoopBodyError, 
  LoopBodyResolutionError 
} from '../../src/core/error-handler';
import { container } from 'tsyringe';
import { DI } from '../../src/di/tokens';

describe('LoopStackManager', () => {
  let manager: LoopStackManager;
  let resolver: LoopStepResolver;

  beforeEach(() => {
    // Reset container between tests
    container.clearInstances();
    
    // Register dependencies
    resolver = new LoopStepResolver();
    container.registerInstance(LoopStepResolver, resolver);
    container.registerInstance(DI.Services.LoopContextOptimizer, undefined);
    
    manager = new LoopStackManager(resolver, undefined);
  });

  describe('createLoopFrame', () => {
    it('should create valid frame for single-step loop body (string reference)', () => {
      const workflow = createWorkflow({
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'while', condition: { var: 'count', lt: 3 }, maxIterations: 10 },
            body: 'step-1'
          } as LoopStep,
          { id: 'step-1', title: 'Step 1', prompt: 'Step 1' }
        ]
      }, createBundledSource());

      // Provide count=0 so while condition (count < 3) evaluates to true
      const frame = manager.createLoopFrame(workflow, workflow.definition.steps[0] as LoopStep, { count: 0 });

      expect(frame).not.toBeNull();
      expect(frame!.loopId).toBe('my-loop');
      expect(frame!.bodySteps).toHaveLength(1);
      expect(frame!.bodySteps[0].id).toBe('step-1');
      expect(frame!.currentBodyIndex).toBe(0);
    });

    it('should create valid frame for multi-step loop body (array)', () => {
      const step1: WorkflowStep = { id: 'step-1', title: 'Step 1', prompt: 'Step 1' };
      const step2: WorkflowStep = { id: 'step-2', title: 'Step 2', prompt: 'Step 2' };
      const step3: WorkflowStep = { id: 'step-3', title: 'Step 3', prompt: 'Step 3' };

      const workflow = createWorkflow({
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'for', count: 5, maxIterations: 10 },
            body: [step1, step2, step3]
          } as LoopStep
        ]
      }, createBundledSource());

      const frame = manager.createLoopFrame(workflow, workflow.definition.steps[0] as LoopStep, {});

      expect(frame).not.toBeNull();
      expect(frame!.bodySteps).toHaveLength(3);
      expect(frame!.bodySteps[0].id).toBe('step-1');
      expect(frame!.bodySteps[1].id).toBe('step-2');
      expect(frame!.bodySteps[2].id).toBe('step-3');
    });

    it('should return null if loop condition is false from start', () => {
      const workflow = createWorkflow({
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'while', condition: { var: 'shouldRun', equals: true }, maxIterations: 10 },
            body: 'step-1'
          } as LoopStep,
          { id: 'step-1', title: 'Step 1', prompt: 'Step 1' }
        ]
      }, createBundledSource());

      const frame = manager.createLoopFrame(
        workflow,
        workflow.definition.steps[0] as LoopStep,
        { shouldRun: false }
      );

      expect(frame).toBeNull();
    });

    it('should throw EmptyLoopBodyError for empty body array', () => {
      const workflow = createWorkflow({
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'for', count: 5, maxIterations: 10 },
            body: []
          } as LoopStep
        ]
      }, createBundledSource());

      expect(() =>
        manager.createLoopFrame(workflow, workflow.definition.steps[0] as LoopStep, {})
      ).toThrow(EmptyLoopBodyError);
    });

    it('should throw LoopBodyResolutionError for invalid body reference', () => {
      const workflow = createWorkflow({
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'while', condition: { var: 'x', equals: true }, maxIterations: 10 },
            body: 'nonexistent-step'
          } as LoopStep
        ]
      }, createBundledSource());

      // Provide x=true so loop condition is met and body resolution is attempted
      expect(() =>
        manager.createLoopFrame(workflow, workflow.definition.steps[0] as LoopStep, { x: true })
      ).toThrow(LoopBodyResolutionError);
    });

    it('should preserve warnings when skipping loop', () => {
      const workflow = createWorkflow({
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: {
              type: 'forEach',
              items: 'missingItems',
              maxIterations: 10
            },
            body: 'step-1'
          } as LoopStep,
          { id: 'step-1', title: 'Step 1', prompt: 'Step 1' }
        ]
      }, createBundledSource());

      const context: EnhancedContext = {};
      const frame = manager.createLoopFrame(workflow, workflow.definition.steps[0] as LoopStep, context);

      expect(frame).toBeNull(); // Loop skipped
      expect(context._warnings?.loops?.['my-loop']).toBeDefined();
    });
  });

  describe('handleCurrentLoop', () => {
    it('should return next body step for first iteration', () => {
      const bodyStep: WorkflowStep = { id: 'body', title: 'Body', prompt: 'Body' };
      const loopStep: LoopStep = {
        id: 'loop',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop',
        loop: { type: 'while', condition: { var: 'continue', equals: true }, maxIterations: 10 },
        body: [bodyStep]
      };

      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [loopStep, bodyStep]
      }, createBundledSource());

      const frame = manager.createLoopFrame(workflow, loopStep, { continue: true });
      expect(frame).not.toBeNull();

      const loopStack: LoopStackFrame[] = [frame!];
      const result = manager.handleCurrentLoop(loopStack, [], { continue: true });

      expect(result.type).toBe('step');
      if (result.type === 'step') {
        expect(result.result.step.id).toBe('body');
        expect(result.result.isComplete).toBe(false);
      }
    });

    it('should pop frame and complete when loop condition becomes false', () => {
      const bodyStep: WorkflowStep = { id: 'body', title: 'Body', prompt: 'Body' };
      const loopStep: LoopStep = {
        id: 'loop',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop',
        loop: { type: 'while', condition: { var: 'continue', equals: true }, maxIterations: 10 },
        body: [bodyStep]
      };

      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [loopStep, bodyStep]
      }, createBundledSource());

      const frame = manager.createLoopFrame(workflow, loopStep, { continue: true });
      const loopStack: LoopStackFrame[] = [frame!];
      const completed: string[] = [];

      // Call with condition now false
      const result = manager.handleCurrentLoop(loopStack, completed, { continue: false });

      expect(result.type).toBe('complete');
      expect(loopStack).toHaveLength(0); // Frame popped
      expect(completed).toContain('loop'); // Loop marked complete
    });

    it('should handle multiple iterations without recursion', () => {
      const bodyStep: WorkflowStep = { id: 'body', title: 'Body', prompt: 'Body' };
      const loopStep: LoopStep = {
        id: 'loop',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop',
        loop: { type: 'for', count: 3, maxIterations: 10 },
        body: [bodyStep]
      };

      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [loopStep, bodyStep]
      }, createBundledSource());

      const frame = manager.createLoopFrame(workflow, loopStep, {});
      const loopStack: LoopStackFrame[] = [frame!];
      const completed: string[] = [];
      let context: EnhancedContext = {};

      // Iteration 1
      let result = manager.handleCurrentLoop(loopStack, completed, context);
      expect(result.type).toBe('step');
      if (result.type === 'step') {
        context = result.result.context;
        completed.push('body');
      }

      // Iteration 2
      result = manager.handleCurrentLoop(loopStack, completed, context);
      expect(result.type).toBe('step');
      if (result.type === 'step') {
        context = result.result.context;
        completed.push('body');
      }

      // Iteration 3
      result = manager.handleCurrentLoop(loopStack, completed, context);
      expect(result.type).toBe('step');
      if (result.type === 'step') {
        context = result.result.context;
        completed.push('body');
      }

      // Should complete after 3 iterations (count: 3)
      result = manager.handleCurrentLoop(loopStack, completed, context);
      expect(result.type).toBe('complete');
      expect(loopStack).toHaveLength(0);
    });

    it('should skip body steps with false runConditions', () => {
      const step1: WorkflowStep = { 
        id: 'step-1', 
        title: 'Step 1', 
        prompt: 'Step 1',
        runCondition: { var: 'doStep1', equals: true }
      };
      const step2: WorkflowStep = { 
        id: 'step-2', 
        title: 'Step 2', 
        prompt: 'Step 2',
        runCondition: { var: 'doStep2', equals: true }
      };

      const loopStep: LoopStep = {
        id: 'loop',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop',
        loop: { type: 'for', count: 1, maxIterations: 10 },
        body: [step1, step2]
      };

      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [loopStep, step1, step2]
      }, createBundledSource());

      const frame = manager.createLoopFrame(workflow, loopStep, { doStep1: false, doStep2: true });
      const loopStack: LoopStackFrame[] = [frame!];

      // Should skip step-1 (condition false) and return step-2
      const result = manager.handleCurrentLoop(loopStack, [], { doStep1: false, doStep2: true });

      expect(result.type).toBe('step');
      if (result.type === 'step') {
        expect(result.result.step.id).toBe('step-2');
      }
    });

    it('should throw LoopStackCorruptionError if frame index is negative', () => {
      // Create a mock loopContext with required methods
      const mockLoopContext = {
        getCurrentState: () => ({ iteration: 0, items: [], index: 0 }),
        shouldContinue: () => true,
        incrementIteration: () => {},
        isFirstIteration: () => true,
        injectVariables: (ctx: any) => ctx
      };

      const frame: LoopStackFrame = {
        loopId: 'loop',
        loopStep: {} as LoopStep,
        loopContext: mockLoopContext as any,
        bodySteps: [{ id: 'step', title: 'Step', prompt: 'Step' }],
        currentBodyIndex: -1  // Invalid!
      };

      const loopStack = [frame];

      // Should throw LoopStackCorruptionError with message about invalid structure or negative index
      expect(() =>
        manager.handleCurrentLoop(loopStack, [], {})
      ).toThrow(LoopStackCorruptionError);
    });

    it('should throw LoopStackCorruptionError if frame index exceeds length', () => {
      // Create a mock loopContext with required methods
      const mockLoopContext = {
        getCurrentState: () => ({ iteration: 0, items: [], index: 0 }),
        shouldContinue: () => true,
        incrementIteration: () => {},
        isFirstIteration: () => true,
        injectVariables: (ctx: any) => ctx
      };

      const frame: LoopStackFrame = {
        loopId: 'loop',
        loopStep: {} as LoopStep,
        loopContext: mockLoopContext as any,
        bodySteps: [{ id: 'step', title: 'Step', prompt: 'Step' }],
        currentBodyIndex: 5  // > bodySteps.length!
      };

      const loopStack = [frame];

      // Should throw LoopStackCorruptionError with message about invalid structure
      expect(() =>
        manager.handleCurrentLoop(loopStack, [], {})
      ).toThrow(LoopStackCorruptionError);
    });

    it('should clear completed body steps between iterations', () => {
      const bodyStep: WorkflowStep = { id: 'body', title: 'Body', prompt: 'Body' };
      const loopStep: LoopStep = {
        id: 'loop',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop',
        loop: { type: 'for', count: 2, maxIterations: 10 },
        body: [bodyStep]
      };

      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [loopStep, bodyStep]
      }, createBundledSource());

      const frame = manager.createLoopFrame(workflow, loopStep, {});
      const loopStack: LoopStackFrame[] = [frame!];
      const completed: string[] = [];
      let context: EnhancedContext = {};

      // Iteration 1 - complete body step
      let result = manager.handleCurrentLoop(loopStack, completed, context);
      expect(result.type).toBe('step');
      completed.push('body');
      context = (result as any).result.context;

      // Iteration 2 - body should be available again (completed cleared internally)
      result = manager.handleCurrentLoop(loopStack, completed, context);
      expect(result.type).toBe('step');
      if (result.type === 'step') {
        expect(result.result.step.id).toBe('body');
      }
    });
  });

  describe('Runtime Invariant Checks', () => {
    it('can be disabled via environment variable', () => {
      const originalEnv = process.env.SKIP_INVARIANT_CHECKS;
      
      try {
        process.env.SKIP_INVARIANT_CHECKS = 'true';

        // Create a mock loopContext with required methods
        const mockLoopContext = {
          getCurrentState: () => ({ iteration: 0, items: [], index: 0 }),
          shouldContinue: () => false, // Will exit loop immediately
          incrementIteration: () => {},
          isFirstIteration: () => true,
          injectVariables: (ctx: any) => ctx
        };

        const invalidFrame: LoopStackFrame = {
          loopId: 'loop',
          loopStep: {} as LoopStep,
          loopContext: mockLoopContext as any,
          bodySteps: [],  // Empty - normally would throw but checks are disabled
          currentBodyIndex: 0
        };

        const loopStack = [invalidFrame];

        // Should NOT throw when invariant checks are disabled
        // The loop will exit because shouldContinue returns false
        expect(() =>
          manager.handleCurrentLoop(loopStack, [], {})
        ).not.toThrow();
      } finally {
        if (originalEnv !== undefined) {
          process.env.SKIP_INVARIANT_CHECKS = originalEnv;
        } else {
          delete process.env.SKIP_INVARIANT_CHECKS;
        }
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle forEach loop with empty items array', () => {
      const workflow = createWorkflow({
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'forEach', items: 'items', maxIterations: 10 },
            body: 'step-1'
          } as LoopStep,
          { id: 'step-1', title: 'Step 1', prompt: 'Step 1' }
        ]
      }, createBundledSource());

      const context: EnhancedContext = { items: [] };
      const frame = manager.createLoopFrame(workflow, workflow.definition.steps[0] as LoopStep, context);

      // Should return null (loop has no items to iterate)
      expect(frame).toBeNull();
      
      // Empty array is valid - no warning should be added
      // Warnings are only added for missing or non-array items
    });

    it('should handle all body steps already completed', () => {
      const bodyStep: WorkflowStep = { id: 'body', title: 'Body', prompt: 'Body' };
      const loopStep: LoopStep = {
        id: 'loop',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop',
        loop: { type: 'for', count: 5, maxIterations: 10 },
        body: [bodyStep]
      };

      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [loopStep, bodyStep]
      }, createBundledSource());

      const frame = manager.createLoopFrame(workflow, loopStep, {});
      const loopStack: LoopStackFrame[] = [frame!];
      const completed: string[] = ['body']; // Already completed
      let context: EnhancedContext = {};

      // Should increment iteration and continue (not return step)
      const result = manager.handleCurrentLoop(loopStack, completed, context);
      
      // Iteration counter should increment
      expect(frame!.loopContext.getCurrentState().iteration).toBeGreaterThan(0);
    });
  });
});
