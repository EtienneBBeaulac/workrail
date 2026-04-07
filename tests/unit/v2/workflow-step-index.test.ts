/**
 * Tests for the pre-built workflow index structures.
 *
 * These tests verify that:
 * 1. createWorkflow() builds correct indices (stepById, parentLoopByStepId, loopById)
 * 2. getStepById() returns the same result as a manual scan (correctness parity)
 * 3. Edge cases: empty workflow, multiple loops, step not found
 */
import { describe, it, expect } from 'vitest';
import { createWorkflow, getStepById, getAllStepIds } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSimpleWorkflow(): ReturnType<typeof createWorkflow> {
  const def: WorkflowDefinition = {
    id: 'test-simple',
    name: 'Simple',
    description: 'A simple workflow',
    version: '1.0.0',
    steps: [
      { id: 'step-1', title: 'Step 1', prompt: 'Do step 1', requireConfirmation: false },
      { id: 'step-2', title: 'Step 2', prompt: 'Do step 2', requireConfirmation: false },
    ],
  } as WorkflowDefinition;
  return createWorkflow(def, createBundledSource());
}

function makeLoopWorkflow(): ReturnType<typeof createWorkflow> {
  const def: WorkflowDefinition = {
    id: 'test-loop',
    name: 'Loop Workflow',
    description: 'A workflow with a loop',
    version: '1.0.0',
    steps: [
      { id: 'step-before', title: 'Before', prompt: 'Before loop', requireConfirmation: false },
      {
        id: 'loop-1',
        type: 'loop',
        title: 'Loop 1',
        loop: { type: 'count', maxIterations: 3 },
        body: [
          { id: 'loop-body-1', title: 'Body Step 1', prompt: 'Loop body 1', requireConfirmation: false },
          { id: 'loop-body-2', title: 'Body Step 2', prompt: 'Loop body 2', requireConfirmation: false },
          {
            id: 'loop-exit-1',
            title: 'Loop Exit',
            prompt: 'Exit?',
            requireConfirmation: false,
            outputContract: { contractRef: 'wr.contracts.loop_control' },
          },
        ],
      },
      { id: 'step-after', title: 'After', prompt: 'After loop', requireConfirmation: false },
    ],
  } as unknown as WorkflowDefinition;
  return createWorkflow(def, createBundledSource());
}

function makeMultiLoopWorkflow(): ReturnType<typeof createWorkflow> {
  const def: WorkflowDefinition = {
    id: 'test-multi-loop',
    name: 'Multi-Loop Workflow',
    description: 'A workflow with two loops',
    version: '1.0.0',
    steps: [
      {
        id: 'loop-a',
        type: 'loop',
        title: 'Loop A',
        loop: { type: 'count', maxIterations: 2 },
        body: [
          { id: 'loop-a-body-1', title: 'A Body 1', prompt: 'A body 1', requireConfirmation: false },
          {
            id: 'loop-a-exit',
            title: 'A Exit',
            prompt: 'A exit',
            requireConfirmation: false,
            outputContract: { contractRef: 'wr.contracts.loop_control' },
          },
        ],
      },
      {
        id: 'loop-b',
        type: 'loop',
        title: 'Loop B',
        loop: { type: 'count', maxIterations: 2 },
        body: [
          { id: 'loop-b-body-1', title: 'B Body 1', prompt: 'B body 1', requireConfirmation: false },
          {
            id: 'loop-b-exit',
            title: 'B Exit',
            prompt: 'B exit',
            requireConfirmation: false,
            outputContract: { contractRef: 'wr.contracts.loop_control' },
          },
        ],
      },
    ],
  } as unknown as WorkflowDefinition;
  return createWorkflow(def, createBundledSource());
}

function makeEmptyWorkflow(): ReturnType<typeof createWorkflow> {
  const def: WorkflowDefinition = {
    id: 'test-empty',
    name: 'Empty',
    description: 'An empty workflow',
    version: '1.0.0',
    steps: [],
  } as WorkflowDefinition;
  return createWorkflow(def, createBundledSource());
}

// ---------------------------------------------------------------------------
// stepById index
// ---------------------------------------------------------------------------

