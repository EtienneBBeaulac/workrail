import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { ValidationEngine } from '../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator';
import { Workflow, WorkflowStep, createWorkflow, createBundledSource, WorkflowDefinition } from '../../src/types/workflow';
import { LoopStep } from '../../src/types/workflow-types';

describe('Enhanced Loop Validation', () => {
  let validationEngine: ValidationEngine;

  beforeEach(() => {
    container.clearInstances();
    const enhancedLoopValidator = container.resolve(EnhancedLoopValidator);
    validationEngine = new ValidationEngine(enhancedLoopValidator);
  });

  afterEach(() => {
    container.clearInstances();
  });

  describe('Complex Conditional Logic Detection', () => {
    it('should warn about complex ternary operators in loop body prompts', () => {
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop-with-complex-conditional',
            title: 'Complex Loop',
            type: 'loop',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 3
            },
            body: [
              {
                id: 'step-1',
                title: 'Step with complex conditional',
                prompt: "{{iteration === 1 ? 'First step content' : iteration === 2 ? 'Second step content' : 'Third step content'}}",
                requireConfirmation: false
              }
            ],
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.valid).toBe(true); // Still valid, but with warnings
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.match(/complex conditional logic/i))).toBe(true);
      expect(result.suggestions.some(s => s.match(/separate steps with runCondition/i))).toBe(true);
    });

    it('should warn about deeply nested ternary operators', () => {
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop-with-nested-ternary',
            title: 'Nested Ternary Loop',
            type: 'loop',
            loop: {
              type: 'for',
              count: 4,
              maxIterations: 4
            },
            body: [
              {
                id: 'step-1',
                title: 'Deeply nested conditional',
                prompt: "{{step === 1 ? (subStep === 1 ? 'A' : 'B') : step === 2 ? (subStep === 1 ? 'C' : 'D') : 'E'}}",
                requireConfirmation: false
              }
            ],
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.warnings?.some(w => w.match(/nested ternary operators/i))).toBe(true);
    });
  });

  describe('Prompt Length Validation', () => {
    it('should warn when loop body prompts approach length limits', () => {
      const longPrompt = 'A'.repeat(1800); // Close to 2048 limit
      
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop-with-long-prompt',
            title: 'Long Prompt Loop',
            type: 'loop',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 3
            },
            body: [
              {
                id: 'step-1',
                title: 'Long prompt step',
                prompt: longPrompt,
                requireConfirmation: false
              }
            ],
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.warnings?.some(w => w.match(/long prompt.*1800.*characters/i))).toBe(true);
      expect(result.suggestions.some(s => s.match(/split into multiple steps|breaking this into smaller/i))).toBe(true);
    });

    it('should error when conditional expansion could exceed limits', () => {
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop-with-expandable-prompt',
            title: 'Expandable Prompt Loop',
            type: 'loop',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 3
            },
            body: [
              {
                id: 'step-1',
                title: 'Expandable step',
                prompt: "{{iteration === 1 ? '" + 'A'.repeat(700) + "' : iteration === 2 ? '" + 'B'.repeat(700) + "' : '" + 'C'.repeat(700) + "'}}",
                requireConfirmation: false
              }
            ],
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.warnings?.some(w => w.match(/conditional content.*2100.*characters/i))).toBe(true);
    });
  });

  describe('Template Variable Usage', () => {
    it('should validate loop iteration variables are used correctly', () => {
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop-with-vars',
            title: 'Variable Usage Loop',
            type: 'loop',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 3,
              iterationVar: 'currentStep'
            },
            body: [
              {
                id: 'step-1',
                title: 'Step {{unknownVar}}', // Using undefined variable
                prompt: 'Processing step {{currentStep}} of {{totalSteps}}', // totalSteps not defined
                requireConfirmation: false
              }
            ],
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.warnings?.some(w => w.match(/undefined variable.*unknownVar/i))).toBe(true);
      expect(result.warnings?.some(w => w.match(/undefined variable.*totalSteps/i))).toBe(true);
    });
  });

  describe('Best Practices Validation', () => {
    it('should suggest using runCondition for multi-path loops', () => {
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'multi-path-loop',
            title: 'Multi-path Loop',
            type: 'loop',
            loop: {
              type: 'for',
              count: 4,
              maxIterations: 4
            },
            body: [
              {
                id: 'step-1',
                title: 'Multi-path step',
                prompt: "Perform {{iteration === 1 ? 'Analysis' : iteration === 2 ? 'Design' : iteration === 3 ? 'Implementation' : 'Testing'}}",
                requireConfirmation: false
              }
            ],
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.suggestions.some(s => s.match(/separate steps with runCondition/i))).toBe(true);
      expect(result.suggestions.some(s => s.match(/more maintainable/i))).toBe(true);
    });

    it('should validate loop body references exist', () => {
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop-with-ref',
            title: 'Loop with reference',
            type: 'loop',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 3
            },
            body: 'non-existent-step',
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.match(/non-existent-step/))).toBe(true);
    });
  });

  describe('Loop Pattern Detection', () => {
    it('should recognize common loop patterns and provide guidance', () => {
      const workflow = createWorkflow({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'analysis-loop',
            title: 'Analysis Loop',
            type: 'loop',
            loop: {
              type: 'for',
              count: '{{analysisSteps}}',
              maxIterations: 10,
              iterationVar: 'analysisStep'
            },
            body: [
              {
                id: 'analyze',
                title: 'Analysis Step {{analysisStep}}',
                prompt: "{{analysisStep === 1 ? 'Structure' : analysisStep === 2 ? 'Dependencies' : 'Patterns'}}",
                requireConfirmation: false
              }
            ],
            requireConfirmation: false
          } as LoopStep
        ]
      }, createBundledSource());

      const result = validationEngine.validateWorkflow(workflow);
      
      expect(result.info).toBeDefined();
      expect(result.info?.some(i => i.match(/Progressive analysis pattern detected/i))).toBe(true);
      expect(result.suggestions.some(s => s.match(/multi-step pattern/i))).toBe(true);
    });
  });
});