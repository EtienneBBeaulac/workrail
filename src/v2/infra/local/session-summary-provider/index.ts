import type { ResultAsync } from 'neverthrow';
import { okAsync } from 'neverthrow';
import type { DirectoryListingPortV2 } from '../../../ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../../ports/session-event-log-store.port.js';
import type { SessionSummaryProviderPortV2, SessionSummaryError } from '../../../ports/session-summary-provider.port.js';
import type { HealthySessionSummary, SessionObservations, WorkflowIdentity, RecapSnippet } from '../../../projections/resume-ranking.js';
import { asRecapSnippet } from '../../../projections/resume-ranking.js';
import type { RunDagRunV2, RunDagNodeV2 } from '../../../projections/run-dag.js';
import { enumerateSessions } from '../../../usecases/enumerate-sessions.js';
import { projectSessionHealthV2 } from '../../../projections/session-health.js';
import { projectRunDagV2 } from '../../../projections/run-dag.js';
import { projectNodeOutputsV2, type NodeOutputsProjectionV2 } from '../../../projections/node-outputs.js';
import type { DomainEventV1 } from '../../../durable-core/schemas/session/index.js';
import type { SessionId } from '../../../durable-core/ids/index.js';
import { EVENT_KIND } from '../../../durable-core/constants.js';

/**
 * Max sessions to scan (explicit bound to prevent unbounded enumeration).
 * Locked: prevents runaway scanning on large workspaces.
 */
const MAX_SESSIONS_TO_SCAN = 50;

/**
 * Ports required by the session summary provider.
 */
export interface LocalSessionSummaryProviderPorts {
  readonly directoryListing: DirectoryListingPortV2;
  readonly dataDir: DataDirPortV2;
  readonly sessionStore: SessionEventLogReadonlyStorePortV2;
}

/**
 * Local session summary provider.
 *
 * Enumerates sessions from disk, loads + health-checks + projects each one,
 * and returns only healthy sessions with projectable runs.
 *
 * Individual session failures are skipped gracefully (graceful degradation).
 */
export class LocalSessionSummaryProviderV2 implements SessionSummaryProviderPortV2 {
  private readonly ports: LocalSessionSummaryProviderPorts;

  constructor(ports: LocalSessionSummaryProviderPorts) {
    this.ports = ports;
  }

  loadHealthySummaries(): ResultAsync<readonly HealthySessionSummary[], SessionSummaryError> {
    return enumerateSessions({
      directoryListing: this.ports.directoryListing,
      dataDir: this.ports.dataDir,
    })
      .mapErr((fsErr): SessionSummaryError => ({
        code: 'SESSION_SUMMARY_ENUMERATION_FAILED',
        message: `Failed to enumerate sessions: ${fsErr.message}`,
      }))
      .andThen((sessionIds) => {
        // Cap at MAX_SESSIONS_TO_SCAN
        const capped = sessionIds.slice(0, MAX_SESSIONS_TO_SCAN);
        return this.collectHealthySummaries(capped);
      });
  }

  /**
   * Collect healthy summaries from session IDs, skipping failures gracefully.
   */
  private collectHealthySummaries(
    sessionIds: readonly SessionId[],
  ): ResultAsync<readonly HealthySessionSummary[], SessionSummaryError> {
    const summaries: HealthySessionSummary[] = [];

    let chain: ResultAsync<void, SessionSummaryError> = okAsync(undefined);

    for (const sessionId of sessionIds) {
      chain = chain.andThen(() =>
        this.tryLoadSummary(sessionId).map((summary) => {
          if (summary !== null) {
            summaries.push(summary);
          }
        })
      );
    }

    return chain.map(() => summaries);
  }

  /**
   * Try to load a single session summary. Returns null on any failure (graceful skip).
   */
  private tryLoadSummary(sessionId: SessionId): ResultAsync<HealthySessionSummary | null, never> {
    return this.ports.sessionStore
      .load(sessionId)
      .map((truth) => {
        // Health check — skip unhealthy sessions
        const healthRes = projectSessionHealthV2(truth);
        if (healthRes.isErr()) return null;
        if (healthRes.value.kind !== 'healthy') return null;

        // Project run DAG
        const dagRes = projectRunDagV2(truth.events);
        if (dagRes.isErr()) return null;

        // Find the most recent run with a preferred tip
        const runs = Object.values(dagRes.value.runsById);
        if (runs.length === 0) return null;

        // Sort runs by latest activity (highest createdAtEventIndex in their tip nodes)
        const runsWithActivity = runs
          .filter((r) => r.preferredTipNodeId !== null)
          .map((r) => {
            const tipNode = r.nodesById[r.preferredTipNodeId!];
            const maxEventIndex = tipNode ? tipNode.createdAtEventIndex : 0;
            return { run: r, lastActivityEventIndex: maxEventIndex };
          })
          .sort((a, b) => b.lastActivityEventIndex - a.lastActivityEventIndex);

        if (runsWithActivity.length === 0) return null;

        const bestRun = runsWithActivity[0]!;
        const run = bestRun.run;

        // Project node outputs for recap.
        // Walk ancestors from tip so completed-but-not-yet-advanced steps are searchable.
        const outputsRes = projectNodeOutputsV2(truth.events);
        const recapSnippet = outputsRes.isOk() && run.preferredTipNodeId
          ? extractAggregateRecap(outputsRes.value, run, run.preferredTipNodeId)
          : null;

        // Extract observations from events
        const observations = extractObservations(truth.events);

        // Extract workflow identity
        const workflow = extractWorkflowIdentity(truth.events, run.runId);

        return {
          sessionId,
          runId: run.runId,
          preferredTip: {
            nodeId: run.preferredTipNodeId!,
            lastActivityEventIndex: bestRun.lastActivityEventIndex,
          },
          recapSnippet,
          observations,
          workflow,
        } satisfies HealthySessionSummary;
      })
      .orElse(() => okAsync(null)); // Graceful skip on store errors
  }
}

