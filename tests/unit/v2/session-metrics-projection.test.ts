/**
 * Tests for projectSessionMetricsV2 projection.
 *
 * 8 test cases as specified in the pitch (step 4 of 6 metrics sequence).
 */
import { describe, it, expect } from 'vitest';
import { projectSessionMetricsV2 } from '../../../src/v2/projections/session-metrics.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSessionCreatedEvent(eventIndex = 0): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${eventIndex}`,
    eventIndex,
    sessionId: 'sess_1',
    kind: 'session_created',
    dedupeKey: `session_created:sess_1`,
    data: {},
  } as DomainEventV1;
}

function makeRunStartedEvent(runId: string, eventIndex: number): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${eventIndex}`,
    eventIndex,
    sessionId: 'sess_1',
    kind: 'run_started',
    dedupeKey: `run_started:sess_1:${runId}`,
    scope: { runId },
    data: {
      runId,
      workflowId: null,
      workflowHash: null,
    },
  } as unknown as DomainEventV1;
}

function makeRunCompletedEvent(args: {
  runId: string;
  eventIndex: number;
  startGitSha?: string | null;
  endGitSha?: string | null;
  gitBranch?: string | null;
  agentCommitShas?: string[];
  captureConfidence?: 'high' | 'none';
  durationMs?: number;
}): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${args.eventIndex}`,
    eventIndex: args.eventIndex,
    sessionId: 'sess_1',
    kind: 'run_completed',
    dedupeKey: `run_completed:sess_1:${args.runId}`,
    scope: { runId: args.runId },
    data: {
      startGitSha: args.startGitSha ?? null,
      endGitSha: args.endGitSha ?? null,
      gitBranch: args.gitBranch ?? null,
      agentCommitShas: args.agentCommitShas ?? [],
      captureConfidence: args.captureConfidence ?? 'none',
      durationMs: args.durationMs,
    },
  };
}

