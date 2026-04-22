import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured outcome data for a completed session run.
 *
 * Engine fields come from the `run_completed` event's data payload and are
 * authoritative -- they cannot be overridden by agent self-report.
 *
 * Agent-reported fields come from the last `context_set` event that sets
 * each corresponding `metrics_*` key. Each is independently null when the
 * agent did not set it.
 *
 * See: docs/ideas/backlog.md -- metrics sequence step 4
 */
export interface SessionMetricsV2 {
  // From run_completed event (engine-authoritative)
  readonly startGitSha: string | null;
  readonly endGitSha: string | null;
  readonly gitBranch: string | null;
  readonly agentCommitShas: readonly string[];
  readonly captureConfidence: 'high' | 'medium' | 'none';
  /**
   * Wall-clock duration of the run in milliseconds.
   * undefined (not null) when either timestamp is unavailable -- consistent
   * with the TypeScript convention for a field that cannot be computed.
   */
  readonly durationMs: number | undefined;
  // From context_set metrics_* keys (agent-reported, each independently nullable)
  readonly outcome: 'success' | 'partial' | 'abandoned' | 'error' | null;
  readonly prNumbers: readonly number[];
  readonly filesChanged: number | null;
  readonly linesAdded: number | null;
  readonly linesRemoved: number | null;
}

// ---------------------------------------------------------------------------
// Internal defensive cast interface
// ---------------------------------------------------------------------------

/**
 * Internal contract for run_completed.data fields.
 *
 * STEP 2 CLEANUP: when run_completed is added to DomainEventV1Schema,
 * replace the defensive cast below with proper TS type narrowing and delete
 * this interface. The cleanup is a single localized change -- replace the cast,
 * verify these 6 field names match: startGitSha, endGitSha, gitBranch,
 * agentCommitShas, captureConfidence, durationMs. No other changes.
 */
interface RunCompletedDataExpected {
  readonly startGitSha?: unknown;
  readonly endGitSha?: unknown;
  readonly gitBranch?: unknown;
  readonly agentCommitShas?: unknown;
  readonly captureConfidence?: unknown;
  readonly durationMs?: unknown;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Pure projection: derives a `SessionMetricsV2` object from a session's
 * event log by reading `run_completed` and `context_set metrics_*` events.
 *
 * Returns null if no `run_completed` event is present (sessions in progress
 * and pre-migration sessions that predate the run_completed feature).
 *
 * Input pattern: `readonly DomainEventV1[]` (consistent with `artifacts.ts`).
 * Return type: `SessionMetricsV2 | null` (not Result -- absence is valid).
 *
 * Lock: engine fields are authoritative; agent context_set cannot override them.
 * Lock: for multi-run sessions, the first run_completed event by event order wins.
 * Lock: metrics_commit_shas uses the last context_set with that key (full accumulated list).
 */
export function projectSessionMetricsV2(
  events: readonly DomainEventV1[],
): SessionMetricsV2 | null {
  // Find the first run_completed event by event order.
  // run_completed is not yet in DomainEventV1Schema (step 2), so we use a
  // defensive cast via RunCompletedDataExpected.
  let runCompletedData: RunCompletedDataExpected | null = null;
  let runCompletedRunId: string | null = null;

  for (const e of events) {
    // run_completed is not yet in DomainEventV1Schema (step 2 adds it).
    // Cast to unknown first to bypass the discriminated union exhaustiveness check.
    const asUnknown = e as unknown as { kind: string; data: RunCompletedDataExpected; scope?: { runId?: string } };
    if (asUnknown.kind === 'run_completed') {
      runCompletedData = asUnknown.data;
      // run_completed follows the same scope pattern as run_started: { runId }
      runCompletedRunId = asUnknown.scope?.runId ?? null;
      break; // first run_completed by event order wins
    }
  }

  if (runCompletedData === null) {
    return null;
  }

  // Collect the last context_set metrics_* values for the matching runId.
  // Each context_set is a full snapshot, not a delta -- the last event for a
  // runId holds the complete accumulated context including metrics keys.
  const metricsContext: Record<string, unknown> = {};

  for (const e of events) {
    if (e.kind !== EVENT_KIND.CONTEXT_SET) continue;
    // Only process context_set events for the run that completed.
    // WHY null check: if run_completed had no scope.runId, disable the filter so
    // all context_set events contribute. context_set enforces non-empty runId in schema
    // so this path only occurs with legacy or manually-constructed events.
    if (runCompletedRunId !== null && e.scope?.runId !== runCompletedRunId) continue;

    const ctx = e.data.context;
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) continue;

    // Collect all metrics_* keys from this snapshot (last wins).
    const ctxObj = ctx as Record<string, unknown>;
    for (const [key, value] of Object.entries(ctxObj)) {
      if (key.startsWith('metrics_')) {
        metricsContext[key] = value;
      }
    }
  }

