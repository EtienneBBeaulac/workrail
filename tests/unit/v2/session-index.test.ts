import { describe, it, expect } from 'vitest';
import { buildSessionIndex } from '../../../src/v2/durable-core/session-index.js';
import { asSortedEventLog } from '../../../src/v2/durable-core/sorted-event-log.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

// ---------------------------------------------------------------------------
// Test event factories
// ---------------------------------------------------------------------------

function makeRunStarted(eventIndex: number, runId: string): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${eventIndex}`,
    eventIndex,
    sessionId: 'sess_1',
    kind: 'run_started',
    dedupeKey: `run_started:sess_1:${runId}`,
    scope: { runId },
    data: { workflowId: 'wf_1', workflowHash: 'hash_1' },
  } as unknown as DomainEventV1;
}

function makeNodeCreated(eventIndex: number, runId: string, nodeId: string): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${eventIndex}`,
    eventIndex,
    sessionId: 'sess_1',
    kind: 'node_created',
    dedupeKey: `node_created:sess_1:${nodeId}`,
    scope: { runId, nodeId },
    data: { stepId: 'step_1', workflowHash: 'hash_1', nodeKind: 'step', snapshotRef: null },
  } as unknown as DomainEventV1;
}

function makeEdgeCreated(eventIndex: number, runId: string, fromNodeId: string, toNodeId: string): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${eventIndex}`,
    eventIndex,
    sessionId: 'sess_1',
    kind: 'edge_created',
    dedupeKey: `edge_created:sess_1:${fromNodeId}:${toNodeId}`,
    scope: { runId },
    data: { fromNodeId, toNodeId, edgeKind: 'acked_step' },
  } as unknown as DomainEventV1;
}

function makeAdvanceRecorded(eventIndex: number, runId: string, nodeId: string, dedupeKey: string): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${eventIndex}`,
    eventIndex,
    sessionId: 'sess_1',
    kind: 'advance_recorded',
    dedupeKey,
    scope: { runId, nodeId },
    data: { stepId: 'step_1', workflowHash: 'hash_1', continueToken: 'ct_abc' },
  } as unknown as DomainEventV1;
}

function sortedLog(events: DomainEventV1[]) {
  const result = asSortedEventLog(events);
  if (result.isErr()) throw new Error('Events not sorted');
  return result.value;
}

// ---------------------------------------------------------------------------
// Tests (written before implementation — TDD)
// ---------------------------------------------------------------------------

