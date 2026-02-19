import type { ResultAsync } from 'neverthrow';
import { okAsync } from 'neverthrow';
import type { DirectoryListingPortV2 } from '../../../ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2, LoadedSessionTruthV2 } from '../../../ports/session-event-log-store.port.js';
import type { SessionSummaryProviderPortV2, SessionSummaryError } from '../../../ports/session-summary-provider.port.js';
import type { HealthySessionSummary, SessionObservations, IdentifiedWorkflow, RecapSnippet } from '../../../projections/resume-ranking.js';
import { asRecapSnippet } from '../../../projections/resume-ranking.js';
import type { RunDagRunV2, RunDagNodeV2 } from '../../../projections/run-dag.js';
import { enumerateSessionsByRecency } from '../../../usecases/enumerate-sessions.js';
import { projectSessionHealthV2 } from '../../../projections/session-health.js';
import { projectRunDagV2 } from '../../../projections/run-dag.js';
import { projectNodeOutputsV2, type NodeOutputsProjectionV2 } from '../../../projections/node-outputs.js';
import type { DomainEventV1 } from '../../../durable-core/schemas/session/index.js';
import type { SessionId } from '../../../durable-core/ids/index.js';
import { asWorkflowId, asWorkflowHash, asSha256Digest } from '../../../durable-core/ids/index.js';
import { EVENT_KIND, OUTPUT_CHANNEL, PAYLOAD_KIND, SHA256_DIGEST_PATTERN } from '../../../durable-core/constants.js';

// ---------------------------------------------------------------------------
// Narrowed event types
//
// Why: DomainEventV1 is a discriminated union. Extracting named variants lets
// the type system enforce that downstream code only touches fields that exist
// on that specific variant — no `as` casts required.
// ---------------------------------------------------------------------------

/** A session event that recorded a workspace observation (git sha, branch, etc.). */
type ObservationEventV1 = Extract<DomainEventV1, { kind: 'observation_recorded' }>;

/** A session event that started a new workflow run. */
type RunStartedEventV1 = Extract<DomainEventV1, { kind: 'run_started' }>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * A run confirmed to have a non-null preferred tip.
 *
 * Why: RunDagRunV2.preferredTipNodeId is string | null, but once we select a
 * run for summarization we know the tip exists. Encoding that as a type
 * eliminates all downstream `!` assertions and makes the invariant explicit.
 */
interface RunWithTip {
  readonly run: RunDagRunV2;
  readonly tipNodeId: string;
  readonly lastActivityEventIndex: number;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Max sessions to scan (explicit bound to prevent unbounded enumeration).
 * Locked: prevents runaway scanning on large workspaces.
 */
const MAX_SESSIONS_TO_SCAN = 50;

/**
 * Max ancestor depth for recap aggregation.
 *
 * Locked: WorkRail workflows are bounded by their step count; no real workflow
 * approaches 100 steps. This cap prevents pathological traversal if the DAG
 * ever has a corrupt parent chain (defensive, not a workflow design limit).
 */
const MAX_RECAP_ANCESTOR_DEPTH = 100;

// ---------------------------------------------------------------------------
// Empty sentinels (named, not inlined)
// ---------------------------------------------------------------------------

const EMPTY_OBSERVATIONS: SessionObservations = {
  gitHeadSha: null,
  gitBranch: null,
  repoRootHash: null,
};



// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Ports required by the session summary provider.
 */
export interface LocalSessionSummaryProviderPorts {
  readonly directoryListing: DirectoryListingPortV2;
  readonly dataDir: DataDirPortV2;
  readonly sessionStore: SessionEventLogReadonlyStorePortV2;
}

// ---------------------------------------------------------------------------
// DI shell — thin boundary between I/O and pure logic
// ---------------------------------------------------------------------------

/**
 * Local session summary provider.
 *
 * Enumerates sessions from disk, loads + health-checks + projects each one,
 * and returns only healthy sessions with projectable runs.
 *
 * Individual session failures are skipped gracefully so partial results
 * remain useful even if some sessions are corrupt or unreadable.
 */
export class LocalSessionSummaryProviderV2 implements SessionSummaryProviderPortV2 {
  constructor(private readonly ports: LocalSessionSummaryProviderPorts) {}

