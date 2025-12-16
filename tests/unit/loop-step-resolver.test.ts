import { describe, it, expect, beforeEach, jest } from 'vitest';
import { LoopStepResolver } from '../../src/application/services/loop-step-resolver';
import { Workflow, WorkflowStep, createWorkflow, createBundledSource, WorkflowDefinition } from '../../src/types/workflow';
import { LoopStep } from '../../src/types/workflow-types';
import { StepNotFoundError } from '../../src/core/error-handler';

describe('LoopStepResolver', () => {
  let resolver: LoopStepResolver;
  
  const mockWorkflow = createWorkflow({
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'Test workflow with loops',
    version: '0.1.0',
    steps: [
      {
        id: 'step1',
        title: 'Step 1',
        prompt: 'First step'
      },
      {
        id: 'loop-step',
        type: 'loop',
        title: 'Loop Step',
        prompt: 'Loop',
        loop: {
          type: 'forEach',
          items: 'items',
          maxIterations: 10
        },
        body: 'step2'
      } as LoopStep,
      {
        id: 'step2',
        title: 'Step 2',
        prompt: 'Step inside loop'
      },
      {
        id: 'nested-loop',
        type: 'loop',
        title: 'Nested Loop',
        prompt: 'Another loop',
        loop: {
          type: 'while',
          condition: { var: 'continue', equals: true },
          maxIterations: 5
        },
        body: 'step3'
      } as LoopStep,
      {
        id: 'step3',
        title: 'Step 3',
        prompt: 'Third step'
      }
    ]
  }, createBundledSource());

  beforeEach(() => {
    resolver = new LoopStepResolver();
  });

  describe('resolveLoopBody', () => {
    it('should resolve string reference to a step', () => {
      const result = resolver.resolveLoopBody(mockWorkflow, 'step2');
      expect(result).toBeDefined();
      expect((result as WorkflowStep).id).toBe('step2');
      expect((result as WorkflowStep).title).toBe('Step 2');
    });

    it('should return inline steps array directly', () => {
      const inlineSteps: WorkflowStep[] = [
        { id: 'inline1', title: 'Inline 1', prompt: 'First inline' },
        { id: 'inline2', title: 'Inline 2', prompt: 'Second inline' }
      ];
      
      const result = resolver.resolveLoopBody(mockWorkflow, inlineSteps);
      expect(result).toBe(inlineSteps);
    });

    it('should throw error for non-existent step reference', () => {
      expect(() => {
        resolver.resolveLoopBody(mockWorkflow, 'non-existent');
      }).toThrow(StepNotFoundError);
    });

    it('should prevent self-referencing loop steps', () => {
      const selfRefWorkflow = createWorkflow({
        ...mockWorkflow,
        steps: [
          {
            id: 'self-loop',
            type: 'loop',
            title: 'Self Loop',
            prompt: 'Self referencing',
            loop: {
              type: 'while',
              condition: { var: 'x', equals: true },
              maxIterations: 5
            },
            body: 'self-loop'
          } as LoopStep
        ]
      }, createBundledSource());

      expect(() => {
        resolver.resolveLoopBody(selfRefWorkflow, 'self-loop', 'self-loop');
      }).toThrow('Circular reference detected');
    });

    it('should cache resolved steps', () => {
      // First call
      const result1 = resolver.resolveLoopBody(mockWorkflow, 'step2');
      expect(resolver.getCacheSize()).toBe(1);
      
      // Second call should use cache
      const result2 = resolver.resolveLoopBody(mockWorkflow, 'step2');
      expect(result1).toBe(result2);
      expect(resolver.getCacheSize()).toBe(1);
    });

    it('should allow loops to reference other loops', () => {
      const result = resolver.resolveLoopBody(mockWorkflow, 'nested-loop');
      expect(result).toBeDefined();
      expect((result as LoopStep).type).toBe('loop');
      expect((result as LoopStep).id).toBe('nested-loop');
    });
  });

  describe('validateStepReference', () => {
    it('should return true for existing step', () => {
      expect(resolver.validateStepReference(mockWorkflow, 'step2')).toBe(true);
      expect(resolver.validateStepReference(mockWorkflow, 'loop-step')).toBe(true);
    });

    it('should return false for non-existent step', () => {
      expect(resolver.validateStepReference(mockWorkflow, 'non-existent')).toBe(false);
    });
  });

  describe('findAllLoopReferences', () => {
    it('should find all string references in loops', () => {
      const references = resolver.findAllLoopReferences(mockWorkflow);
      expect(references).toHaveLength(2);
      expect(references).toContain('step2');
      expect(references).toContain('step3');
    });

    it('should ignore inline step arrays', () => {
      const workflowWithInline = createWorkflow({
        ...mockWorkflow,
        steps: [
          {
            id: 'inline-loop',
            type: 'loop',
            title: 'Inline Loop',
            prompt: 'Loop with inline steps',
            loop: {
              type: 'forEach',
              items: 'items',
              maxIterations: 10
            },
            body: [
              { id: 'inline1', title: 'Inline 1', prompt: 'First' },
              { id: 'inline2', title: 'Inline 2', prompt: 'Second' }
            ]
          } as LoopStep
        ]
      }, createBundledSource());

      const references = resolver.findAllLoopReferences(workflowWithInline);
      expect(references).toHaveLength(0);
    });
  });

  describe('validateAllReferences', () => {
    it('should pass for valid workflow', () => {
      expect(() => {
        resolver.validateAllReferences(mockWorkflow);
      }).not.toThrow();
    });

    it('should throw for invalid reference', () => {
      const invalidWorkflow = createWorkflow({
        ...mockWorkflow,
        steps: [
          ...mockWorkflow.definition.steps,
          {
            id: 'bad-loop',
            type: 'loop',
            title: 'Bad Loop',
            prompt: 'Invalid reference',
            loop: {
              type: 'while',
              condition: { var: 'x', equals: true },
              maxIterations: 5
            },
            body: 'non-existent-step'
          } as LoopStep
        ]
      }, createBundledSource());

      expect(() => {
        resolver.validateAllReferences(invalidWorkflow);
      }).toThrow(StepNotFoundError);
    });

    it('should throw for self-referencing loops', () => {
      const selfRefWorkflow = createWorkflow({
        ...mockWorkflow,
        steps: [
          {
            id: 'self-ref',
            type: 'loop',
            title: 'Self Ref',
            prompt: 'Self reference',
            loop: {
              type: 'while',
              condition: { var: 'x', equals: true },
              maxIterations: 5
            },
            body: 'self-ref'
          } as LoopStep
        ]
      }, createBundledSource());

      expect(() => {
        resolver.validateAllReferences(selfRefWorkflow);
      }).toThrow('Circular reference detected');
    });
  });

  describe('cache management', () => {
    it('should clear cache', () => {
      resolver.resolveLoopBody(mockWorkflow, 'step2');
      expect(resolver.getCacheSize()).toBe(1);
      
      resolver.clearCache();
      expect(resolver.getCacheSize()).toBe(0);
    });

    it('should maintain separate cache entries for different workflows', () => {
      const anotherWorkflow = createWorkflow({
        ...mockWorkflow.definition,
        id: 'another-workflow'
      }, createBundledSource());

      resolver.resolveLoopBody(mockWorkflow, 'step2');
      resolver.resolveLoopBody(anotherWorkflow, 'step2');
      
      expect(resolver.getCacheSize()).toBe(2);
    });
  });
}); 