/**
 * PromptBlocks — Rendering and Compiler Pass Tests
 *
 * Tests the pure rendering function and the compiler pass that
 * resolves promptBlocks into prompt strings.
 */
import { describe, it, expect } from 'vitest';
import {
  renderPromptBlocks,
  resolvePromptBlocksPass,
  type PromptBlocks,
  type PromptPart,
} from '../../../src/application/services/compiler/prompt-blocks.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// renderPromptBlocks
// ---------------------------------------------------------------------------

describe('renderPromptBlocks', () => {
  it('renders goal-only blocks', () => {
    const blocks: PromptBlocks = { goal: 'Investigate the bug.' };
    const result = renderPromptBlocks(blocks);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('## Goal\nInvestigate the bug.');
  });

  it('renders all sections in deterministic order', () => {
    const blocks: PromptBlocks = {
      goal: 'Find the root cause.',
      constraints: ['Follow the selected mode.', 'Do not skip steps.'],
      procedure: ['Gather evidence.', 'Test hypotheses.'],
      outputRequired: { notesMarkdown: 'Summary of findings.' },
      verify: ['Root cause is grounded in evidence.'],
    };
    const result = renderPromptBlocks(blocks);
    expect(result.isOk()).toBe(true);
    const text = result._unsafeUnwrap();

    // Sections appear in locked order
    const goalIdx = text.indexOf('## Goal');
    const constraintsIdx = text.indexOf('## Constraints');
    const procedureIdx = text.indexOf('## Procedure');
    const outputIdx = text.indexOf('## Output Required');
    const verifyIdx = text.indexOf('## Verify');

    expect(goalIdx).toBeLessThan(constraintsIdx);
    expect(constraintsIdx).toBeLessThan(procedureIdx);
    expect(procedureIdx).toBeLessThan(outputIdx);
    expect(outputIdx).toBeLessThan(verifyIdx);
  });

  it('renders constraints as bullet points', () => {
    const blocks: PromptBlocks = {
      constraints: ['Rule A.', 'Rule B.'],
    };
    const text = renderPromptBlocks(blocks)._unsafeUnwrap();
    expect(text).toContain('- Rule A.');
    expect(text).toContain('- Rule B.');
  });

  it('renders procedure as numbered steps', () => {
    const blocks: PromptBlocks = {
      procedure: ['Step one.', 'Step two.', 'Step three.'],
    };
    const text = renderPromptBlocks(blocks)._unsafeUnwrap();
    expect(text).toContain('1. Step one.');
    expect(text).toContain('2. Step two.');
    expect(text).toContain('3. Step three.');
  });

  it('renders outputRequired as key-value pairs', () => {
    const blocks: PromptBlocks = {
      outputRequired: { notesMarkdown: 'Recap.', artifacts: 'Loop control.' },
    };
    const text = renderPromptBlocks(blocks)._unsafeUnwrap();
    expect(text).toContain('**notesMarkdown**: Recap.');
    expect(text).toContain('**artifacts**: Loop control.');
  });

  it('returns EMPTY_BLOCKS error for empty blocks', () => {
    const blocks: PromptBlocks = {};
    const result = renderPromptBlocks(blocks);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('EMPTY_BLOCKS');
  });

  it('returns UNRESOLVED_REF error for unresolved ref parts', () => {
    const parts: PromptPart[] = [
      { kind: 'text', text: 'Before. ' },
      { kind: 'ref', refId: 'wr.refs.some_snippet' },
    ];
    const blocks: PromptBlocks = { goal: parts };
    const result = renderPromptBlocks(blocks);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('UNRESOLVED_REF');
    if (error.code === 'UNRESOLVED_REF') {
      expect(error.refId).toBe('wr.refs.some_snippet');
    }
  });

  it('renders text PromptPart arrays by concatenation', () => {
    const parts: PromptPart[] = [
      { kind: 'text', text: 'Part A. ' },
      { kind: 'text', text: 'Part B.' },
    ];
    const blocks: PromptBlocks = { goal: parts };
    const text = renderPromptBlocks(blocks)._unsafeUnwrap();
    expect(text).toBe('## Goal\nPart A. Part B.');
  });

  it('skips empty optional sections', () => {
    const blocks: PromptBlocks = {
      goal: 'Do the thing.',
      constraints: [], // empty array
      procedure: [], // empty array
    };
    const text = renderPromptBlocks(blocks)._unsafeUnwrap();
    expect(text).not.toContain('## Constraints');
    expect(text).not.toContain('## Procedure');
    expect(text).toContain('## Goal');
  });

  it('is deterministic: same blocks produce same output', () => {
    const blocks: PromptBlocks = {
      goal: 'Goal.',
      constraints: ['C1.', 'C2.'],
      procedure: ['P1.'],
    };
    const a = renderPromptBlocks(blocks)._unsafeUnwrap();
    const b = renderPromptBlocks(blocks)._unsafeUnwrap();
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// resolvePromptBlocksPass
// ---------------------------------------------------------------------------

describe('resolvePromptBlocksPass', () => {
  it('passes through steps with prompt string unchanged', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', prompt: 'Do something.' },
    ];
    const result = resolvePromptBlocksPass(steps);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved[0]!.prompt).toBe('Do something.');
  });

  it('renders promptBlocks into prompt', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: { goal: 'Find the bug.' },
      },
    ];
    const result = resolvePromptBlocksPass(steps);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved[0]!.prompt).toBe('## Goal\nFind the bug.');
  });

  it('resolves promptBlocks in loop body steps', () => {
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
    const result = resolvePromptBlocksPass([loopStep]);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
    expect(Array.isArray(resolved.body)).toBe(true);
    const bodyStep = (resolved.body as WorkflowStepDefinition[])[0]!;
    expect(bodyStep.prompt).toBe('## Goal\nBody goal.');
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
    const result = resolvePromptBlocksPass([loopStep]);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
    expect(resolved.type).toBe('loop');
    expect(resolved.loop.type).toBe('while');
    expect(resolved.loop.maxIterations).toBe(5);
  });

  it('returns error for empty promptBlocks', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', promptBlocks: {} },
    ];
    const result = resolvePromptBlocksPass(steps);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.stepId).toBe('step-1');
    expect(error.cause.code).toBe('EMPTY_BLOCKS');
  });

  it('returns error for unresolved refs in promptBlocks', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        promptBlocks: {
          goal: [{ kind: 'ref', refId: 'wr.refs.unknown' }],
        },
      },
    ];
    const result = resolvePromptBlocksPass(steps);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.stepId).toBe('step-1');
    expect(error.cause.code).toBe('UNRESOLVED_REF');
  });

  it('returns error when step has both prompt and promptBlocks', () => {
    const steps: WorkflowStepDefinition[] = [
      {
        id: 'step-1',
        title: 'Step 1',
        prompt: 'Raw prompt.',
        promptBlocks: { goal: 'Structured goal.' },
      },
    ];
    const result = resolvePromptBlocksPass(steps);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('PROMPT_AND_BLOCKS_BOTH_SET');
    expect(error.stepId).toBe('step-1');
  });

  it('handles mixed steps (some with prompt, some with promptBlocks)', () => {
    const steps: WorkflowStepDefinition[] = [
      { id: 'step-1', title: 'Step 1', prompt: 'Raw prompt.' },
      { id: 'step-2', title: 'Step 2', promptBlocks: { goal: 'Structured goal.' } },
      { id: 'step-3', title: 'Step 3', prompt: 'Another raw prompt.' },
    ];
    const result = resolvePromptBlocksPass(steps);
    expect(result.isOk()).toBe(true);
    const resolved = result._unsafeUnwrap();
    expect(resolved[0]!.prompt).toBe('Raw prompt.');
    expect(resolved[1]!.prompt).toBe('## Goal\nStructured goal.');
    expect(resolved[2]!.prompt).toBe('Another raw prompt.');
  });
});
