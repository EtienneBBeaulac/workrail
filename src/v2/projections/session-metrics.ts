import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND, VALID_METRICS_OUTCOME } from '../durable-core/constants.js';
import type { MetricsOutcome } from '../durable-core/constants.js';
import type { ClientUsage, TokenSnapshot } from '../durable-core/schemas/session/usage.js';
import type { GitEvidence } from '../durable-core/schemas/session/git-evidence.js';

export type { GitEvidence, GitCommittedDiff, GitWorkingTreeState } from '../durable-core/schemas/session/git-evidence.js';

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
  /**
   * Confidence that git capture succeeded for this session run.
   * Populated from run_completed; supports 'high' and 'none' only.
   * For three-level confidence ('high' | 'partial' | 'none') and authoritative
   * engine-side git evidence, prefer gitEvidence.captureConfidence.
   */
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
  /**
   * Token usage per MCP client, derived from usage_recorded events.
   *
   * Empty array when no usage was recorded (e.g. session completed before the
   * ClientUsageReader pipeline was deployed, or no client log was found).
   * One element per client that reported usage (typically just claude-code).
   */
  readonly usageEvents: readonly ClientUsage[];
  /**
   * Token delta for this workflow run: end snapshot minus start snapshot.
   *
   * null when either token_checkpoint event is absent (pre-feature sessions,
   * or sessions where the JSONL snapshot failed). Non-null means both
   * checkpoints were written and the delta is computable.
   */
  readonly tokenDelta: TokenSnapshot | null;
  /**
   * Authoritative engine-side git diff evidence for this session.
   *
   * Populated from the `git_metrics_recorded` event when present.
   * null when that event is absent (session predates the feature, session
   * is still in progress, or the fire-and-forget recording failed silently).
   *
   * Prefer this field over the legacy startGitSha/endGitSha/agentCommitShas
   * fields, which are populated from run_completed and have known accuracy issues.
   */
  readonly gitEvidence: GitEvidence | null;
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

  // Precedence for commit SHAs (highest to lowest):
  // 1. delivery_recorded event shas -- authoritative; derived from git commit output by delivery pipeline
  // 2. metrics_commit_shas context_set key -- agent-reported (deprecated; kept for old sessions)
  // 3. agentCommitShas from run_completed -- always empty since PR #903; kept for projection completeness
  let deliveryShas: string[] = [];
  for (const e of events) {
    if (e.kind !== EVENT_KIND.DELIVERY_RECORDED) continue;
    if (e.scope?.runId !== runCompletedRunId) continue;
    const shasRaw = e.data.shas;
    if (Array.isArray(shasRaw)) {
      deliveryShas = shasRaw.filter((s): s is string => typeof s === 'string');
    }
    break; // first delivery_recorded by event order wins
  }

  const commitShasRaw = metricsContext['metrics_commit_shas'];
  const metricCommitShas: string[] = [];
  if (Array.isArray(commitShasRaw)) {
    for (const sha of commitShasRaw) {
      if (typeof sha === 'string') metricCommitShas.push(sha);
    }
  }
  const finalAgentCommitShas =
    deliveryShas.length > 0 ? deliveryShas :
    metricCommitShas.length > 0 ? metricCommitShas :
    agentCommitShas;

  const filesChangedRaw = metricsContext['metrics_files_changed'];
  const filesChanged =
    typeof filesChangedRaw === 'number' && Number.isFinite(filesChangedRaw) ? filesChangedRaw : null;

  const linesAddedRaw = metricsContext['metrics_lines_added'];
  const linesAdded =
    typeof linesAddedRaw === 'number' && Number.isFinite(linesAddedRaw) ? linesAddedRaw : null;

  const linesRemovedRaw = metricsContext['metrics_lines_removed'];
  const linesRemoved =
    typeof linesRemovedRaw === 'number' && Number.isFinite(linesRemovedRaw) ? linesRemovedRaw : null;

  // If delivery_recorded provides SHAs, upgrade captureConfidence to 'high'
  // regardless of what run_completed reported.
  const finalCaptureConfidence: 'high' | 'none' =
    deliveryShas.length > 0 ? 'high' : captureConfidence;

  // Collect usage_recorded events for the matching runId.
  // One element per client that reported usage. Order follows event log order.
  const usageEvents: ClientUsage[] = [];
  for (const e of events) {
    if (e.kind !== EVENT_KIND.USAGE_RECORDED) continue;
    if (e.scope?.runId !== runCompletedRunId) continue;
    const d = e.data;
    usageEvents.push({
      client: typeof d.client === 'string' ? d.client : '',
      model: typeof d.model === 'string' ? d.model : null,
      inputTokens: typeof d.inputTokens === 'number' ? d.inputTokens : 0,
      outputTokens: typeof d.outputTokens === 'number' ? d.outputTokens : 0,
      cacheReadTokens: typeof d.cacheReadTokens === 'number' ? d.cacheReadTokens : 0,
      cacheWriteTokens: typeof d.cacheWriteTokens === 'number' ? d.cacheWriteTokens : 0,
      turns: typeof d.turns === 'number' ? d.turns : 0,
    });
  }

  // Compute token delta from token_checkpoint events (start and end).
  // null when either checkpoint is absent (pre-feature sessions or failed JSONL scan).
  let startCheckpoint: TokenSnapshot | null = null;
  let endCheckpoint: TokenSnapshot | null = null;
  for (const e of events) {
    if (e.kind !== EVENT_KIND.TOKEN_CHECKPOINT) continue;
    if (e.scope?.runId !== runCompletedRunId) continue;
    const d = e.data;
    const snap: TokenSnapshot = {
      inputTokens: typeof d.inputTokens === 'number' ? d.inputTokens : 0,
      outputTokens: typeof d.outputTokens === 'number' ? d.outputTokens : 0,
      cacheReadTokens: typeof d.cacheReadTokens === 'number' ? d.cacheReadTokens : 0,
      cacheWriteTokens: typeof d.cacheWriteTokens === 'number' ? d.cacheWriteTokens : 0,
      turns: typeof d.turns === 'number' ? d.turns : 0,
    };
    if (d.phase === 'start' && !startCheckpoint) startCheckpoint = snap;
    if (d.phase === 'end' && !endCheckpoint) endCheckpoint = snap;
  }

  const tokenDelta: TokenSnapshot | null =
    startCheckpoint && endCheckpoint
      ? {
          inputTokens: Math.max(0, endCheckpoint.inputTokens - startCheckpoint.inputTokens),
          outputTokens: Math.max(0, endCheckpoint.outputTokens - startCheckpoint.outputTokens),
          cacheReadTokens: Math.max(0, endCheckpoint.cacheReadTokens - startCheckpoint.cacheReadTokens),
          cacheWriteTokens: Math.max(0, endCheckpoint.cacheWriteTokens - startCheckpoint.cacheWriteTokens),
          turns: Math.max(0, endCheckpoint.turns - startCheckpoint.turns),
        }
      : null;

  // Project gitEvidence from git_metrics_recorded event (if present).
  // Backward compat: null for sessions that predate the git_metrics feature.
  let gitEvidence: GitEvidence | null = null;
  for (const e of events) {
    if (e.kind !== EVENT_KIND.GIT_METRICS_RECORDED) continue;
    if (e.scope?.runId !== runCompletedRunId) continue;
    const gd = e.data;
    const committedDiff =
      gd.filesChanged !== null && gd.linesAdded !== null && gd.linesRemoved !== null
        ? {
            filesChanged: gd.filesChanged,
            linesAdded: gd.linesAdded,
            linesRemoved: gd.linesRemoved,
            truncated: gd.truncated,
          }
        : null;
    const workingTree =
      gd.stagedFiles !== null && gd.unstagedFiles !== null
        ? {
            stagedFiles: gd.stagedFiles,
            unstagedFiles: gd.unstagedFiles,
          }
        : null;
    gitEvidence = {
      startSha: typeof gd.startSha === 'string' ? gd.startSha : null,
      endSha: typeof gd.endSha === 'string' ? gd.endSha : null,
      commitShas: Array.isArray(gd.commitShas)
        ? gd.commitShas.filter((s): s is string => typeof s === 'string')
        : [],
      prRefs: Array.isArray(gd.prRefs)
        ? gd.prRefs.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : [],
      committedDiff,
      workingTree,
      captureConfidence: gd.captureConfidence,
    };
    break; // first git_metrics_recorded by event order wins
  }

  return {
    startGitSha,
    endGitSha,
    gitBranch,
    agentCommitShas: finalAgentCommitShas,
    captureConfidence: finalCaptureConfidence,
    durationMs,
    outcome,
    prNumbers,
    filesChanged,
    linesAdded,
    linesRemoved,
    usageEvents,
    tokenDelta,
    gitEvidence,
  };
}