  // Extract engine fields from run_completed.data.
  const d = runCompletedData;

  const startGitSha = typeof d.startGitSha === 'string' ? d.startGitSha : null;
  const endGitSha = typeof d.endGitSha === 'string' ? d.endGitSha : null;
  const gitBranch = typeof d.gitBranch === 'string' ? d.gitBranch : null;

  const agentCommitShas: string[] = [];
  if (Array.isArray(d.agentCommitShas)) {
    for (const sha of d.agentCommitShas) {
      if (typeof sha === 'string') {
        agentCommitShas.push(sha);
      }
    }
  }

  const captureConfidenceRaw = d.captureConfidence;
  const captureConfidence: 'high' | 'medium' | 'none' =
    captureConfidenceRaw === 'high' || captureConfidenceRaw === 'medium' || captureConfidenceRaw === 'none'
      ? captureConfidenceRaw
      : 'none';

  const durationMs =
    typeof d.durationMs === 'number' && Number.isFinite(d.durationMs)
      ? d.durationMs
      : undefined;

  // Extract agent-reported fields from metricsContext.
  const outcomeRaw = metricsContext['metrics_outcome'];
  const outcome: 'success' | 'partial' | 'abandoned' | 'error' | null =
    outcomeRaw === 'success' || outcomeRaw === 'partial' || outcomeRaw === 'abandoned' || outcomeRaw === 'error'
      ? outcomeRaw
      : null;

  const prNumbers: number[] = [];
  const prNumbersRaw = metricsContext['metrics_pr_numbers'];
  if (Array.isArray(prNumbersRaw)) {
    for (const n of prNumbersRaw) {
      if (typeof n === 'number' && Number.isFinite(n)) {
        prNumbers.push(n);
      }
    }
  }

  const commitShasRaw = metricsContext['metrics_commit_shas'];
  const metricCommitShas: string[] = [];
  if (Array.isArray(commitShasRaw)) {
    for (const sha of commitShasRaw) {
      if (typeof sha === 'string') {
        metricCommitShas.push(sha);
      }
    }
  }
  // Use agent-reported commit shas (metrics_commit_shas) as agentCommitShas override
  // when present; otherwise fall back to what run_completed.data.agentCommitShas provided.
  const finalAgentCommitShas = metricCommitShas.length > 0 ? metricCommitShas : agentCommitShas;

  const filesChangedRaw = metricsContext['metrics_files_changed'];
  const filesChanged =
    typeof filesChangedRaw === 'number' && Number.isFinite(filesChangedRaw)
      ? filesChangedRaw
      : null;

  const linesAddedRaw = metricsContext['metrics_lines_added'];
  const linesAdded =
    typeof linesAddedRaw === 'number' && Number.isFinite(linesAddedRaw)
      ? linesAddedRaw
      : null;

  const linesRemovedRaw = metricsContext['metrics_lines_removed'];
  const linesRemoved =
    typeof linesRemovedRaw === 'number' && Number.isFinite(linesRemovedRaw)
      ? linesRemovedRaw
      : null;

  return {
    startGitSha,
    endGitSha,
    gitBranch,
    agentCommitShas: finalAgentCommitShas,
    captureConfidence,
    durationMs,
    outcome,
    prNumbers,
    filesChanged,
    linesAdded,
    linesRemoved,
  };
}