// ---------------------------------------------------------------------------
// Pure extraction helpers
// ---------------------------------------------------------------------------

/**
 * Max ancestor depth for recap aggregation.
 *
 * Locked: WorkRail workflows are bounded by their step count; no real workflow
 * approaches 100 steps. This cap prevents pathological traversal if the DAG
 * ever has a corrupt parent chain (defensive, not a workflow design limit).
 */
const MAX_RECAP_ANCESTOR_DEPTH = 100;

/**
 * Collect ancestor nodeIds from tip to root, depth-first, newest-first.
 * Pure recursive unfold — no mutable state.
 */
function collectAncestorNodeIds(
  nodesById: Readonly<Record<string, RunDagNodeV2>>,
  nodeId: string,
  remainingDepth: number,
): readonly string[] {
  if (remainingDepth === 0) return [nodeId];
  const node = nodesById[nodeId];
  if (!node) return [nodeId];
  const parentIds = node.parentNodeId
    ? collectAncestorNodeIds(nodesById, node.parentNodeId, remainingDepth - 1)
    : [];
  return [nodeId, ...parentIds];
}

/**
 * Extract a single node's current recap markdown (null if none).
 */
function extractNodeRecapMarkdown(
  outputs: NodeOutputsProjectionV2,
  nodeId: string,
): string | null {
  const nodeView = outputs.nodesById[nodeId];
  if (!nodeView) return null;

  const recapOutputs = nodeView.currentByChannel['recap'];
  if (!recapOutputs || recapOutputs.length === 0) return null;

  const latest = recapOutputs[recapOutputs.length - 1]!;
  if (latest.payload.payloadKind !== 'notes') return null;

  const markdown = (latest.payload as { readonly payloadKind: 'notes'; readonly notesMarkdown: string }).notesMarkdown;
  return (markdown && typeof markdown === 'string') ? markdown : null;
}

/**
 * Build an aggregate recap snippet by collecting recap outputs from the tip
 * back through all ancestor nodes (newest to oldest).
 *
 * This ensures sessions are searchable by completed work even when the current
 * pending step (the tip) has no output yet — the typical state of an in-progress
 * session paused between steps.
 *
 * Pipeline: unfold ancestor nodeIds → map to markdown → filter nulls → join → brand.
 */
function extractAggregateRecap(
  outputs: NodeOutputsProjectionV2,
  run: RunDagRunV2,
  tipNodeId: string,
): RecapSnippet | null {
  const parts = collectAncestorNodeIds(run.nodesById, tipNodeId, MAX_RECAP_ANCESTOR_DEPTH)
    .map((nodeId) => extractNodeRecapMarkdown(outputs, nodeId))
    .filter((md): md is string => md !== null);

  if (parts.length === 0) return null;

  // Join newest-to-oldest; asRecapSnippet truncates to MAX_SNIPPET_BYTES
  return asRecapSnippet(parts.join('\n\n'));
}

/**
 * Extract the latest workspace observations from session events.
 * Scans all observation_recorded events and takes the latest value for each key.
 */
function extractObservations(events: readonly DomainEventV1[]): SessionObservations {
  let gitHeadSha: string | null = null;
  let gitBranch: string | null = null;
  let repoRootHash: string | null = null;

  for (const event of events) {
    if (event.kind !== EVENT_KIND.OBSERVATION_RECORDED) continue;

    const data = event.data as {
      readonly key: string;
      readonly value: { readonly type: string; readonly value: string };
    };

    switch (data.key) {
      case 'git_head_sha':
        gitHeadSha = data.value.value;
        break;
      case 'git_branch':
        gitBranch = data.value.value;
        break;
      case 'repo_root_hash':
        repoRootHash = data.value.value;
        break;
      default:
        // Exhaustiveness: all observation keys handled above
        break;
    }
  }

  return { gitHeadSha, gitBranch, repoRootHash };
}

/**
 * Extract workflow identity from run_started events for a specific run.
 */
function extractWorkflowIdentity(events: readonly DomainEventV1[], runId: string): WorkflowIdentity {
  for (const event of events) {
    if (event.kind !== EVENT_KIND.RUN_STARTED) continue;
    const scope = event.scope as { readonly runId?: string } | undefined;
    if (scope?.runId !== runId) continue;

    const data = event.data as { readonly workflowId?: string };
    return {
      workflowId: data.workflowId ?? null,
      workflowName: null, // Not in events; resolve from pinned workflow store later
    };
  }

  return { workflowId: null, workflowName: null };
}
