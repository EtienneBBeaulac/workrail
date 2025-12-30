import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { ValidationEngine } from '../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator';
import { Workflow, LoopStep, createWorkflow, createBundledSource } from '../../src/types/workflow';

describe('Loop Validation', () => {
  let engine: ValidationEngine;

  beforeEach(() => {
    container.clearInstances();
    const enhancedLoopValidator = container.resolve(EnhancedLoopValidator);
    engine = new ValidationEngine(enhancedLoopValidator);
  });

  afterEach(() => {
    container.clearInstances();
  });

  describe('validateLoopStep', () => {
    const baseWorkflow = createWorkflow({
      id: 'test-workflow',
      name: 'Test Workflow',
      description: 'Test',
      version: '0.1.0',
      steps: [
        { id: 'loop-body', title: 'Loop Body', prompt: 'Do something' }
      ]
    }, createBundledSource());

    const baseLoopStep: LoopStep = {
      id: 'test-loop',
      type: 'loop',
      title: 'Test Loop',
      prompt: 'Loop prompt',
      loop: {
        type: 'while',
        condition: { var: 'counter', lt: 10 },
        maxIterations: 100
      },
      body: 'loop-body'
    };

    it('should validate a valid while loop', () => {
      const result = engine.validateLoopStep(baseLoopStep, baseWorkflow);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should reject invalid loop type', () => {
      const invalidLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          ...baseLoopStep.loop,
          type: 'invalid' as any
        }
      };
      const result = engine.validateLoopStep(invalidLoop, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('Invalid loop type');
    });

    it('should reject missing maxIterations', () => {
      const invalidLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          ...baseLoopStep.loop,
          maxIterations: undefined as any
        }
      };
      const result = engine.validateLoopStep(invalidLoop, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('maxIterations must be a positive number');
    });

    it('should reject excessive maxIterations', () => {
      const invalidLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          ...baseLoopStep.loop,
          maxIterations: 2000
        }
      };
      const result = engine.validateLoopStep(invalidLoop, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('exceeds safety limit');
    });

    it('should reject while loop without condition', () => {
      const invalidLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          ...baseLoopStep.loop,
          condition: undefined
        }
      };
      const result = engine.validateLoopStep(invalidLoop, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('while loop requires a condition');
    });

    it('should validate for loop with count', () => {
      const forLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          type: 'for',
          count: 5,
          maxIterations: 10
        }
      };
      const result = engine.validateLoopStep(forLoop, baseWorkflow);
      expect(result.valid).toBe(true);
    });

    it('should validate for loop with context variable', () => {
      const forLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          type: 'for',
          count: 'itemCount',
          maxIterations: 10
        }
      };
      const result = engine.validateLoopStep(forLoop, baseWorkflow);
      expect(result.valid).toBe(true);
    });

    it('should reject for loop without count', () => {
      const forLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          type: 'for',
          maxIterations: 10
        }
      };
      const result = engine.validateLoopStep(forLoop, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('for loop requires a count');
    });

    it('should validate forEach loop', () => {
      const forEachLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          type: 'forEach',
          items: 'arrayItems',
          maxIterations: 100
        }
      };
      const result = engine.validateLoopStep(forEachLoop, baseWorkflow);
      expect(result.valid).toBe(true);
    });

    it('should reject forEach loop without items', () => {
      const forEachLoop: LoopStep = {
        ...baseLoopStep,
        loop: {
          type: 'forEach',
          maxIterations: 100
        }
      };
      const result = engine.validateLoopStep(forEachLoop, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('forEach loop requires items');
    });

    it('should reject non-existent body step', () => {
      const invalidLoop: LoopStep = {
        ...baseLoopStep,
        body: 'non-existent'
      };
      const result = engine.validateLoopStep(invalidLoop, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('non-existent step');
    });

    it('should reject nested loops', () => {
      const workflowWithNestedLoop = createWorkflow({
        ...baseWorkflow,
        steps: [
          ...baseWorkflow.definition.steps,
          {
            id: 'nested-loop',
            type: 'loop',
            title: 'Nested Loop',
            prompt: 'Nested',
            loop: {
              type: 'while',
              condition: { var: 'x', lt: 5 },
              maxIterations: 10
            },
            body: 'loop-body'
          } as LoopStep
        ]
      }, createBundledSource());
      const invalidLoop: LoopStep = {
        ...baseLoopStep,
        body: 'nested-loop'
      };
      const result = engine.validateLoopStep(invalidLoop, workflowWithNestedLoop);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('Nested loops are not currently supported');
    });

    it('should validate custom variable names', () => {
      const loopWithVars: LoopStep = {
        ...baseLoopStep,
        loop: {
          ...baseLoopStep.loop,
          iterationVar: 'myCounter',
          itemVar: 'currentItem',
          indexVar: 'idx'
        }
      };
      const result = engine.validateLoopStep(loopWithVars, baseWorkflow);
      expect(result.valid).toBe(true);
    });

    it('should reject invalid variable names', () => {
      const loopWithBadVars: LoopStep = {
        ...baseLoopStep,
        loop: {
          ...baseLoopStep.loop,
          iterationVar: '123invalid',
          itemVar: 'my-item',
          indexVar: 'idx space'
        }
      };
      const result = engine.validateLoopStep(loopWithBadVars, baseWorkflow);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(3);
      expect(result.issues[0]).toContain('Invalid iteration variable name');
      expect(result.issues[1]).toContain('Invalid item variable name');
      expect(result.issues[2]).toContain('Invalid index variable name');
    });
  });

  describe('validateWorkflow', () => {
    it('should validate a workflow with loops', () => {
      const workflow = createWorkflow({
        id: 'loop-workflow',
        name: 'Loop Workflow',
        description: 'Test',
        version: '0.1.0',
        steps: [
          {
            id: 'main-loop',
            type: 'loop',
            title: 'Main Loop',
            prompt: 'Loop',
            loop: {
              type: 'while',
              condition: { var: 'continue' },
              maxIterations: 10
            },
            body: 'process'
          } as LoopStep,
          { id: 'process', title: 'Process', prompt: 'Do work' },
          { id: 'done', title: 'Done', prompt: 'Complete' }
        ]
      }, createBundledSource());
      const result = engine.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
    });

    it('should detect duplicate step IDs', () => {
      const workflow = createWorkflow({
        id: 'dup-workflow',
        name: 'Duplicate Workflow',
        description: 'Test',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First' },
          { id: 'step1', title: 'Step 2', prompt: 'Second' }
        ]
      }, createBundledSource());
      const result = engine.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('Duplicate step ID');
    });

    it('should validate all loop steps in workflow', () => {
      const workflow = createWorkflow({
        id: 'multi-loop-workflow',
        name: 'Multi Loop Workflow',
        description: 'Test',
        version: '0.1.0',
        steps: [
          {
            id: 'loop1',
            type: 'loop',
            title: 'Loop 1',
            prompt: 'First loop',
            loop: {
              type: 'while',
              condition: { var: 'x', lt: 5 },
              maxIterations: 10
            },
            body: 'step1'
          } as LoopStep,
          { id: 'step1', title: 'Step 1', prompt: 'In loop 1' },
          {
            id: 'loop2',
            type: 'loop',
            title: 'Loop 2',
            prompt: 'Second loop',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 5
            },
            body: 'step2'
          } as LoopStep,
          { id: 'step2', title: 'Step 2', prompt: 'In loop 2' }
        ]
      }, createBundledSource());
      const result = engine.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
    });

    it('should warn about loop body steps with runCondition', () => {
      const workflow = createWorkflow({
        id: 'condition-workflow',
        name: 'Condition Workflow',
        description: 'Test',
        version: '0.1.0',
        steps: [
          {
            id: 'loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: {
              type: 'while',
              condition: { var: 'active' },
              maxIterations: 10
            },
            body: 'body-step'
          } as LoopStep,
          { 
            id: 'body-step', 
            title: 'Body', 
            prompt: 'Body',
            runCondition: { var: 'extra' }
          }
        ]
      }, createBundledSource());
      const result = engine.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('loop body but has runCondition');
    });

    it('should validate steps without loops', () => {
      const workflow = createWorkflow({
        id: 'simple-workflow',
        name: 'Simple Workflow',
        description: 'Test',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First' },
          { id: 'step2', title: 'Step 2', prompt: 'Second' }
        ]
      }, createBundledSource());
      const result = engine.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
    });

    it('should warn when validationCriteria.message contains quoted JSON snippets (agent confusion risk)', () => {
      const workflow = createWorkflow(
        {
          id: 'warning-workflow',
          name: 'Warning Workflow',
          description: 'Test',
          version: '0.1.0',
          steps: [
            {
              id: 'step1',
              title: 'Step 1',
              prompt: 'First',
              validationCriteria: [
                {
                  type: 'contains',
                  value: 'state',
                  message: 'Output must include "{\\"state\\": \\"init\\"}"',
                },
              ],
            } as any,
          ],
        },
        createBundledSource()
      );

      const result = engine.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.warnings?.some((w) => w.includes('quoted JSON snippet'))).toBe(true);
    });
  });
}); 