describe('workflow.stepById index', () => {
  it('maps top-level step IDs to their definitions', () => {
    const wf = makeSimpleWorkflow();
    expect(wf.stepById.get('step-1')).toBeDefined();
    expect(wf.stepById.get('step-1')?.id).toBe('step-1');
    expect(wf.stepById.get('step-2')).toBeDefined();
    expect(wf.stepById.get('step-2')?.id).toBe('step-2');
  });

  it('maps loop step IDs to their loop step definitions', () => {
    const wf = makeLoopWorkflow();
    expect(wf.stepById.get('loop-1')).toBeDefined();
    expect(wf.stepById.get('loop-1')?.id).toBe('loop-1');
  });

  it('maps loop body step IDs to their definitions', () => {
    const wf = makeLoopWorkflow();
    expect(wf.stepById.get('loop-body-1')).toBeDefined();
    expect(wf.stepById.get('loop-body-1')?.id).toBe('loop-body-1');
    expect(wf.stepById.get('loop-body-2')).toBeDefined();
    expect(wf.stepById.get('loop-exit-1')).toBeDefined();
  });

  it('returns undefined for an unknown step ID', () => {
    const wf = makeSimpleWorkflow();
    expect(wf.stepById.get('nonexistent')).toBeUndefined();
  });

  it('is empty for a workflow with no steps', () => {
    const wf = makeEmptyWorkflow();
    expect(wf.stepById.size).toBe(0);
  });

  it('indexes all steps across multiple loops', () => {
    const wf = makeMultiLoopWorkflow();
    expect(wf.stepById.get('loop-a')).toBeDefined();
    expect(wf.stepById.get('loop-b')).toBeDefined();
    expect(wf.stepById.get('loop-a-body-1')).toBeDefined();
    expect(wf.stepById.get('loop-b-body-1')).toBeDefined();
    expect(wf.stepById.get('loop-a-exit')).toBeDefined();
    expect(wf.stepById.get('loop-b-exit')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// parentLoopByStepId index
// ---------------------------------------------------------------------------

describe('workflow.parentLoopByStepId index', () => {
  it('maps loop body steps to their parent loop step', () => {
    const wf = makeLoopWorkflow();
    const parent = wf.parentLoopByStepId.get('loop-body-1');
    expect(parent).toBeDefined();
    expect(parent?.id).toBe('loop-1');
  });

  it('maps all loop body steps to the correct parent', () => {
    const wf = makeLoopWorkflow();
    expect(wf.parentLoopByStepId.get('loop-body-2')?.id).toBe('loop-1');
    expect(wf.parentLoopByStepId.get('loop-exit-1')?.id).toBe('loop-1');
  });

  it('does NOT include top-level steps (no parent loop)', () => {
    const wf = makeLoopWorkflow();
    expect(wf.parentLoopByStepId.get('step-before')).toBeUndefined();
    expect(wf.parentLoopByStepId.get('step-after')).toBeUndefined();
  });

  it('does NOT include the loop step itself as a child of itself', () => {
    const wf = makeLoopWorkflow();
    expect(wf.parentLoopByStepId.get('loop-1')).toBeUndefined();
  });

  it('maps steps from each loop to their respective parent in multi-loop workflows', () => {
    const wf = makeMultiLoopWorkflow();
    expect(wf.parentLoopByStepId.get('loop-a-body-1')?.id).toBe('loop-a');
    expect(wf.parentLoopByStepId.get('loop-a-exit')?.id).toBe('loop-a');
    expect(wf.parentLoopByStepId.get('loop-b-body-1')?.id).toBe('loop-b');
    expect(wf.parentLoopByStepId.get('loop-b-exit')?.id).toBe('loop-b');
  });

  it('is empty for a workflow with no loops', () => {
    const wf = makeSimpleWorkflow();
    expect(wf.parentLoopByStepId.size).toBe(0);
  });

  it('is empty for an empty workflow', () => {
    const wf = makeEmptyWorkflow();
    expect(wf.parentLoopByStepId.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loopById index
// ---------------------------------------------------------------------------

describe('workflow.loopById index', () => {
  it('maps loop step IDs to their LoopStepDefinition', () => {
    const wf = makeLoopWorkflow();
    const loop = wf.loopById.get('loop-1');
    expect(loop).toBeDefined();
    expect(loop?.id).toBe('loop-1');
    expect(loop?.type).toBe('loop');
  });

  it('returns undefined for non-loop step IDs', () => {
    const wf = makeLoopWorkflow();
    expect(wf.loopById.get('step-before')).toBeUndefined();
    expect(wf.loopById.get('loop-body-1')).toBeUndefined();
  });

  it('indexes all loops in a multi-loop workflow', () => {
    const wf = makeMultiLoopWorkflow();
    expect(wf.loopById.get('loop-a')?.id).toBe('loop-a');
    expect(wf.loopById.get('loop-b')?.id).toBe('loop-b');
  });

  it('is empty for a workflow with no loops', () => {
    const wf = makeSimpleWorkflow();
    expect(wf.loopById.size).toBe(0);
  });

  it('is empty for an empty workflow', () => {
    const wf = makeEmptyWorkflow();
    expect(wf.loopById.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getStepById correctness parity
// ---------------------------------------------------------------------------

describe('getStepById correctness parity', () => {
  it('returns the correct top-level step', () => {
    const wf = makeSimpleWorkflow();
    const result = getStepById(wf, 'step-1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('step-1');
  });

  it('returns the correct loop body step', () => {
    const wf = makeLoopWorkflow();
    const result = getStepById(wf, 'loop-body-1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('loop-body-1');
  });

  it('returns null for an unknown step ID', () => {
    const wf = makeSimpleWorkflow();
    expect(getStepById(wf, 'nonexistent')).toBeNull();
  });

  it('returns the correct step for each step ID in the workflow (parity sweep)', () => {
    const wf = makeLoopWorkflow();
    const allIds = [
      'step-before', 'loop-1', 'loop-body-1', 'loop-body-2', 'loop-exit-1', 'step-after',
    ];
    for (const id of allIds) {
      const result = getStepById(wf, id);
      expect(result?.id).toBe(id);
    }
  });

  it('returns null for all lookup attempts on an empty workflow', () => {
    const wf = makeEmptyWorkflow();
    expect(getStepById(wf, 'step-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// body: string (loop step with a string reference body)
// ---------------------------------------------------------------------------

function makeStringBodyLoopWorkflow(): ReturnType<typeof createWorkflow> {
  // A loop where body is a string reference to a top-level step, not an
  // inline array. The string body value must NOT be treated as a step, and
  // the referenced top-level step must NOT appear in parentLoopByStepId.
  const def = {
    id: 'test-string-body-loop',
    name: 'String Body Loop',
    description: 'A workflow with a loop whose body is a string reference',
    version: '1.0.0',
    steps: [
      {
        id: 'string-body-loop',
        type: 'loop',
        title: 'String Body Loop',
        loop: { type: 'count', maxIterations: 3 },
        body: 'ref-step',
      },
      {
        id: 'ref-step',
        title: 'Referenced Step',
        prompt: 'I am referenced by the loop body string',
        requireConfirmation: false,
      },
    ],
  } as unknown as WorkflowDefinition;
  return createWorkflow(def, createBundledSource());
}

describe('workflow indices: loop with body as a string reference', () => {
  it('indexes the loop step in loopById', () => {
    const wf = makeStringBodyLoopWorkflow();
    expect(wf.loopById.get('string-body-loop')).toBeDefined();
    expect(wf.loopById.get('string-body-loop')?.id).toBe('string-body-loop');
  });

  it('indexes the loop step in stepById', () => {
    const wf = makeStringBodyLoopWorkflow();
    expect(wf.stepById.get('string-body-loop')).toBeDefined();
  });

  it('does NOT treat the string body value itself as a step ID', () => {
    const wf = makeStringBodyLoopWorkflow();
    // 'ref-step' exists as a top-level step, but the string 'ref-step' as
    // a body value should not cause it to appear in parentLoopByStepId.
    expect(wf.parentLoopByStepId.get('ref-step')).toBeUndefined();
  });

  it('does NOT add any entries to parentLoopByStepId for a string body loop', () => {
    const wf = makeStringBodyLoopWorkflow();
    // Only the top-level steps exist; none should be a loop child.
    expect(wf.parentLoopByStepId.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getAllStepIds ordering
// ---------------------------------------------------------------------------

describe('getAllStepIds ordering', () => {
  it('returns top-level step IDs in definition order for a simple workflow', () => {
    const wf = makeSimpleWorkflow();
    expect(getAllStepIds(wf)).toEqual(['step-1', 'step-2']);
  });

  it('returns steps in DFS definition order (loop body steps immediately after their loop step)', () => {
    // Map insertion order is spec-guaranteed; this test makes the contract
    // explicit: createWorkflow() uses a DFS traversal, so loop body steps
    // appear immediately after their parent loop step, not at the end.
    const wf = makeLoopWorkflow();
    const ids = getAllStepIds(wf);
    expect(ids).toEqual([
      'step-before',
      'loop-1',
      'loop-body-1',
      'loop-body-2',
      'loop-exit-1',
      'step-after',
    ]);
  });

  it('returns an empty array for an empty workflow', () => {
    const wf = makeEmptyWorkflow();
    expect(getAllStepIds(wf)).toEqual([]);
  });
});
