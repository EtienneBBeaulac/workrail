/**
 * Integration tests for condition analysis with StepSelector.
 * Tests with real workflow scenarios.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultStepSelector } from '../../src/application/services/step-selector';
import { Workflow } from '../../src/types/mcp-types';
import { EnhancedContext } from '../../src/types/workflow-types';

describe('Condition Analysis Integration', () => {
  let selector: DefaultStepSelector;

  beforeEach(() => {
    selector = new DefaultStepSelector();
  });

  describe('Real workflow scenarios', () => {
    it('should provide detailed guidance for missing variable', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'conditional-step',
            title: 'Conditional Step Requiring Mode',
            prompt: 'Do something',
            runCondition: { var: 'mode', equals: 'active' }
          }
        ]
      };

      const guidance = selector.handleNoEligibleStep(workflow, [], {}, new Set());

      expect(guidance).not.toBeNull();
      expect(guidance!.prompt).toContain('conditional step is blocked');
      expect(guidance!.prompt).toContain('STEP: conditional-step');
      expect(guidance!.prompt).toContain('Missing Required Variable');
      expect(guidance!.prompt).toContain('Variable: mode');
      expect(guidance!.prompt).toContain('Expected: "active"');
      expect(guidance!.prompt).toContain('Current:  undefined');
      expect(guidance!.prompt).toContain('QUICK FIXES');
      expect(guidance!.prompt).toContain('Set mode = "active"');
    });

    it('should handle case-insensitive matches correctly', () => {
      // CRITICAL: With lenient comparison, case differences should make step ELIGIBLE
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'phase-small',
            title: 'Small Task Path',
            prompt: 'Do small task',
            runCondition: { var: 'taskComplexity', equals: 'Small' }
          }
        ]
      };

      // Case-only difference - should PASS lenient comparison
      const context: EnhancedContext = { taskComplexity: 'small' };
      
      // Step should be ELIGIBLE
      const step = selector.findEligibleStep(workflow, new Set(), [], context);
      expect(step).not.toBeNull();
      expect(step?.id).toBe('phase-small');
      
      // Therefore no blocked steps
      const guidance = selector.handleNoEligibleStep(workflow, [], context, new Set());
      expect(guidance).toBeNull();
    });

    it('should provide detailed guidance for complex OR condition', () => {
      // Real condition from coding-task-workflow-with-loops.json
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'advanced-step',
            title: 'Advanced Analysis',
            prompt: 'Do analysis',
            runCondition: {
              or: [
                { var: 'taskComplexity', equals: 'Large' },
                {
                  and: [
                    { var: 'taskComplexity', equals: 'Medium' },
                    { var: 'requestDeepAnalysis', equals: true }
                  ]
                }
              ]
            }
          }
        ]
      };

      const context: EnhancedContext = { taskComplexity: 'Small' };
      const guidance = selector.handleNoEligibleStep(workflow, [], context, new Set());

      expect(guidance).not.toBeNull();
      expect(guidance!.prompt).toContain('Composite Condition (OR)');
      expect(guidance!.prompt).toContain('satisfy ANY ONE of these options');
      expect(guidance!.prompt).toContain('OPTION 1:');
      expect(guidance!.prompt).toContain('OPTION 2:');
      expect(guidance!.prompt).toContain('QUICK FIXES');
    });

    it('should return null when no conditional steps remain', () => {
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

      const guidance = selector.handleNoEligibleStep(
        workflow,
        ['step-1', 'step-2'],
        {},
        new Set()
      );

      expect(guidance).toBeNull();
    });

    it('should show current values in diagnosis', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'retry-step',
            title: 'Retry Logic',
            prompt: 'Retry',
            runCondition: { var: 'attemptCount', lt: 3 }
          }
        ]
      };

      const context: EnhancedContext = { attemptCount: 5 };
      const guidance = selector.handleNoEligibleStep(workflow, [], context, new Set());

      expect(guidance!.prompt).toContain('attemptCount');
      expect(guidance!.prompt).toContain('Current:  5');
      expect(guidance!.prompt).toContain('< 3');
    });

    it('should handle type coercion correctly', () => {
      // String "10" should equal number 10 via lenient comparison
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'count-step',
            title: 'Count Step',
            prompt: 'Count',
            runCondition: { var: 'count', equals: 10 }
          }
        ]
      };

      const context: EnhancedContext = { count: '10' };  // String!
      
      // Step should be ELIGIBLE (type coercion)
      const step = selector.findEligibleStep(workflow, new Set(), [], context);
      expect(step).not.toBeNull();
      
      // No blocked steps
      const guidance = selector.handleNoEligibleStep(workflow, [], context, new Set());
      expect(guidance).toBeNull();
    });

    it('should handle boolean coercion correctly', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'enabled-step',
            title: 'Enabled Step',
            prompt: 'Do when enabled',
            runCondition: { var: 'enabled', equals: true }
          }
        ]
      };

      // "yes" should equal true via lenient comparison
      const context: EnhancedContext = { enabled: 'yes' };
      
      const step = selector.findEligibleStep(workflow, new Set(), [], context);
      expect(step).not.toBeNull();
      
      const guidance = selector.handleNoEligibleStep(workflow, [], context, new Set());
      expect(guidance).toBeNull();
    });

    it('should provide actionable quick fixes', () => {
      const workflow: Workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'step-a',
            title: 'Feature A',
            prompt: 'Do A',
            runCondition: { var: 'feature', equals: 'A' }
          },
          {
            id: 'step-b',
            title: 'Feature B',
            prompt: 'Do B',
            runCondition: { var: 'feature', equals: 'B' }
          }
        ]
      };

      const context: EnhancedContext = { feature: 'C' };
      const guidance = selector.handleNoEligibleStep(workflow, [], context, new Set());

      expect(guidance!.prompt).toContain('QUICK FIXES');
      expect(guidance!.prompt).toContain('Change feature from "C" to "A"');
      expect(guidance!.prompt).toContain('→ Enables "Feature A"');
    });
  });
});
