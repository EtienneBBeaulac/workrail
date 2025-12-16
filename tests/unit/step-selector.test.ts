import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultStepSelector } from '../../src/application/services/step-selector';
import { Workflow, createWorkflow, createBundledSource, WorkflowDefinition } from '../../src/types/workflow';
import { EnhancedContext } from '../../src/types/workflow-types';

describe('DefaultStepSelector', () => {
  let selector: DefaultStepSelector;

  beforeEach(() => {
    selector = new DefaultStepSelector();
  });

  describe('findEligibleStep', () => {
    it('should find first uncompleted step', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do 1' },
          { id: 'step-2', title: 'Step 2', prompt: 'Do 2' },
          { id: 'step-3', title: 'Step 3', prompt: 'Do 3' }
        ]
      }, createBundledSource());

      const result = selector.findEligibleStep(workflow, new Set(), [], {});

      expect(result?.id).toBe('step-1');
    });

    it('should skip completed steps', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do 1' },
          { id: 'step-2', title: 'Step 2', prompt: 'Do 2' }
        ]
      }, createBundledSource());

      const result = selector.findEligibleStep(workflow, new Set(), ['step-1'], {});

      expect(result?.id).toBe('step-2');
    });

    it('should evaluate runCondition', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { 
            id: 'conditional-step', 
            title: 'Conditional', 
            prompt: 'Do conditional',
            runCondition: { var: 'enabled', equals: true }
          }
        ]
      }, createBundledSource());

      // Condition not met
      let result = selector.findEligibleStep(workflow, new Set(), [], { enabled: false });
      expect(result).toBeNull();

      // Condition met
      result = selector.findEligibleStep(workflow, new Set(), [], { enabled: true });
      expect(result?.id).toBe('conditional-step');
    });

    it('should skip loop body steps when not in loop', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'body-step', title: 'Body', prompt: 'Body' },
          { id: 'regular-step', title: 'Regular', prompt: 'Regular' }
        ]
      }, createBundledSource());

      const loopBodySteps = new Set(['body-step']);
      const result = selector.findEligibleStep(workflow, loopBodySteps, [], {});

      expect(result?.id).toBe('regular-step');
    });

    it('should allow loop body steps when in that loop', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'body-step', title: 'Body', prompt: 'Body' }
        ]
      }, createBundledSource());

      const loopBodySteps = new Set(['body-step']);
      const context: EnhancedContext = {
        _loopStack: [{
          loopId: 'test-loop',
          loopStep: {} as any,
          loopContext: {} as any,
          bodySteps: [{ id: 'body-step', title: 'Body', prompt: 'Body' }],
          currentBodyIndex: 0
        }]
      };

      const result = selector.findEligibleStep(workflow, loopBodySteps, [], context);

      expect(result?.id).toBe('body-step');
    });
  });

  describe('handleNoEligibleStep', () => {
    it('should return null when no conditional steps remain', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do 1' }
        ]
      }, createBundledSource());

      const result = selector.handleNoEligibleStep(workflow, ['step-1'], {}, new Set());

      expect(result).toBeNull();
    });

    it('should provide guidance for missing variable', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'conditional',
            title: 'Conditional',
            prompt: 'Do conditional',
            runCondition: { var: 'mode', equals: 'active' }
          }
        ]
      }, createBundledSource());

      const result = selector.handleNoEligibleStep(workflow, [], {}, new Set());

      expect(result).not.toBeNull();
      expect(result?.prompt).toContain('Set \'mode\' to one of: \'active\'');
    });

    it('should provide guidance for wrong value', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'conditional',
            title: 'Conditional',
            prompt: 'Do conditional',
            runCondition: { var: 'status', equals: 'ready' }
          }
        ]
      }, createBundledSource());

      const result = selector.handleNoEligibleStep(workflow, [], { status: 'pending' }, new Set());

      expect(result).not.toBeNull();
      expect(result?.prompt).toContain('Adjust \'status\' to one of: \'ready\'');
    });

    it('should handle case-insensitive mismatch', () => {
      const workflow = createWorkflow({
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'conditional',
            title: 'Conditional',
            prompt: 'Do conditional',
            runCondition: { var: 'mode', equals: 'ACTIVE' }
          }
        ]
      }, createBundledSource());

      const result = selector.handleNoEligibleStep(workflow, [], { mode: 'active' }, new Set());

      expect(result).not.toBeNull();
      expect(result?.prompt).toContain('Normalize casing for \'mode\'');
    });
  });
});