function makeContextSetEvent(args: {
  runId: string;
  eventIndex: number;
  context: Record<string, unknown>;
}): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${args.eventIndex}`,
    eventIndex: args.eventIndex,
    sessionId: 'sess_1',
    kind: 'context_set',
    dedupeKey: `context_set:sess_1:${args.runId}:ctx_${args.eventIndex}`,
    scope: { runId: args.runId },
    data: {
      contextId: `ctx_${args.eventIndex}`,
      context: args.context,
      source: 'agent_delta',
    },
  } as unknown as DomainEventV1;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('projectSessionMetricsV2', () => {
  it('1. returns null when no run_completed event', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      {
        v: 1,
        eventId: 'evt_2',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: { nodeKind: 'step' },
      } as unknown as DomainEventV1,
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).toBeNull();
  });

  it('2. returns non-null with all agent fields null when run_completed present but no context_set metrics', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      makeRunCompletedEvent({
        runId: 'run_1',
        eventIndex: 2,
        startGitSha: 'abc123',
        endGitSha: 'def456',
        gitBranch: 'main',
        agentCommitShas: [],
        captureConfidence: 'high',
        durationMs: 5000,
      }),
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    // Engine fields populated
    expect(result.startGitSha).toBe('abc123');
    expect(result.endGitSha).toBe('def456');
    expect(result.gitBranch).toBe('main');
    expect(result.captureConfidence).toBe('high');
    expect(result.durationMs).toBe(5000);

    // Agent fields all null/empty
    expect(result.outcome).toBeNull();
    expect(result.prNumbers).toEqual([]);
    expect(result.filesChanged).toBeNull();
    expect(result.linesAdded).toBeNull();
    expect(result.linesRemoved).toBeNull();
  });

  it('3. returns full data when run_completed + all metrics_* context_set keys present', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      makeRunCompletedEvent({
        runId: 'run_1',
        eventIndex: 2,
        startGitSha: 'start111',
        endGitSha: 'end222',
        gitBranch: 'feat/my-feature',
        agentCommitShas: [],
        captureConfidence: 'high',
        durationMs: 12000,
      }),
      makeContextSetEvent({
        runId: 'run_1',
        eventIndex: 3,
        context: {
          metrics_outcome: 'success',
          metrics_pr_numbers: [42, 43],
          metrics_commit_shas: ['sha1', 'sha2'],
          metrics_files_changed: 10,
          metrics_lines_added: 150,
          metrics_lines_removed: 30,
        },
      }),
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.startGitSha).toBe('start111');
    expect(result.endGitSha).toBe('end222');
    expect(result.gitBranch).toBe('feat/my-feature');
    expect(result.captureConfidence).toBe('high');
    expect(result.durationMs).toBe(12000);
    expect(result.outcome).toBe('success');
    expect(result.prNumbers).toEqual([42, 43]);
    expect(result.agentCommitShas).toEqual(['sha1', 'sha2']);
    expect(result.filesChanged).toBe(10);
    expect(result.linesAdded).toBe(150);
    expect(result.linesRemoved).toBe(30);
  });

  it('4. partial agent metrics: only metrics_outcome set, other agent fields null', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      makeRunCompletedEvent({ runId: 'run_1', eventIndex: 2, captureConfidence: 'none' }),
      makeContextSetEvent({
        runId: 'run_1',
        eventIndex: 3,
        context: { metrics_outcome: 'abandoned' },
      }),
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.outcome).toBe('abandoned');
    expect(result.prNumbers).toEqual([]);
    expect(result.filesChanged).toBeNull();
    expect(result.linesAdded).toBeNull();
    expect(result.linesRemoved).toBeNull();
  });

  it('5. invalid metric type gracefully returns null for that field', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      makeRunCompletedEvent({ runId: 'run_1', eventIndex: 2, captureConfidence: 'none' }),
      makeContextSetEvent({
        runId: 'run_1',
        eventIndex: 3,
        context: {
          metrics_files_changed: 'not-a-number',
          metrics_lines_added: null,
          metrics_outcome: 'not-a-valid-outcome',
        },
      }),
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.filesChanged).toBeNull();
    expect(result.linesAdded).toBeNull();
    expect(result.outcome).toBeNull();
  });

  it('6. prNumbers: extracted correctly from JSON array', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      makeRunCompletedEvent({ runId: 'run_1', eventIndex: 2, captureConfidence: 'none' }),
      makeContextSetEvent({
        runId: 'run_1',
        eventIndex: 3,
        context: { metrics_pr_numbers: [1, 2, 3] },
      }),
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.prNumbers).toEqual([1, 2, 3]);
  });

  it('7. agentCommitShas: extracted correctly from metrics_commit_shas (last context_set wins)', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      makeRunCompletedEvent({ runId: 'run_1', eventIndex: 2, captureConfidence: 'none' }),
      // First context_set: partial list
      makeContextSetEvent({
        runId: 'run_1',
        eventIndex: 3,
        context: { metrics_commit_shas: ['abc123'] },
      }),
      // Second context_set: accumulated full list
      makeContextSetEvent({
        runId: 'run_1',
        eventIndex: 4,
        context: { metrics_commit_shas: ['abc123', 'def456'] },
      }),
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    // Last context_set wins -- should have the full accumulated list
    expect(result.agentCommitShas).toEqual(['abc123', 'def456']);
  });

  it('8. multi-run: first run_completed by event order wins', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(0),
      makeRunStartedEvent('run_1', 1),
      makeRunStartedEvent('run_2', 2),
      // run_1 completes first (lower eventIndex)
      makeRunCompletedEvent({
        runId: 'run_1',
        eventIndex: 3,
        startGitSha: 'run1-start',
        endGitSha: 'run1-end',
        gitBranch: 'branch-run1',
        captureConfidence: 'high',
        durationMs: 1000,
      }),
      // run_2 completes second (higher eventIndex)
      makeRunCompletedEvent({
        runId: 'run_2',
        eventIndex: 4,
        startGitSha: 'run2-start',
        endGitSha: 'run2-end',
        gitBranch: 'branch-run2',
        captureConfidence: 'none',
        durationMs: 2000,
      }),
      // context_set for run_1 (the winning run)
      makeContextSetEvent({
        runId: 'run_1',
        eventIndex: 5,
        context: { metrics_outcome: 'success' },
      }),
      // context_set for run_2 (ignored)
      makeContextSetEvent({
        runId: 'run_2',
        eventIndex: 6,
        context: { metrics_outcome: 'error' },
      }),
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    // First run_completed (run_1) wins
    expect(result.gitBranch).toBe('branch-run1');
    expect(result.startGitSha).toBe('run1-start');
    expect(result.durationMs).toBe(1000);
    expect(result.captureConfidence).toBe('high');
    // Context from run_1 applied
    expect(result.outcome).toBe('success');
  });

  it('degrades gracefully when run_completed.data has unexpected shape', () => {
    const events: DomainEventV1[] = [
      makeSessionCreatedEvent(),
      // run_completed with malformed data -- all engine fields should degrade to null/empty
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'run_completed',
        dedupeKey: 'run_completed:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { unexpectedField: 'foo', anotherField: 42 },
      } as unknown as DomainEventV1,
    ];

    const result = projectSessionMetricsV2(events);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.startGitSha).toBeNull();
    expect(result.endGitSha).toBeNull();
    expect(result.gitBranch).toBeNull();
    expect(result.agentCommitShas).toEqual([]);
    expect(result.captureConfidence).toBe('none');
    expect(result.durationMs).toBeUndefined();
  });
});
