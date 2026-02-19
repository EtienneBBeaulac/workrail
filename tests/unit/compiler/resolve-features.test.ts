/**
 * Resolve Features Compiler Pass — Tests
 */
import { describe, it, expect } from 'vitest';
import { resolveFeaturesPass } from '../../../src/application/services/compiler/resolve-features.js';
import { createFeatureRegistry } from '../../../src/application/services/compiler/feature-registry.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition.js';

const registry = createFeatureRegistry();

describe('resolveFeaturesPass', () => {
  it('returns steps unchanged when no features declared', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', prompt: 'Raw prompt.' },
    ];
    const result = resolveFeaturesPass(steps, [], registry);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(steps); // same reference
  });

  it('does not modify steps with raw prompt (no promptBlocks)', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', prompt: 'Raw prompt.' },
    ];
    const result = resolveFeaturesPass(steps, ['wr.features.memory_context'], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    // Raw prompt step is unchanged — no promptBlocks to inject into
    expect(resolved.prompt).toBe('Raw prompt.');
    expect(resolved.promptBlocks).toBeUndefined();
  });

  it('injects feature constraints into promptBlocks step', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: {
          goal: 'Find the bug.',
          constraints: ['Follow the mode.'],
        },
      },
    ];
    const result = resolveFeaturesPass(steps, ['wr.features.memory_context'], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    // Original constraint preserved + feature constraint appended
    expect(resolved.promptBlocks!.constraints!.length).toBeGreaterThan(1);
    expect(resolved.promptBlocks!.constraints![0]).toBe('Follow the mode.');
  });

  it('creates constraints array when step had none', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: { goal: 'Do the thing.' },
      },
    ];
    const result = resolveFeaturesPass(steps, ['wr.features.memory_context'], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    expect(resolved.promptBlocks!.constraints).toBeDefined();
    expect(resolved.promptBlocks!.constraints!.length).toBeGreaterThan(0);
  });

  it('preserves goal and other blocks unchanged', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: {
          goal: 'Find the bug.',
          verify: ['Evidence is grounded.'],
        },
      },
    ];
    const result = resolveFeaturesPass(steps, ['wr.features.memory_context'], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    expect(resolved.promptBlocks!.goal).toBe('Find the bug.');
    // verify unchanged (memory_context doesn't inject verify items)
    expect(resolved.promptBlocks!.verify).toEqual(['Evidence is grounded.']);
  });

  it('returns error for unknown feature', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', promptBlocks: { goal: 'Goal.' } },
    ];
    const result = resolveFeaturesPass(steps, ['wr.features.nonexistent'], registry);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('FEATURE_RESOLVE_ERROR');
    if (error.code === 'FEATURE_RESOLVE_ERROR') {
      expect(error.cause.featureId).toBe('wr.features.nonexistent');
    }
  });

  it('fails fast on first unknown feature even if others are valid', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', promptBlocks: { goal: 'Goal.' } },
    ];
    const result = resolveFeaturesPass(
      steps,
      ['wr.features.memory_context', 'wr.features.nonexistent'],
      registry,
    );
    expect(result.isErr()).toBe(true);
  });

  it('applies features to loop body steps', () => {
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'Loop',
      prompt: 'Loop prompt.',
      type: 'loop',
      loop: { type: 'while', maxIterations: 3 },
      body: [
        {
          id: 'body-1',
          title: 'Body Step',
          promptBlocks: { goal: 'Body goal.' },
        },
      ],
    };
    const result = resolveFeaturesPass([loopStep], ['wr.features.memory_context'], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
    const bodyStep = (resolved.body as WorkflowStepDefinition[])[0]!;
    expect(bodyStep.promptBlocks!.constraints).toBeDefined();
    expect(bodyStep.promptBlocks!.constraints!.length).toBeGreaterThan(0);
  });

  it('preserves loop structure after feature application', () => {
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'Loop',
      prompt: 'Loop prompt.',
      type: 'loop',
      loop: { type: 'while', maxIterations: 5 },
      body: [{ id: 'body-1', title: 'Body', prompt: 'Body prompt.' }],
    };
    const result = resolveFeaturesPass([loopStep], ['wr.features.memory_context'], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
    expect(resolved.type).toBe('loop');
    expect(resolved.loop.type).toBe('while');
    expect(resolved.loop.maxIterations).toBe(5);
  });

  it('handles mixed steps correctly', () => {
    const steps: (WorkflowStepDefinition | LoopStepDefinition)[] = [
      { id: 'step-1', title: 'Raw', prompt: 'Raw prompt.' },
      { id: 'step-2', title: 'Blocks', promptBlocks: { goal: 'Structured.' } },
    ];
    const result = resolveFeaturesPass(steps, ['wr.features.memory_context'], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    // step-1: raw prompt, unmodified
    expect((resolved[0] as WorkflowStepDefinition).promptBlocks).toBeUndefined();
    // step-2: feature applied
    expect((resolved[1] as WorkflowStepDefinition).promptBlocks!.constraints).toBeDefined();
  });

  it('is deterministic: same inputs always produce same output', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step', promptBlocks: { goal: 'Goal.' } },
    ];
    const a = resolveFeaturesPass(steps, ['wr.features.memory_context'], registry)._unsafeUnwrap();
    const b = resolveFeaturesPass(steps, ['wr.features.memory_context'], registry)._unsafeUnwrap();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
