/**
 * Unit tests for the gitEvidence field of projectSessionMetricsV2.
 *
 * Tests cover:
 * - gitEvidence is null when no git_metrics_recorded event is present (backward compat)
 * - gitEvidence is populated when git_metrics_recorded event is present
 * - captureConfidence values: high, partial, none
 * - null committedDiff when diff fields are null (command failed)
 * - null workingTree when status fields are null (command failed)
 * - prRefs and commitShas from event data
 */

import { describe, it, expect } from 'vitest';
import { projectSessionMetricsV2 } from '../../src/v2/projections/session-metrics.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess_test123';
const RUN_ID = 'run_abc';

function makeRunCompletedEvent(opts: {
  startGitSha?: string | null;
  endGitSha?: string | null;
  captureConfidence?: 'high' | 'none';
}): DomainEventV1 {
  return {
    v: 1,
    eventId: 'evt_rc',
    eventIndex: 0,
    sessionId: SESSION_ID,
    kind: 'run_completed',
    scope: { runId: RUN_ID },
    data: {
      startGitSha: opts.startGitSha ?? null,
      endGitSha: opts.endGitSha ?? null,
      gitBranch: 'main',
      agentCommitShas: [],
      captureConfidence: opts.captureConfidence ?? 'none',
      durationMs: 1000,
    },
    timestampMs: Date.now(),
  } as unknown as DomainEventV1;
}

function makeGitMetricsEvent(opts: {
  startSha?: string | null;
  endSha?: string | null;
  commitShas?: string[];
  prRefs?: number[];
  filesChanged?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  truncated?: boolean;
  stagedFiles?: number | null;
  unstagedFiles?: number | null;
  captureConfidence?: 'high' | 'partial' | 'none';
}): DomainEventV1 {
  return {
    v: 1,
    eventId: 'evt_gm',
    eventIndex: 1,
    sessionId: SESSION_ID,
    kind: 'git_metrics_recorded',
    scope: { runId: RUN_ID },
    data: {
      startSha: opts.startSha ?? null,
      endSha: opts.endSha ?? null,
      commitShas: opts.commitShas ?? [],
      prRefs: opts.prRefs ?? [],
      filesChanged: opts.filesChanged ?? null,
      linesAdded: opts.linesAdded ?? null,
      linesRemoved: opts.linesRemoved ?? null,
      truncated: opts.truncated ?? false,
      stagedFiles: opts.stagedFiles ?? null,
      unstagedFiles: opts.unstagedFiles ?? null,
      captureConfidence: opts.captureConfidence ?? 'none',
    },
    timestampMs: Date.now(),
  } as unknown as DomainEventV1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectSessionMetricsV2 -- gitEvidence field', () => {
  it('returns null gitEvidence when no git_metrics_recorded event is present (backward compat)', () => {
    const events: DomainEventV1[] = [makeRunCompletedEvent({})];

    const result = projectSessionMetricsV2(events);

    expect(result).not.toBeNull();
    expect(result!.gitEvidence).toBeNull();
  });

  it('returns null when no run_completed event is present', () => {
    const events: DomainEventV1[] = [];

    const result = projectSessionMetricsV2(events);

    expect(result).toBeNull();
  });

  it('populates gitEvidence from git_metrics_recorded event', () => {
    const sha1 = 'a'.repeat(40);
    const events: DomainEventV1[] = [
      makeRunCompletedEvent({ startGitSha: 'start123', endGitSha: sha1 }),
      makeGitMetricsEvent({
        startSha: 'start123',
        endSha: sha1,
        commitShas: [sha1],
        prRefs: [42],
        filesChanged: 3,
        linesAdded: 50,
        linesRemoved: 10,
        truncated: false,
        stagedFiles: 0,
        unstagedFiles: 0,
        captureConfidence: 'high',
      }),
    ];

    const result = projectSessionMetricsV2(events);

    expect(result).not.toBeNull();
    expect(result!.gitEvidence).toEqual({
      startSha: 'start123',
      endSha: sha1,
      commitShas: [sha1],
      prRefs: [42],
      committedDiff: {
        filesChanged: 3,
        linesAdded: 50,
        linesRemoved: 10,
        truncated: false,
      },
      workingTree: {
        stagedFiles: 0,
        unstagedFiles: 0,
      },
      captureConfidence: 'high',
    });
  });

  it('returns null committedDiff when diff fields are null (git diff failed)', () => {
    const events: DomainEventV1[] = [
      makeRunCompletedEvent({}),
      makeGitMetricsEvent({
        startSha: 'abc',
        endSha: 'def',
        filesChanged: null,
        linesAdded: null,
        linesRemoved: null,
        captureConfidence: 'partial',
      }),
    ];

    const result = projectSessionMetricsV2(events);

    expect(result!.gitEvidence).not.toBeNull();
    expect(result!.gitEvidence!.committedDiff).toBeNull();
    expect(result!.gitEvidence!.captureConfidence).toBe('partial');
  });

  it('returns null workingTree when status fields are null (git status failed)', () => {
    const events: DomainEventV1[] = [
      makeRunCompletedEvent({}),
      makeGitMetricsEvent({
        filesChanged: 2,
        linesAdded: 5,
        linesRemoved: 1,
        stagedFiles: null,
        unstagedFiles: null,
        captureConfidence: 'partial',
      }),
    ];

    const result = projectSessionMetricsV2(events);

    expect(result!.gitEvidence!.committedDiff).not.toBeNull();
    expect(result!.gitEvidence!.workingTree).toBeNull();
  });

  it('reports captureConfidence=none from git_metrics_recorded', () => {
    const events: DomainEventV1[] = [
      makeRunCompletedEvent({}),
      makeGitMetricsEvent({ captureConfidence: 'none' }),
    ];

    const result = projectSessionMetricsV2(events);

    expect(result!.gitEvidence!.captureConfidence).toBe('none');
  });

  it('reports captureConfidence=partial from git_metrics_recorded', () => {
    const events: DomainEventV1[] = [
      makeRunCompletedEvent({}),
      makeGitMetricsEvent({ endSha: 'abc', captureConfidence: 'partial' }),
    ];

    const result = projectSessionMetricsV2(events);

    expect(result!.gitEvidence!.captureConfidence).toBe('partial');
  });

  it('uses first git_metrics_recorded event when multiple are present', () => {
    const events: DomainEventV1[] = [
      makeRunCompletedEvent({}),
      makeGitMetricsEvent({ captureConfidence: 'high', filesChanged: 10, linesAdded: 100, linesRemoved: 50 }),
      {
        ...makeGitMetricsEvent({ captureConfidence: 'none', filesChanged: 0, linesAdded: 0, linesRemoved: 0 }),
        eventIndex: 2,
        eventId: 'evt_gm2',
      } as unknown as DomainEventV1,
    ];

    const result = projectSessionMetricsV2(events);

    // First event wins
    expect(result!.gitEvidence!.captureConfidence).toBe('high');
    expect(result!.gitEvidence!.committedDiff?.filesChanged).toBe(10);
  });

  it('does not include git_metrics_recorded events from a different runId', () => {
    const events: DomainEventV1[] = [
      makeRunCompletedEvent({}),
      {
        ...makeGitMetricsEvent({ captureConfidence: 'high', filesChanged: 5, linesAdded: 50, linesRemoved: 10 }),
        scope: { runId: 'run_different' },
      } as unknown as DomainEventV1,
    ];

    const result = projectSessionMetricsV2(events);

    expect(result!.gitEvidence).toBeNull(); // different runId ignored
  });
});