  loadHealthySummaries(): ResultAsync<readonly HealthySessionSummary[], SessionSummaryError> {
    return enumerateSessionsByRecency({
      directoryListing: this.ports.directoryListing,
      dataDir: this.ports.dataDir,
    })
      .mapErr((fsErr): SessionSummaryError => ({
        code: 'SESSION_SUMMARY_ENUMERATION_FAILED',
        message: `Failed to enumerate sessions: ${fsErr.message}`,
      }))
      .andThen((sessionIds) =>
        collectHealthySummaries(
          sessionIds.slice(0, MAX_SESSIONS_TO_SCAN),
          this.ports.sessionStore,
        )
      );
  }
}

// ---------------------------------------------------------------------------
// I/O layer — sequential loading, graceful degradation
// ---------------------------------------------------------------------------

/**
 * Load healthy summaries for the given session IDs sequentially, skipping failures.
 *
 * Sequential (not parallel) to avoid hammering the file system.
 * Each failed session is gracefully skipped — partial results are still useful.
 *
 * Uses a functional reduce so the accumulator is immutable at each step.
 */
function collectHealthySummaries(
  sessionIds: readonly SessionId[],
  sessionStore: SessionEventLogReadonlyStorePortV2,
): ResultAsync<readonly HealthySessionSummary[], SessionSummaryError> {
  return sessionIds.reduce(
    (acc, sessionId) =>
      acc.andThen((summaries) =>
        loadSessionSummary(sessionId, sessionStore).map((summary) =>
          summary !== null ? [...summaries, summary] : summaries,
        )
      ),
    okAsync([] as readonly HealthySessionSummary[]),
  );
}

/**
 * Load and project a single session summary.
 * Returns null on any failure — graceful degradation for individual sessions.
 */
function loadSessionSummary(
  sessionId: SessionId,
  sessionStore: SessionEventLogReadonlyStorePortV2,
): ResultAsync<HealthySessionSummary | null, never> {
  return sessionStore
    .load(sessionId)
    .map((truth) => projectSessionSummary(sessionId, truth))
    .orElse(() => okAsync(null)); // Graceful skip: individual store failures don't abort enumeration
}

// ---------------------------------------------------------------------------
// Pure projection — no I/O; testable independently
// ---------------------------------------------------------------------------

/**
 * Project a healthy session summary from loaded truth.
 * Returns null if the session cannot be summarized (unhealthy, no runs, DAG error).
 *
 * Why separate from the I/O layer: pure functions are testable without a real
 * store, and separating concerns keeps each function's responsibility clear.
 */
function projectSessionSummary(
  sessionId: SessionId,
  truth: LoadedSessionTruthV2,
): HealthySessionSummary | null {
  // Gate: unhealthy sessions cannot be summarized
  const health = projectSessionHealthV2(truth);
  if (health.isErr() || health.value.kind !== 'healthy') return null;

  // Gate: DAG must be projectable (corrupt event streams are skipped gracefully)
  const dag = projectRunDagV2(truth.events);
  if (dag.isErr()) return null;

  const bestRun = selectBestRun(Object.values(dag.value.runsById));
  if (!bestRun) return null;

  // Gate: workflow identity must be resolvable (run_started event with valid hash)
  const workflow = extractWorkflowIdentity(truth.events, bestRun.run.runId);
  if (!workflow) return null;

  // Recap projection is best-effort: a failed output projection yields no snippet
  // rather than failing the whole summary.
  const outputsRes = projectNodeOutputsV2(truth.events);
  const recapSnippet = outputsRes.isOk()
    ? extractAggregateRecap(outputsRes.value, bestRun.run, bestRun.tipNodeId)
    : null;

  return {
    sessionId,
    runId: bestRun.run.runId,
    preferredTip: {
      nodeId: bestRun.tipNodeId,
      lastActivityEventIndex: bestRun.lastActivityEventIndex,
    },
    recapSnippet,
    observations: extractObservations(truth.events),
    workflow,
  } satisfies HealthySessionSummary;
}

// ---------------------------------------------------------------------------
// Run selection
// ---------------------------------------------------------------------------

/**
 * Select the most recently active run that has a confirmed preferred tip.
 * Returns null if no such run exists (e.g. freshly-created session with no nodes).
 */
function selectBestRun(runs: readonly RunDagRunV2[]): RunWithTip | null {
  // flatMap narrows: runs without a tip produce [], runs with a tip produce [RunWithTip].
  // No `!` assertions downstream — the tip is encoded in the type.
  const runsWithTip = runs.flatMap((r): RunWithTip[] => {
    const tipNodeId = r.preferredTipNodeId;
    if (!tipNodeId) return [];
    const tipNode = r.nodesById[tipNodeId];
    return [{ run: r, tipNodeId, lastActivityEventIndex: tipNode?.createdAtEventIndex ?? 0 }];
  });

  if (runsWithTip.length === 0) return null;

  // Linear scan for max activity — O(n), no sort allocation needed.
  return runsWithTip.reduce((best, r) =>
    r.lastActivityEventIndex > best.lastActivityEventIndex ? r : best,
  );
}

// ---------------------------------------------------------------------------
// Event extraction — type-safe, no `as` casts
//
// Why no `as` casts: DomainEventV1 is a discriminated union. After a type-guard
// filter (e.g. `e.kind === EVENT_KIND.OBSERVATION_RECORDED`), TypeScript narrows
// the event to the specific variant and gives us fully-typed `data` and `scope`
// for free. Casting would suppress that guarantee.
// ---------------------------------------------------------------------------

/**
 * Extract workspace observations from session events.
 *
 * Takes the last recorded value for each observation key — later events
 * supersede earlier ones, matching the "latest value wins" semantics in the
 * observation_recorded event spec.
 */
function extractObservations(events: readonly DomainEventV1[]): SessionObservations {
  return events
    .filter((e): e is ObservationEventV1 => e.kind === EVENT_KIND.OBSERVATION_RECORDED)
    .reduce((acc, e): SessionObservations => {
      // e.data.key is 'git_branch' | 'git_head_sha' | 'repo_root_hash' — exhaustive switch,
      // no default needed. TypeScript enforces all variants are handled.
      switch (e.data.key) {
        case 'git_head_sha': return { ...acc, gitHeadSha: e.data.value.value };
        case 'git_branch':   return { ...acc, gitBranch: e.data.value.value };
        case 'repo_root_hash': return { ...acc, repoRootHash: e.data.value.value };
      }
    }, EMPTY_OBSERVATIONS);
}

/**
 * Extract workflow identity for a specific run from session events.
 *
 * Returns null if the run_started event is missing or workflowHash is malformed.
 * This enforces the invariant at the boundary: only valid workflow identities
 * enter the summary pipeline.
 */
function extractWorkflowIdentity(events: readonly DomainEventV1[], runId: string): IdentifiedWorkflow | null {
  const event = events
    .filter((e): e is RunStartedEventV1 => e.kind === EVENT_KIND.RUN_STARTED)
    .find((e) => e.scope.runId === runId);

  if (!event) return null;

  // Validate workflowHash format at the boundary (trust inside after this)
  if (!SHA256_DIGEST_PATTERN.test(event.data.workflowHash)) return null;

  return {
    kind: 'identified',
    workflowId: asWorkflowId(event.data.workflowId),
    workflowHash: asWorkflowHash(asSha256Digest(event.data.workflowHash)),
  };
}

// ---------------------------------------------------------------------------
// Recap aggregation
// ---------------------------------------------------------------------------

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
 * Extract a single node's current recap markdown.
 * Returns null if the node has no current notes output.
 */
function extractNodeRecapMarkdown(
  outputs: NodeOutputsProjectionV2,
  nodeId: string,
): string | null {
  const nodeView = outputs.nodesById[nodeId];
  if (!nodeView) return null;

  const recapOutputs = nodeView.currentByChannel[OUTPUT_CHANNEL.RECAP];
  if (!recapOutputs || recapOutputs.length === 0) return null;

  // .at(-1) returns T | undefined; the length check above ensures this is non-null,
  // but using .at() avoids the index-based ! assertion.
  const latest = recapOutputs.at(-1);
  if (!latest || latest.payload.payloadKind !== PAYLOAD_KIND.NOTES) return null;

  // Discriminant narrows payload to { payloadKind: 'notes'; notesMarkdown: string } — no cast needed.
  return latest.payload.notesMarkdown;
}

/**
 * Build an aggregate recap snippet by collecting recap outputs from the tip
 * back through all ancestor nodes (newest to oldest).
 *
 * Why walk ancestors: sessions stopped mid-workflow have a pending tip with no
 * output yet — the completed work lives on ancestor nodes. Walking ancestors
 * ensures the session is discoverable by its prior outputs via resume_session.
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
