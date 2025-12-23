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
});
