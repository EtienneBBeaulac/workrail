import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';

export type ProjectionError =
  | { readonly code: 'PROJECTION_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'PROJECTION_CORRUPTION_DETECTED'; readonly message: string };

type GapRecordedEventV1 = Extract<DomainEventV1, { kind: 'gap_recorded' }>;

export interface GapV2 {
  readonly gapId: string;
  readonly severity: GapRecordedEventV1['data']['severity'];
  readonly reason: GapRecordedEventV1['data']['reason'];
  readonly summary: string;
  readonly recordedAtEventIndex: number;
  readonly nodeId: string;
  readonly runId: string;
  readonly resolution: GapRecordedEventV1['data']['resolution'];
}

export interface GapsProjectionV2 {
  readonly byGapId: Readonly<Record<string, GapV2>>;
  readonly resolvedGapIds: ReadonlySet<string>;
  readonly unresolvedCriticalByRunId: Readonly<Record<string, readonly GapV2[]>>;
}

/**
 * Pure projection: derive unresolved gaps and unresolved critical gaps per run.
 *
 * Locks:
 * - gaps are immutable; resolution is linkage (resolvesGapId)
 * - "resolved" is derived by later linkage (projection)
 */
export function projectGapsV2(events: readonly DomainEventV1[]): Result<GapsProjectionV2, ProjectionError> {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({ code: 'PROJECTION_INVARIANT_VIOLATION', message: 'Events must be sorted by eventIndex ascending' });
    }
  }

  const byGapId: Record<string, GapV2> = {};
  const resolved = new Set<string>();

  for (const e of events) {
    if (e.kind !== 'gap_recorded') continue;

    const gap: GapV2 = {
      gapId: e.data.gapId,
      severity: e.data.severity,
      reason: e.data.reason,
      summary: e.data.summary,
      recordedAtEventIndex: e.eventIndex,
      nodeId: e.scope.nodeId,
      runId: e.scope.runId,
      resolution: e.data.resolution,
    };

    // Latest record for a gapId wins (append-only history; projection uses last by eventIndex).
    byGapId[gap.gapId] = gap;

    if (gap.resolution.kind === 'resolves') {
      resolved.add(gap.resolution.resolvesGapId);
    }
  }

  const unresolvedCriticalByRunId: Record<string, GapV2[]> = {};
  for (const gap of Object.values(byGapId)) {
    if (resolved.has(gap.gapId)) continue;
    if (gap.resolution.kind !== 'unresolved') continue;
    if (gap.severity !== 'critical') continue;

    const list = unresolvedCriticalByRunId[gap.runId] ?? [];
    list.push(gap);
    unresolvedCriticalByRunId[gap.runId] = list;
  }

  // Deterministic ordering by event index, then gapId.
  for (const runId of Object.keys(unresolvedCriticalByRunId)) {
    unresolvedCriticalByRunId[runId] = unresolvedCriticalByRunId[runId]!
      .slice()
      .sort((a, b) => a.recordedAtEventIndex - b.recordedAtEventIndex || a.gapId.localeCompare(b.gapId));
  }

  return ok({ byGapId, resolvedGapIds: resolved, unresolvedCriticalByRunId });
}
