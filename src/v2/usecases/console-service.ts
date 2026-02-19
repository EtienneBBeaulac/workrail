/**
 * Console Service — read-only composition of v2 projections for the Console UI.
 *
 * Pattern: same as LocalSessionSummaryProviderV2 — constructor takes ports interface.
 * All methods return DTOs shaped for the Console, never raw projection types.
 */
import type { ResultAsync } from 'neverthrow';
import { okAsync } from 'neverthrow';
import type { DirectoryListingPortV2 } from '../ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../ports/session-event-log-store.port.js';
import { enumerateSessions } from './enumerate-sessions.js';
import { projectSessionHealthV2 } from '../projections/session-health.js';
import { projectRunDagV2 } from '../projections/run-dag.js';
import { projectRunStatusSignalsV2 } from '../projections/run-status-signals.js';
import { projectGapsV2 } from '../projections/gaps.js';
import { projectNodeOutputsV2 } from '../projections/node-outputs.js';
import { OUTPUT_CHANNEL, PAYLOAD_KIND } from '../durable-core/constants.js';
import type {
  ConsoleSessionListResponse,
  ConsoleSessionSummary,
  ConsoleSessionDetail,
  ConsoleDagRun,
  ConsoleDagNode,
  ConsoleDagEdge,
  ConsoleRunStatus,
  ConsoleSessionHealth,
} from './console-types.js';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import type { LoadedSessionTruthV2 } from '../ports/session-event-log-store.port.js';
import type { SessionId } from '../durable-core/ids/index.js';
import { asSessionId } from '../durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ConsoleServicePorts {
  readonly directoryListing: DirectoryListingPortV2;
  readonly dataDir: DataDirPortV2;
  readonly sessionStore: SessionEventLogReadonlyStorePortV2;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_SESSIONS_TO_SCAN = 50;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConsoleService {
  constructor(private readonly ports: ConsoleServicePorts) {}

  getSessionList(): ResultAsync<ConsoleSessionListResponse, ConsoleServiceError> {
    return enumerateSessions({
      directoryListing: this.ports.directoryListing,
      dataDir: this.ports.dataDir,
    })
      .mapErr((fsErr): ConsoleServiceError => ({
        code: 'ENUMERATION_FAILED',
        message: `Failed to enumerate sessions: ${fsErr.message}`,
      }))
      .andThen((sessionIds) =>
        this.collectSessionSummaries(sessionIds.slice(0, MAX_SESSIONS_TO_SCAN))
      );
  }

  getSessionDetail(sessionIdStr: string): ResultAsync<ConsoleSessionDetail, ConsoleServiceError> {
    const sessionId = asSessionId(sessionIdStr);
    return this.ports.sessionStore
      .load(sessionId)
      .mapErr((storeErr): ConsoleServiceError => ({
        code: 'SESSION_LOAD_FAILED',
        message: `Failed to load session ${sessionIdStr}: ${storeErr.message}`,
      }))
      .map((truth) => projectSessionDetail(sessionId, truth));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private collectSessionSummaries(
    sessionIds: readonly SessionId[],
  ): ResultAsync<ConsoleSessionListResponse, ConsoleServiceError> {
    return sessionIds.reduce(
      (acc, sessionId) =>
        acc.andThen((summaries) =>
          this.loadSessionSummary(sessionId).map((summary) =>
            summary !== null ? [...summaries, summary] : summaries,
          )
        ),
      okAsync([] as readonly ConsoleSessionSummary[]),
    ).map((sessions) => ({ sessions, totalCount: sessions.length }));
  }

  private loadSessionSummary(
    sessionId: SessionId,
  ): ResultAsync<ConsoleSessionSummary | null, never> {
    return this.ports.sessionStore
      .load(sessionId)
      .map((truth) => projectSessionSummary(sessionId, truth))
      .orElse(() => okAsync(null));
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ConsoleServiceError {
  readonly code: 'ENUMERATION_FAILED' | 'SESSION_LOAD_FAILED';
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Pure projections (no I/O)
// ---------------------------------------------------------------------------

function projectSessionSummary(
  sessionId: SessionId,
  truth: LoadedSessionTruthV2,
): ConsoleSessionSummary | null {
  const { events } = truth;
  const health = projectSessionHealthV2(truth);
  if (health.isErr()) return null;

  const sessionHealth: ConsoleSessionHealth =
    health.value.kind === 'healthy' ? 'healthy' : 'corrupt';

  const dagRes = projectRunDagV2(events);
  if (dagRes.isErr()) return null;
  const dag = dagRes.value;

  const statusRes = projectRunStatusSignalsV2(events);
  const gapsRes = projectGapsV2(events);

  // Pick the first run (most sessions have exactly one)
  const runs = Object.values(dag.runsById);
  const run = runs[0];
  if (!run) {
    return {
      sessionId,
      workflowId: null,
      workflowHash: null,
      runId: null,
      status: 'in_progress',
      health: sessionHealth,
      nodeCount: 0,
      edgeCount: 0,
      tipCount: 0,
      hasUnresolvedGaps: false,
      recapSnippet: null,
    };
  }

  const workflow = run.workflow;
  const workflowId = workflow.kind === 'with_workflow' ? workflow.workflowId : null;
  const workflowHash = workflow.kind === 'with_workflow' ? workflow.workflowHash : null;

  const statusSignals = statusRes.isOk() ? statusRes.value.byRunId[run.runId] : undefined;
  const status = deriveRunStatus(statusSignals?.isBlocked ?? false, statusSignals?.hasUnresolvedCriticalGaps ?? false);

  const hasUnresolvedGaps = gapsRes.isOk()
    ? Object.keys(gapsRes.value.unresolvedCriticalByRunId).length > 0
    : false;

  // Extract recap from node outputs
  const outputsRes = projectNodeOutputsV2(events);
  let recapSnippet: string | null = null;
  if (outputsRes.isOk() && run.preferredTipNodeId) {
    const tipOutputs = outputsRes.value.nodesById[run.preferredTipNodeId];
    if (tipOutputs) {
      const recaps = tipOutputs.currentByChannel[OUTPUT_CHANNEL.RECAP];
      const latest = recaps?.at(-1);
      if (latest && latest.payload.payloadKind === PAYLOAD_KIND.NOTES) {
        recapSnippet = latest.payload.notesMarkdown;
      }
    }
  }

  return {
    sessionId,
    workflowId,
    workflowHash,
    runId: run.runId,
    status,
    health: sessionHealth,
    nodeCount: Object.keys(run.nodesById).length,
    edgeCount: run.edges.length,
    tipCount: run.tipNodeIds.length,
    hasUnresolvedGaps,
    recapSnippet,
  };
}

function projectSessionDetail(
  sessionId: SessionId,
  truth: LoadedSessionTruthV2,
): ConsoleSessionDetail {
  const { events } = truth;
  const health = projectSessionHealthV2(truth);
  const sessionHealth: ConsoleSessionHealth =
    health.isOk() && health.value.kind === 'healthy' ? 'healthy' : 'corrupt';

  const dagRes = projectRunDagV2(events);
  if (dagRes.isErr()) {
    return { sessionId, health: sessionHealth, runs: [] };
  }

  const statusRes = projectRunStatusSignalsV2(events);
  const gapsRes = projectGapsV2(events);

  const runs: ConsoleDagRun[] = Object.values(dagRes.value.runsById).map((run) => {
    const statusSignals = statusRes.isOk() ? statusRes.value.byRunId[run.runId] : undefined;
    const status = deriveRunStatus(
      statusSignals?.isBlocked ?? false,
      statusSignals?.hasUnresolvedCriticalGaps ?? false,
    );

    const tipSet = new Set(run.tipNodeIds);
    const nodes: ConsoleDagNode[] = Object.values(run.nodesById).map((node) => ({
      nodeId: node.nodeId,
      nodeKind: node.nodeKind,
      parentNodeId: node.parentNodeId,
      createdAtEventIndex: node.createdAtEventIndex,
      isPreferredTip: node.nodeId === run.preferredTipNodeId,
      isTip: tipSet.has(node.nodeId),
    }));

    const edges: ConsoleDagEdge[] = run.edges.map((edge) => ({
      edgeKind: edge.edgeKind,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      createdAtEventIndex: edge.createdAtEventIndex,
    }));

    const workflow = run.workflow;

    return {
      runId: run.runId,
      workflowId: workflow.kind === 'with_workflow' ? workflow.workflowId : null,
      workflowHash: workflow.kind === 'with_workflow' ? workflow.workflowHash : null,
      preferredTipNodeId: run.preferredTipNodeId,
      nodes,
      edges,
      tipNodeIds: [...run.tipNodeIds],
      status,
      hasUnresolvedCriticalGaps: gapsRes.isOk()
        ? (gapsRes.value.unresolvedCriticalByRunId[run.runId]?.length ?? 0) > 0
        : false,
    };
  });

  return { sessionId, health: sessionHealth, runs };
}

function deriveRunStatus(isBlocked: boolean, hasUnresolvedCriticalGaps: boolean): ConsoleRunStatus {
  if (isBlocked) return 'blocked';
  if (hasUnresolvedCriticalGaps) return 'complete_with_gaps';
  return 'in_progress';
}