describe('buildSessionIndex', () => {
  it('extracts run_started events keyed by runId', () => {
    const events = [makeRunStarted(0, 'run_1')];
    const index = buildSessionIndex(sortedLog(events));

    expect(index.runStartedByRunId.get('run_1')).toBeDefined();
    expect(index.runStartedByRunId.get('run_1')?.kind).toBe('run_started');
    expect(index.runStartedByRunId.get('run_2')).toBeUndefined();
  });

  it('extracts node_created events keyed by nodeId', () => {
    const events = [
      makeRunStarted(0, 'run_1'),
      makeNodeCreated(1, 'run_1', 'node_a'),
    ];
    const index = buildSessionIndex(sortedLog(events));

    expect(index.nodeCreatedByNodeId.get('node_a')).toBeDefined();
    expect(index.nodeCreatedByNodeId.get('node_a')?.kind).toBe('node_created');
    expect(index.nodeCreatedByNodeId.get('node_z')).toBeUndefined();
  });

  it('correctly identifies nodes with child edges in hasChildEdgeByFromNodeId', () => {
    const events = [
      makeRunStarted(0, 'run_1'),
      makeNodeCreated(1, 'run_1', 'node_a'),
      makeNodeCreated(2, 'run_1', 'node_b'),
      makeEdgeCreated(3, 'run_1', 'node_a', 'node_b'),
    ];
    const index = buildSessionIndex(sortedLog(events));

    expect(index.hasChildEdgeByFromNodeId.has('node_a')).toBe(true);
    expect(index.hasChildEdgeByFromNodeId.has('node_b')).toBe(false); // node_b has no outgoing edges
    expect(index.hasChildEdgeByFromNodeId.has('node_z')).toBe(false);
  });

  it('extracts advance_recorded events keyed by dedupeKey', () => {
    const dedupeKey = 'advance_recorded:sess_1:node_a:v1';
    const events = [
      makeRunStarted(0, 'run_1'),
      makeNodeCreated(1, 'run_1', 'node_a'),
      makeAdvanceRecorded(2, 'run_1', 'node_a', dedupeKey),
    ];
    const index = buildSessionIndex(sortedLog(events));

    expect(index.advanceRecordedByDedupeKey.get(dedupeKey)).toBeDefined();
    expect(index.advanceRecordedByDedupeKey.get(dedupeKey)?.kind).toBe('advance_recorded');
    expect(index.advanceRecordedByDedupeKey.get('other_key')).toBeUndefined();
  });

  it('computes nextEventIndex as last event eventIndex + 1', () => {
    const events = [
      makeRunStarted(0, 'run_1'),
      makeNodeCreated(1, 'run_1', 'node_a'),
    ];
    const index = buildSessionIndex(sortedLog(events));

    expect(index.nextEventIndex).toBe(2);
  });

  it('computes nextEventIndex correctly for non-contiguous event indices', () => {
    // Events at indices [0, 5] — nextEventIndex should be 6, not 2
    const event0 = makeRunStarted(0, 'run_1');
    const event5 = makeNodeCreated(5, 'run_1', 'node_a');
    const index = buildSessionIndex(sortedLog([event0, event5]));

    expect(index.nextEventIndex).toBe(6);
  });

  it('returns empty maps and sets with nextEventIndex 0 for empty log', () => {
    const index = buildSessionIndex(sortedLog([]));

    expect(index.runStartedByRunId.size).toBe(0);
    expect(index.nodeCreatedByNodeId.size).toBe(0);
    expect(index.hasChildEdgeByFromNodeId.size).toBe(0);
    expect(index.advanceRecordedByDedupeKey.size).toBe(0);
    expect(index.nextEventIndex).toBe(0);
  });

  it('handles multi-run sessions: runStartedByRunId contains entries for multiple runIds', () => {
    const events = [
      makeRunStarted(0, 'run_1'),
      makeNodeCreated(1, 'run_1', 'node_a'),
      makeRunStarted(2, 'run_2'),
      makeNodeCreated(3, 'run_2', 'node_b'),
    ];
    const index = buildSessionIndex(sortedLog(events));

    expect(index.runStartedByRunId.size).toBe(2);
    expect(index.runStartedByRunId.get('run_1')).toBeDefined();
    expect(index.runStartedByRunId.get('run_2')).toBeDefined();
  });

  it('TOCTOU: index built after advance_recorded write reflects the new record', () => {
    // Pre-lock: no advance recorded
    const preLockEvents = [
      makeRunStarted(0, 'run_1'),
      makeNodeCreated(1, 'run_1', 'node_a'),
    ];
    const preLockIndex = buildSessionIndex(sortedLog(preLockEvents));

    // Post-lock: concurrent writer added advance_recorded
    const dedupeKey = 'advance_recorded:sess_1:node_a:v1';
    const postLockEvents = [
      ...preLockEvents,
      makeAdvanceRecorded(2, 'run_1', 'node_a', dedupeKey),
    ];
    const lockedIndex = buildSessionIndex(sortedLog(postLockEvents));

    // preLockIndex does NOT have the record (safe early-exit guard)
    expect(preLockIndex.advanceRecordedByDedupeKey.has(dedupeKey)).toBe(false);
    // lockedIndex DOES have the record (correct dedup check)
    expect(lockedIndex.advanceRecordedByDedupeKey.has(dedupeKey)).toBe(true);
  });

  it('silently ignores unknown event kinds (forward compatibility)', () => {
    const events = [
      makeRunStarted(0, 'run_1'),
      // Simulate a future event kind unknown to this version
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'future_unknown_kind',
        dedupeKey: 'future:sess_1',
        scope: {},
        data: {},
      } as unknown as DomainEventV1,
    ];
    // Should not throw
    const index = buildSessionIndex(sortedLog(events));
    expect(index.runStartedByRunId.size).toBe(1);
    expect(index.nextEventIndex).toBe(2);
  });
});
