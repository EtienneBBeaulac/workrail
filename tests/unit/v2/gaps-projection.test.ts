/**
 * @enforces gaps-append-only-resolution
 */
import { describe, it, expect } from 'vitest';
import { projectGapsV2 } from '../../../src/v2/projections/gaps.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 gaps projection', () => {
  it('treats gaps as unresolved unless resolved by a later linkage record', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_gap_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_1',
          severity: 'critical',
          reason: { category: 'contract_violation', detail: 'missing_required_output' },
          summary: 'Missing required output',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_2',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_2',
          severity: 'info',
          reason: { category: 'unexpected', detail: 'invariant_violation' },
          summary: 'Resolution marker',
          resolution: { kind: 'resolves', resolvesGapId: 'gap_1' },
        },
      },
    ];

    const res = projectGapsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    expect(projected.resolvedGapIds.has('gap_1')).toBe(true);
    expect(projected.unresolvedCriticalByRunId['run_1'] ?? []).toEqual([]);
  });

  it('handles empty events array', () => {
    const res = projectGapsV2([]);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    expect(Object.keys(projected.byGapId)).toEqual([]);
    expect(projected.resolvedGapIds.size).toBe(0);
    expect(Object.keys(projected.unresolvedCriticalByRunId)).toEqual([]);
  });

  it('multiple gaps with multiple resolutions (complex linkage)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_gap_1',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_1',
          severity: 'critical',
          reason: { category: 'user_only_dependency', detail: 'needs_user_approval' },
          summary: 'Gap 1',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_2',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_2',
          severity: 'warning',
          reason: { category: 'capability_missing', detail: 'required_capability_unavailable' },
          summary: 'Gap 2',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_3',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_3',
        scope: { runId: 'run_1', nodeId: 'node_2' },
        data: {
          gapId: 'gap_3',
          severity: 'info',
          reason: { category: 'unexpected', detail: 'invariant_violation' },
          summary: 'Resolves gap 1',
          resolution: { kind: 'resolves', resolvesGapId: 'gap_1' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_4',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_4',
        scope: { runId: 'run_1', nodeId: 'node_2' },
        data: {
          gapId: 'gap_4',
          severity: 'info',
          reason: { category: 'unexpected', detail: 'invariant_violation' },
          summary: 'Resolves gap 2',
          resolution: { kind: 'resolves', resolvesGapId: 'gap_2' },
        },
      },
    ];

    const res = projectGapsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    
    expect(projected.resolvedGapIds.has('gap_1')).toBe(true);
    expect(projected.resolvedGapIds.has('gap_2')).toBe(true);
    expect(projected.resolvedGapIds.size).toBe(2);
    
    expect(Object.keys(projected.byGapId).sort()).toEqual(['gap_1', 'gap_2', 'gap_3', 'gap_4']);
    expect(projected.unresolvedCriticalByRunId['run_1'] ?? []).toEqual([]);
  });

  it('unresolved critical gaps are included in unresolvedCriticalByRunId', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_gap_1',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_1',
          severity: 'critical',
          reason: { category: 'contract_violation', detail: 'missing_required_output' },
          summary: 'Critical gap 1',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_2',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_2',
          severity: 'warning',
          reason: { category: 'capability_missing', detail: 'required_capability_unknown' },
          summary: 'Warning gap',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_3',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_3',
        scope: { runId: 'run_2', nodeId: 'node_3' },
        data: {
          gapId: 'gap_3',
          severity: 'critical',
          reason: { category: 'user_only_dependency', detail: 'needs_user_secret_or_token' },
          summary: 'Critical gap 2',
          resolution: { kind: 'unresolved' },
        },
      },
    ];

    const res = projectGapsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    
    const run1Critical = projected.unresolvedCriticalByRunId['run_1'] ?? [];
    expect(run1Critical.length).toBe(1);
    expect(run1Critical[0]!.gapId).toBe('gap_1');
    
    const run2Critical = projected.unresolvedCriticalByRunId['run_2'] ?? [];
    expect(run2Critical.length).toBe(1);
    expect(run2Critical[0]!.gapId).toBe('gap_3');
  });

  it('gap ordering by eventIndex then gapId (deterministic)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_gap_b',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_b',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_b',
          severity: 'critical',
          reason: { category: 'capability_missing', detail: 'required_capability_unavailable' },
          summary: 'Gap B',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_a',
        eventIndex: 5,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_a',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_a',
          severity: 'critical',
          reason: { category: 'contract_violation', detail: 'missing_required_output' },
          summary: 'Gap A',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_z',
        eventIndex: 6,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_z',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_z',
          severity: 'critical',
          reason: { category: 'contract_violation', detail: 'invalid_required_output' },
          summary: 'Gap Z',
          resolution: { kind: 'unresolved' },
        },
      },
    ];

    const res = projectGapsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    
    const criticalGaps = projected.unresolvedCriticalByRunId['run_1'] ?? [];
    expect(criticalGaps.length).toBe(3);
    
    expect(criticalGaps[0]!.gapId).toBe('gap_b');
    expect(criticalGaps[1]!.gapId).toBe('gap_a');
    expect(criticalGaps[2]!.gapId).toBe('gap_z');
  });

  it('resolution of non-existent gap is handled gracefully', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_gap_resolution',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_resolution',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_resolution',
          severity: 'info',
          reason: { category: 'unexpected', detail: 'invariant_violation' },
          summary: 'Resolves non-existent gap',
          resolution: { kind: 'resolves', resolvesGapId: 'gap_does_not_exist' },
        },
      },
    ];

    const res = projectGapsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    
    expect(projected.resolvedGapIds.has('gap_does_not_exist')).toBe(true);
    expect(Object.keys(projected.byGapId)).toEqual(['gap_resolution']);
  });

  it('rejects out-of-order events', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_gap_2',
        eventIndex: 5,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_2',
          severity: 'critical',
          reason: { category: 'contract_violation', detail: 'missing_required_output' },
          summary: 'Gap 2',
          resolution: { kind: 'unresolved' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_1',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          gapId: 'gap_1',
          severity: 'critical',
          reason: { category: 'user_only_dependency', detail: 'needs_user_approval' },
          summary: 'Gap 1',
          resolution: { kind: 'unresolved' },
        },
      },
    ];

    const res = projectGapsV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_INVARIANT_VIOLATION');
    expect(res._unsafeUnwrapErr().message).toContain('sorted by eventIndex');
  });
});
