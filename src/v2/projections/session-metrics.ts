import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND, VALID_METRICS_OUTCOME } from '../durable-core/constants.js';
import type { MetricsOutcome } from '../durable-core/constants.js';

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
  readonly captureConfidence: 'high' | 'none';
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
  let runCompleted: Extract<DomainEventV1, { kind: 'run_completed' }> | null = null;

  for (const e of events) {
    if (e.kind === 'run_completed') {
      runCompleted = e;
      break; // first run_completed by event order wins
    }
  }

  if (runCompleted === null) {
    return null;
  }

  const runCompletedRunId = runCompleted.scope.runId;

  // Collect the last context_set metrics_* values for the matching runId.
  // Each context_set is a full snapshot, not a delta -- the last event for a
  // runId holds the complete accumulated context including metrics keys.
  const metricsContext: Record<string, unknown> = {};

  for (const e of events) {
    if (e.kind !== EVENT_KIND.CONTEXT_SET) continue;
    if (e.scope?.runId !== runCompletedRunId) continue;

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

  // Extract engine fields from run_completed.data -- fully typed via DomainEventV1Schema.
  const d = runCompleted.data;

  // Coerce nullable string fields to null when absent -- defensive against schema-bypassing
  // casts (e.g. test fixtures using `as unknown as DomainEventV1`).
  const startGitSha = typeof d.startGitSha === 'string' ? d.startGitSha : null;
  const endGitSha = typeof d.endGitSha === 'string' ? d.endGitSha : null;
  const gitBranch = typeof d.gitBranch === 'string' ? d.gitBranch : null;
  const agentCommitShas = Array.isArray(d.agentCommitShas)
    ? d.agentCommitShas.filter((s): s is string => typeof s === 'string')
    : [];
  const durationMs =
    typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) ? d.durationMs : undefined;

  const captureConfidence: 'high' | 'none' =
    d.captureConfidence === 'high' ? 'high' : 'none';

  // Extract agent-reported fields from metricsContext.
  // WHY: VALID_METRICS_OUTCOME is the single source of truth for the enum.
  // checkContextBudget validates against it at the tool boundary; this projection
  // still coerces invalid values to null as defense-in-depth for events already
  // stored before the validation check was added.
  const outcomeRaw = metricsContext['metrics_outcome'];
  const outcome: MetricsOutcome | null =
    (VALID_METRICS_OUTCOME as readonly unknown[]).includes(outcomeRaw)
      ? (outcomeRaw as MetricsOutcome)
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

  // Use agent-reported metrics_commit_shas as override when present;
  // otherwise fall back to what run_completed.data.agentCommitShas provided.
  const commitShasRaw = metricsContext['metrics_commit_shas'];
  const metricCommitShas: string[] = [];
  if (Array.isArray(commitShasRaw)) {
    for (const sha of commitShasRaw) {
      if (typeof sha === 'string') metricCommitShas.push(sha);
    }
  }
  const finalAgentCommitShas = metricCommitShas.length > 0 ? metricCommitShas : agentCommitShas;

  const filesChangedRaw = metricsContext['metrics_files_changed'];
  const filesChanged =
    typeof filesChangedRaw === 'number' && Number.isFinite(filesChangedRaw) ? filesChangedRaw : null;

  const linesAddedRaw = metricsContext['metrics_lines_added'];
  const linesAdded =
    typeof linesAddedRaw === 'number' && Number.isFinite(linesAddedRaw) ? linesAddedRaw : null;

  const linesRemovedRaw = metricsContext['metrics_lines_removed'];
  const linesRemoved =
    typeof linesRemovedRaw === 'number' && Number.isFinite(linesRemovedRaw) ? linesRemovedRaw : null;

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
