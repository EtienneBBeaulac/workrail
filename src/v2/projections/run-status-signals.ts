import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { projectRunDagV2 } from './run-dag.js';
import { projectGapsV2 } from './gaps.js';
import { projectAdvanceOutcomesV2 } from './advance-outcomes.js';

export type ProjectionError =
  | { readonly code: 'PROJECTION_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'PROJECTION_CORRUPTION_DETECTED'; readonly message: string };

export type AutonomyV2 = 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';
export type RiskPolicyV2 = 'conservative' | 'balanced' | 'aggressive';

export interface PreferencesSnapshotV2 {
  readonly autonomy: AutonomyV2;
  readonly riskPolicy: RiskPolicyV2;
}

export interface RunStatusSignalsV2 {
  readonly runId: string;
  readonly preferredTipNodeId: string | null;
  readonly effectivePreferencesAtTip: PreferencesSnapshotV2;
  readonly hasUnresolvedCriticalGaps: boolean;
  readonly isBlocked: boolean;
}

export interface RunStatusSignalsProjectionV2 {
  readonly byRunId: Readonly<Record<string, RunStatusSignalsV2>>;
}

/**
 * Pure projection: derive minimal run status signals needed for UI and future orchestration.
 *
 * Notes:
 * - Completion is not modeled yet (requires execution snapshots in Slice 3), so we only emit
 *   "blocked vs not blocked" plus gap signals.
 */
export function projectRunStatusSignalsV2(events: readonly DomainEventV1[]): Result<RunStatusSignalsProjectionV2, ProjectionError> {
  const dagRes = projectRunDagV2(events);
  if (dagRes.isErr()) return err(dagRes.error);
  const dag = dagRes.value;

  const gapsRes = projectGapsV2(events);
  if (gapsRes.isErr()) return err(gapsRes.error);
  const gaps = gapsRes.value;

  const advanceRes = projectAdvanceOutcomesV2(events);
  if (advanceRes.isErr()) return err(advanceRes.error);
  const advances = advanceRes.value;

  // Latest effective preferences per nodeId ("effective snapshot after applying delta").
  const prefsByNodeId: Record<string, PreferencesSnapshotV2> = {};
  for (const e of events) {
    if (e.kind !== 'preferences_changed') continue;
    prefsByNodeId[e.scope.nodeId] = e.data.effective;
  }

  const defaultPrefs: PreferencesSnapshotV2 = { autonomy: 'guided', riskPolicy: 'conservative' };

  const byRunId: Record<string, RunStatusSignalsV2> = {};
  for (const [runId, run] of Object.entries(dag.runsById)) {
    const tip = run.preferredTipNodeId;
    const prefs = tip ? prefsByNodeId[tip] ?? defaultPrefs : defaultPrefs;

    // Determine "has unresolved critical gaps" for this run.
    const critical = gaps.unresolvedCriticalByRunId[runId] ?? [];
    const hasUnresolvedCriticalGaps = critical.length > 0;

    // Blocked rule (locked intent):
    // - in never-stop, never blocked by gaps
    // - in blocking modes, blocked when there are unresolved critical gaps in certain categories
    const hasBlockingCategoryGap =
      (gaps.unresolvedCriticalByRunId[runId] ?? []).some((g) =>
        g.reason.category === 'user_only_dependency' ||
        g.reason.category === 'contract_violation' ||
        g.reason.category === 'capability_missing'
      );

    const latestAdvance = tip ? advances.byNodeId[tip] : undefined;
    const blockedByAdvance = latestAdvance?.outcome.kind === 'blocked';

    const isBlocked = prefs.autonomy !== 'full_auto_never_stop' && (blockedByAdvance || hasBlockingCategoryGap);

    byRunId[runId] = {
      runId,
      preferredTipNodeId: tip,
      effectivePreferencesAtTip: prefs,
      hasUnresolvedCriticalGaps,
      isBlocked,
    };
  }

  return ok({ byRunId });
}
