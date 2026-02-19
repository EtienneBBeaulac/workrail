/**
 * Validator Prompt Source — Tests
 *
 * Proves the validation engine accepts all three prompt sources
 * (prompt, promptBlocks, templateCall) and rejects steps with none.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { ValidationEngine } from '../../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator';
import { createWorkflow, createBundledSource } from '../../../src/types/workflow';
import { stepHasPromptSource } from '../../../src/types/workflow-definition';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition';

describe('stepHasPromptSource', () => {
  it('returns true for step with prompt', () => {
    const step = { id: 's', title: 'S', prompt: 'Do it.' } as WorkflowStepDefinition;
    expect(stepHasPromptSource(step)).toBe(true);
  });

  it('returns true for step with promptBlocks', () => {
    const step = {
      id: 's',
      title: 'S',
      promptBlocks: { goal: 'Do it.' },
    } as WorkflowStepDefinition;
    expect(stepHasPromptSource(step)).toBe(true);
  });

  it('returns true for step with templateCall', () => {
    const step = {
      id: 's',
      title: 'S',
      templateCall: { templateId: 'wr.templates.probe' },
    } as WorkflowStepDefinition;
    expect(stepHasPromptSource(step)).toBe(true);
  });

  it('returns false for step with none', () => {
    const step = { id: 's', title: 'S' } as WorkflowStepDefinition;
    expect(stepHasPromptSource(step)).toBe(false);
  });
});

describe('ValidationEngine accepts promptBlocks and templateCall', () => {
  let validationEngine: ValidationEngine;

  beforeEach(() => {
    container.clearInstances();
    const enhancedLoopValidator = container.resolve(EnhancedLoopValidator);
    validationEngine = new ValidationEngine(enhancedLoopValidator);
  });

  afterEach(() => {
    container.clearInstances();
  });

  function mkWorkflow(steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[]) {
    return createWorkflow(
      {
        id: 'test-wf',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        steps,
      },
      createBundledSource(),
    );
  }

  it('accepts step with prompt (backward compat)', () => {
    const wf = mkWorkflow([{ id: 'step-1', title: 'Step 1', prompt: 'Do it.' }]);
    const result = validationEngine.validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts step with promptBlocks', () => {
    const wf = mkWorkflow([
      { id: 'step-1', title: 'Step 1', promptBlocks: { goal: 'Do it.' } } as WorkflowStepDefinition,
    ]);
    const result = validationEngine.validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts step with templateCall', () => {
    const wf = mkWorkflow([
      {
        id: 'step-1',
        title: 'Step 1',
        templateCall: { templateId: 'wr.templates.probe' },
      } as WorkflowStepDefinition,
    ]);
    const result = validationEngine.validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects step with no prompt source', () => {
    const wf = mkWorkflow([{ id: 'step-1', title: 'Step 1' } as WorkflowStepDefinition]);
    const result = validationEngine.validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('must have prompt, promptBlocks, or templateCall'))).toBe(true);
  });

  it('accepts inline loop body step with promptBlocks', () => {
    const wf = mkWorkflow([
      {
        id: 'loop-1',
        title: 'Loop',
        type: 'loop',
        loop: { type: 'for', count: 3, maxIterations: 3 },
        body: [
          { id: 'body-1', title: 'Body Step', promptBlocks: { goal: 'Iterate.' } } as WorkflowStepDefinition,
        ],
      } as LoopStepDefinition,
    ]);
    const result = validationEngine.validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects inline loop body step with no prompt source', () => {
    const wf = mkWorkflow([
      {
        id: 'loop-1',
        title: 'Loop',
        type: 'loop',
        loop: { type: 'for', count: 3, maxIterations: 3 },
        body: [{ id: 'body-1', title: 'Body Step' } as WorkflowStepDefinition],
      } as LoopStepDefinition,
    ]);
    const result = validationEngine.validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('must have prompt, promptBlocks, or templateCall'))).toBe(true);
  });
});
