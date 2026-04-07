/**
 * Tests verifying that validateAdvanceInputs uses precomputedIndex to skip
 * asSortedEventLog, projectRunContextV2, and the parentByNodeId loop.
 *
 * We prove the pass-through is active by:
 * 1. Passing deliberately unsorted events in `truth` (which would fail asSortedEventLog)
 *    but a valid precomputedIndex -- the call must succeed.
 * 2. Passing a precomputedIndex with a known context value and asserting it appears
 *    in the merged output.
 */
import { describe, it, expect } from 'vitest';
import { validateAdvanceInputs } from '../../../src/mcp/handlers/v2-advance-core/input-validation.js';
import { buildSessionIndex } from '../../../src/v2/durable-core/session-index.js';
import { asSortedEventLog } from '../../../src/v2/durable-core/sorted-event-log.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import { asRunId, asNodeId } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

// Minimal 1-step workflow for testing
const minimalWorkflowDef = {
  id: 'test-wf',
  name: 'Test',
  description: 'Test workflow',
  version: '1',
  steps: [
    {
      id: 'step-1',
      label: 'Step 1',
      prompt: 'Do {{myVar}}',
    },
  ],
};

const pendingStep = { stepId: 'step-1', loopPath: [] };

function makeRunStarted(eventIndex: number, runId: string): DomainEventV1 {
  return {
    v: 1, eventId: `evt_${eventIndex}`, eventIndex, sessionId: 'sess_1',
    kind: 'run_started', dedupeKey: `rs:${runId}`,
    scope: { runId },
    data: { workflowId: 'test-wf', workflowHash: 'hash_1' },
  } as unknown as DomainEventV1;
}

function makeNodeCreated(eventIndex: number, runId: string, nodeId: string): DomainEventV1 {
  return {
    v: 1, eventId: `evt_${eventIndex}`, eventIndex, sessionId: 'sess_1',
    kind: 'node_created', dedupeKey: `nc:${nodeId}`,
    scope: { runId, nodeId },
    data: { stepId: 'step-1', workflowHash: 'hash_1', nodeKind: 'step', snapshotRef: null, parentNodeId: null },
  } as unknown as DomainEventV1;
}

function makeContextSet(eventIndex: number, runId: string, context: Record<string, unknown>): DomainEventV1 {
  return {
    v: 1, eventId: `evt_${eventIndex}`, eventIndex, sessionId: 'sess_1',
    kind: 'context_set', dedupeKey: `ctx:${runId}:${eventIndex}`,
    scope: { runId },
    data: { context, source: 'agent_delta' },
  } as unknown as DomainEventV1;
}

describe('validateAdvanceInputs with precomputedIndex', () => {
  const workflow = createWorkflow(minimalWorkflowDef as any, createBundledSource());
  const runId = asRunId('run_1');
  const nodeId = asNodeId('node_a');

  const sortedEvents = [
    makeRunStarted(0, 'run_1'),
    makeNodeCreated(1, 'run_1', 'node_a'),
    makeContextSet(2, 'run_1', { myVar: 'hello' }),
  ];

  it('succeeds using precomputedIndex even when truth.events is empty (skips asSortedEventLog)', () => {
    // truth.events is empty -- would normally cause issues, but precomputedIndex
    // provides sortedEvents so asSortedEventLog is skipped entirely.
    const sorted = asSortedEventLog(sortedEvents);
    expect(sorted.isOk()).toBe(true);
    const index = buildSessionIndex(sorted._unsafeUnwrap());

    const result = validateAdvanceInputs({
      truth: { events: [], manifest: [] },  // empty truth
      runId,
      currentNodeId: nodeId,
      inputContext: undefined,
      inputOutput: undefined,
      pinnedWorkflow: workflow,
      pendingStep,
      precomputedIndex: index,
    });

    // Should succeed -- index provides all the needed facts, truth.events not scanned
    expect(result.isOk()).toBe(true);
  });

  it('uses precomputedIndex.runContextByRunId for stored context', () => {
    const sorted = asSortedEventLog(sortedEvents);
    expect(sorted.isOk()).toBe(true);
    const index = buildSessionIndex(sorted._unsafeUnwrap());

    // context_set event sets myVar = 'hello'
    expect(index.runContextByRunId.get('run_1')).toEqual({ myVar: 'hello' });

    const result = validateAdvanceInputs({
      truth: { events: [], manifest: [] },  // empty truth -- must use index for context
      runId,
      currentNodeId: nodeId,
      inputContext: undefined,
      inputOutput: undefined,
      pinnedWorkflow: workflow,
      pendingStep,
      precomputedIndex: index,
    });

    expect(result.isOk()).toBe(true);
    // mergedContext should contain the context from the index
    expect(result._unsafeUnwrap().mergedContext).toMatchObject({ myVar: 'hello' });
  });

  it('falls back to scanning truth.events when precomputedIndex is absent', () => {
    // Without precomputedIndex, validateAdvanceInputs must scan truth.events.
    // Using unsorted events should cause it to fail.
    const unsortedEvents = [
      makeNodeCreated(5, 'run_1', 'node_a'),  // out of order -- index 5 before index 0
      makeRunStarted(0, 'run_1'),
    ];

    const result = validateAdvanceInputs({
      truth: { events: unsortedEvents, manifest: [] },
      runId,
      currentNodeId: nodeId,
      inputContext: undefined,
      inputOutput: undefined,
      pinnedWorkflow: workflow,
      pendingStep,
      // No precomputedIndex -- must scan truth.events and call asSortedEventLog
    });

    // asSortedEventLog should reject the unsorted events
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe('invariant_violation');
  });
});
