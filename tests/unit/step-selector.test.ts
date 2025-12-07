import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultStepSelector } from '../../src/application/services/step-selector';
import { Workflow } from '../../src/types/mcp-types';
import { EnhancedContext } from '../../src/types/workflow-types';
import { FakeLoggerFactory } from '../helpers/FakeLoggerFactory.js';

describe('DefaultStepSelector', () => {
  let selector: DefaultStepSelector;

  beforeEach(() => {
    const loggerFactory = new FakeLoggerFactory();
    selector = new DefaultStepSelector(loggerFactory);
  });

  describe('findEligibleStep', () => {
    it('should find first uncompleted step', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do 1' },
          { id: 'step-2', title: 'Step 2', prompt: 'Do 2' },
          { id: 'step-3', title: 'Step 3', prompt: 'Do 3' }
        ]
      };

      const result = selector.findEligibleStep(workflow, new Set(), [], {});

      expect(result?.id).toBe('step-1');
    });

    it('should skip completed steps', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do 1' },
          { id: 'step-2', title: 'Step 2', prompt: 'Do 2' }
        ]
      };

      const result = selector.findEligibleStep(workflow, new Set(), ['step-1'], {});

      expect(result?.id).toBe('step-2');
    });

    it('should evaluate runCondition', () => {
      const workflow: Workflow = {
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
      };

      // Condition not met
      let result = selector.findEligibleStep(workflow, new Set(), [], { enabled: false });
      expect(result).toBeNull();

      // Condition met
      result = selector.findEligibleStep(workflow, new Set(), [], { enabled: true });
      expect(result?.id).toBe('conditional-step');
    });

    it('should skip loop body steps when not in loop', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'body-step', title: 'Body', prompt: 'Body' },
          { id: 'regular-step', title: 'Regular', prompt: 'Regular' }
        ]
      };

      const loopBodySteps = new Set(['body-step']);
      const result = selector.findEligibleStep(workflow, loopBodySteps, [], {});

      expect(result?.id).toBe('regular-step');
    });

    it('should allow loop body steps when in that loop', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'body-step', title: 'Body', prompt: 'Body' }
        ]
      };

      const loopBodySteps = new Set(['body-step']);
      const context: EnhancedContext = {
        _loopStack: [{
          loopId: 'test-loop',
          loopStep: {} as any,
          loopContext: {} as any,
          bodySteps: [{ id: 'body-step', title: 'Body', prompt: 'Body' }],
          currentBodyIndex: 0
        } as any]  // Cast for test mock
      };

      const result = selector.findEligibleStep(workflow, loopBodySteps, [], context);

      expect(result?.id).toBe('body-step');
    });
  });

  describe('handleNoEligibleStep', () => {
    it('should return null when no conditional steps remain', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do 1' }
        ]
      };

      const result = selector.handleNoEligibleStep(workflow, ['step-1'], {}, new Set());

      expect(result).toBeNull();
    });

    it('should provide guidance for missing variable', () => {
      const workflow: Workflow = {
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
      };

      const result = selector.handleNoEligibleStep(workflow, [], {}, new Set());

      expect(result).not.toBeNull();
      expect(result?.prompt).toContain('STEP: conditional');
      expect(result?.prompt).toContain('Missing Required Variable');
      expect(result?.prompt).toContain('Variable: mode');
    });

    it('should provide guidance for wrong value', () => {
      const workflow: Workflow = {
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
      };

      const result = selector.handleNoEligibleStep(workflow, [], { status: 'pending' }, new Set());

      expect(result).not.toBeNull();
      expect(result?.prompt).toContain('STEP: conditional');
      expect(result?.prompt).toContain('Incorrect Value');
      expect(result?.prompt).toContain('Expected: "ready"');
      expect(result?.prompt).toContain('Current:  "pending"');
    });

    it('should NOT provide guidance for case-only differences (lenient comparison)', () => {
      // IMPORTANT: lenientEquals is case-insensitive
      // So { var: 'mode', equals: 'ACTIVE' } with context { mode: 'active' } PASSES
      // The step should be ELIGIBLE, not blocked
      const workflow: Workflow = {
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
      };

      // This case-only difference should make the step ELIGIBLE
      // So findEligibleStep should return the step
      const step = selector.findEligibleStep(workflow, new Set(), [], { mode: 'active' });
      
      // Step IS eligible (lenient comparison passes)
      expect(step).not.toBeNull();
      expect(step?.id).toBe('conditional');
      
      // Therefore, handleNoEligibleStep should NOT be called in this scenario
      // But if it is called, it should return null (no blocked steps)
      const guidance = selector.handleNoEligibleStep(workflow, [], { mode: 'active' }, new Set());
      
      // Should return null because the step is actually eligible
      expect(guidance).toBeNull();
    });
  });
});
