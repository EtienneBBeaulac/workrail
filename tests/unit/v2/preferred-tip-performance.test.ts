import { describe, it, expect } from 'vitest';
import { projectRunDagV2 } from '../../../src/v2/projections/run-dag.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

/**
 * Preferred tip performance tests.
 *
 * Lock: docs/design/v2-core-design-locks.md Section 16.5 Sub-phase G
 *
 * NOTE: This is a micro-benchmark and can be CI-noisy. If it flakes, prefer relaxing
 * thresholds or running locally rather than deleting coverage.
 */

function generateForkStressEvents(numForks: number): DomainEventV1[] {
  const wfHash = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
  const snapRef = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';

  const events: DomainEventV1[] = [];
  let eventIndex = 0;

  events.push({
    v: 1,
    eventId: 'evt_run',
    eventIndex: eventIndex++,
    sessionId: 'sess_stress',
    kind: 'run_started',
    dedupeKey: 'run_started:sess_stress:run_1',
    scope: { runId: 'run_1' },
    data: { workflowId: 'stress', workflowHash: wfHash, workflowSourceKind: 'project', workflowSourceRef: 'stress' },
  });

  events.push({
    v: 1,
    eventId: 'evt_root',
    eventIndex: eventIndex++,
    sessionId: 'sess_stress',
    kind: 'node_created',
    dedupeKey: 'node_created:sess_stress:run_1:root',
    scope: { runId: 'run_1', nodeId: 'root' },
    data: { nodeKind: 'step', parentNodeId: null, workflowHash: wfHash, snapshotRef: snapRef },
  });

  for (let i = 0; i < numForks; i++) {
    const nodeId = `fork_${i}`;

    events.push({
      v: 1,
      eventId: `evt_node_${i}`,
      eventIndex: eventIndex++,
      sessionId: 'sess_stress',
      kind: 'node_created',
      dedupeKey: `node_created:sess_stress:run_1:${nodeId}`,
      scope: { runId: 'run_1', nodeId },
      data: { nodeKind: 'step', parentNodeId: 'root', workflowHash: wfHash, snapshotRef: snapRef },
    });

    events.push({
      v: 1,
      eventId: `evt_edge_${i}`,
      eventIndex: eventIndex++,
      sessionId: 'sess_stress',
      kind: 'edge_created',
      dedupeKey: `edge_created:sess_stress:run_1:root->${nodeId}:acked_step`,
      scope: { runId: 'run_1' },
      data: {
        edgeKind: 'acked_step',
        fromNodeId: 'root',
        toNodeId: nodeId,
        // For acked_step edges, cause.kind must not be checkpoint_created per schema locks.
        cause: { kind: i === 0 ? 'intentional_fork' : 'non_tip_advance', eventId: `evt_edge_${i}` },
      },
    });

    // Add some per-node activity.
    for (let j = 0; j < 3; j++) {
      events.push({
        v: 1,
        eventId: `evt_gap_${i}_${j}`,
        eventIndex: eventIndex++,
        sessionId: 'sess_stress',
        kind: 'gap_recorded',
        dedupeKey: `gap_recorded:sess_stress:gap_${i}_${j}`,
        scope: { runId: 'run_1', nodeId },
        data: {
          gapId: `gap_${i}_${j}`,
          severity: 'info',
          reason: { category: 'unexpected', detail: 'invariant_violation' },
          summary: 'Activity',
          resolution: { kind: 'unresolved' },
        },
      });
    }
  }

  return events;
}

describe('Preferred tip performance (projection hot-path)', () => {
  it('handles 50 forks with 250+ events (correctness on large input)', () => {
    const events = generateForkStressEvents(50);
    expect(events.length).toBeGreaterThan(250);

    const res = projectRunDagV2(events);

    // PRIMARY ASSERTION: correctness
    expect(res.isOk()).toBe(true);
    const dag = res._unsafeUnwrap();
    const run = dag.runsById['run_1']!;

    // Verify structural correctness:
    // - All 50 forks should be created as nodes
    expect(Object.keys(run.nodesById).length).toBe(51); // root + 50 forks
    // - All forks should be tips (no outgoing edges)
    expect(run.tipNodeIds.length).toBe(50);
    // - Preferred tip should exist and be one of the tips
    expect(run.preferredTipNodeId).not.toBeNull();
    expect(run.tipNodeIds).toContain(run.preferredTipNodeId!);

    // Optional timing assertion (opt-in diagnostics only, gated by PERF_TESTS env var)
    if (process.env.PERF_TESTS === '1') {
      const start = performance.now();
      projectRunDagV2(events);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100);
    }
  });

  it('handles 100 forks with 500+ events (correctness on large input)', () => {
    const events = generateForkStressEvents(100);
    expect(events.length).toBeGreaterThan(500);

    const res = projectRunDagV2(events);

    // PRIMARY ASSERTION: correctness
    expect(res.isOk()).toBe(true);
    const dag = res._unsafeUnwrap();
    const run = dag.runsById['run_1']!;

    // Verify structural correctness:
    // - All 100 forks should be created as nodes
    expect(Object.keys(run.nodesById).length).toBe(101); // root + 100 forks
    // - All forks should be tips (no outgoing edges)
    expect(run.tipNodeIds.length).toBe(100);
    // - Preferred tip should exist and be one of the tips
    expect(run.preferredTipNodeId).not.toBeNull();
    expect(run.tipNodeIds).toContain(run.preferredTipNodeId!);

    // Optional timing assertion (opt-in diagnostics only, gated by PERF_TESTS env var)
    if (process.env.PERF_TESTS === '1') {
      const start = performance.now();
      projectRunDagV2(events);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(200);
    }
  });

  it('handles 1000 forks with 5000+ events (extreme stress, correctness only)', () => {
    const events = generateForkStressEvents(1000);
    expect(events.length).toBeGreaterThan(5000);

    const res = projectRunDagV2(events);

    // PRIMARY ASSERTION: correctness on extreme input
    expect(res.isOk()).toBe(true);
    const dag = res._unsafeUnwrap();
    const run = dag.runsById['run_1']!;

    // Verify structural correctness at scale:
    expect(Object.keys(run.nodesById).length).toBe(1001); // root + 1000 forks
    expect(run.tipNodeIds.length).toBe(1000);
    expect(run.preferredTipNodeId).not.toBeNull();
    expect(run.tipNodeIds).toContain(run.preferredTipNodeId!);
  });
});
