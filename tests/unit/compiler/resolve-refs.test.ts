/**
 * Resolve Refs Compiler Pass — Tests
 *
 * Tests ref resolution in promptBlocks at the step and pass level.
 */
import { describe, it, expect } from 'vitest';
import { resolveRefsPass } from '../../../src/application/services/compiler/resolve-refs.js';
import { createRefRegistry } from '../../../src/application/services/compiler/ref-registry.js';
import type { PromptPart } from '../../../src/application/services/compiler/prompt-blocks.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition.js';

const registry = createRefRegistry();

describe('resolveRefsPass', () => {
  it('passes through steps without promptBlocks unchanged', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', prompt: 'Raw prompt.' },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()[0]!.prompt).toBe('Raw prompt.');
  });

  it('passes through promptBlocks with no refs unchanged', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: { goal: 'No refs here.' },
      },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    expect(resolved.promptBlocks!.goal).toBe('No refs here.');
  });

  it('resolves ref parts in goal to text', () => {
    const parts: PromptPart[] = [
      { kind: 'text', text: 'Before. ' },
      { kind: 'ref', refId: 'wr.refs.memory_usage' },
      { kind: 'text', text: ' After.' },
    ];
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', promptBlocks: { goal: parts } },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    const goalParts = resolved.promptBlocks!.goal as readonly PromptPart[];
    // All parts should be text now
    for (const part of goalParts) {
      expect(part.kind).toBe('text');
    }
    // The ref should have been replaced with memory usage content
    expect((goalParts[1] as { kind: 'text'; text: string }).text).toContain('Memory MCP');
  });

  it('resolves refs in constraints array', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: {
          constraints: [
            'Plain constraint.',
            [{ kind: 'ref', refId: 'wr.refs.memory_store' }],
          ],
        },
      },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    // First constraint: plain string, unchanged
    expect(resolved.promptBlocks!.constraints![0]).toBe('Plain constraint.');
    // Second constraint: ref resolved to text part
    const secondParts = resolved.promptBlocks!.constraints![1] as readonly PromptPart[];
    expect(secondParts[0]!.kind).toBe('text');
  });

  it('resolves refs in procedure array', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: {
          procedure: [[{ kind: 'ref', refId: 'wr.refs.memory_query' }]],
        },
      },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    const parts = resolved.promptBlocks!.procedure![0] as readonly PromptPart[];
    expect(parts[0]!.kind).toBe('text');
    expect((parts[0] as { kind: 'text'; text: string }).text).toContain('memory_briefing');
  });

  it('resolves refs in verify array', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: {
          verify: [[{ kind: 'ref', refId: 'wr.refs.memory_usage' }]],
        },
      },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as WorkflowStepDefinition;
    const parts = resolved.promptBlocks!.verify![0] as readonly PromptPart[];
    expect(parts[0]!.kind).toBe('text');
  });

  it('returns error for unknown ref', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: {
          goal: [{ kind: 'ref', refId: 'wr.refs.nonexistent' }],
        },
      },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('REF_RESOLVE_ERROR');
    expect(error.stepId).toBe('step-1');
    expect(error.cause.code).toBe('UNKNOWN_REF');
    expect(error.cause.refId).toBe('wr.refs.nonexistent');
  });

  it('resolves refs in loop body steps', () => {
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
          promptBlocks: {
            goal: [{ kind: 'ref', refId: 'wr.refs.memory_usage' }],
          },
        },
      ],
    };
    const result = resolveRefsPass([loopStep], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
    const bodyStep = (resolved.body as WorkflowStepDefinition[])[0]!;
    const parts = bodyStep.promptBlocks!.goal as readonly PromptPart[];
    expect(parts[0]!.kind).toBe('text');
  });

  it('preserves loop step structure after resolution', () => {
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'Loop',
      prompt: 'Loop prompt.',
      type: 'loop',
      loop: { type: 'while', maxIterations: 5 },
      body: [
        { id: 'body-1', title: 'Body', prompt: 'Body prompt.' },
      ],
    };
    const result = resolveRefsPass([loopStep], registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
    expect(resolved.type).toBe('loop');
    expect(resolved.loop.type).toBe('while');
    expect(resolved.loop.maxIterations).toBe(5);
  });

  it('handles mixed steps correctly', () => {
    const steps: (WorkflowStepDefinition | LoopStepDefinition)[] = [
      { id: 'step-1', title: 'Raw', prompt: 'Raw prompt.' },
      {
        id: 'step-2',
        title: 'With Ref',
        promptBlocks: {
          goal: [
            { kind: 'text', text: 'Check: ' },
            { kind: 'ref', refId: 'wr.refs.memory_usage' },
          ],
        },
      },
      { id: 'step-3', title: 'Plain Blocks', promptBlocks: { goal: 'No refs.' } },
    ];
    const result = resolveRefsPass(steps, registry);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    // step-1: unchanged
    expect(resolved[0]!.prompt).toBe('Raw prompt.');
    // step-2: ref resolved
    const goalParts = (resolved[1] as WorkflowStepDefinition).promptBlocks!.goal as readonly PromptPart[];
    expect(goalParts.every(p => p.kind === 'text')).toBe(true);
    // step-3: unchanged
    expect((resolved[2] as WorkflowStepDefinition).promptBlocks!.goal).toBe('No refs.');
  });

  it('is deterministic: same input always produces same output', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step',
        promptBlocks: {
          goal: [{ kind: 'ref', refId: 'wr.refs.memory_usage' }],
        },
      },
    ];
    const a = resolveRefsPass(steps, registry)._unsafeUnwrap();
    const b = resolveRefsPass(steps, registry)._unsafeUnwrap();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
