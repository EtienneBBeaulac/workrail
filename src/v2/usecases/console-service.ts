/**
 * Console Service — read-only composition of v2 projections for the Console UI.
 *
 * Pattern: same as LocalSessionSummaryProviderV2 — constructor takes ports interface.
 * All methods return DTOs shaped for the Console, never raw projection types.
 *
 * Completion detection: the engine's `complete` state lives in execution snapshots
 * (CAS), not in domain events. The service loads the preferred tip's snapshot per run
 * to determine completion, then passes the result to pure projection functions.
 *
 * Label resolution: human-readable step titles and workflow names are resolved by
 * loading execution snapshots (stepId) and pinned workflows (step title, workflow name).
 * Graceful degradation: if any label can't be resolved, it falls back to null.
 */
import { type ResultAsync, ResultAsync as RA } from 'neverthrow';
import { okAsync, errAsync } from 'neverthrow';
import type { DirectoryListingPortV2 } from '../ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../ports/session-event-log-store.port.js';
import type { SnapshotStorePortV2 } from '../ports/snapshot-store.port.js';
import type { PinnedWorkflowStorePortV2 } from '../ports/pinned-workflow-store.port.js';
import type { CompiledWorkflowSnapshot } from '../durable-core/schemas/compiled-workflow/index.js';
import type { ExecutionSnapshotFileV1 } from '../durable-core/schemas/execution-snapshot/index.js';
import { enumerateSessionsByRecency } from './enumerate-sessions.js';
import type { DirEntryWithMtime } from '../ports/directory-listing.port.js';
import { projectSessionHealthV2 } from '../projections/session-health.js';
import { projectRunDagV2, type RunDagProjectionV2, type RunDagNodeV2 } from '../projections/run-dag.js';
import { projectRunStatusSignalsV2 } from '../projections/run-status-signals.js';
import { projectGapsV2 } from '../projections/gaps.js';
import { projectNodeOutputsV2 } from '../projections/node-outputs.js';
import { projectAdvanceOutcomesV2 } from '../projections/advance-outcomes.js';
import { projectArtifactsV2 } from '../projections/artifacts.js';
import { projectRunContextV2 } from '../projections/run-context.js';
import { OUTPUT_CHANNEL, PAYLOAD_KIND, EVENT_KIND } from '../durable-core/constants.js';
import type {
  ConsoleSessionListResponse,
  ConsoleSessionSummary,
  ConsoleSessionDetail,
  ConsoleDagRun,
  ConsoleDagNode,
  ConsoleDagEdge,
  ConsoleRunStatus,
  ConsoleSessionHealth,
  ConsoleNodeDetail,
  ConsoleValidationResult,
  ConsoleValidationOutcome,
  ConsoleAdvanceOutcome,
  ConsoleAdvanceOutcomeKind,
  ConsoleNodeGap,
  ConsoleArtifact,
} from './console-types.js';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import type { LoadedSessionTruthV2 } from '../ports/session-event-log-store.port.js';
import type { SessionId, WorkflowHash } from '../durable-core/ids/index.js';
import { asSessionId, asSha256Digest, asSnapshotRef, asWorkflowHash } from '../durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ConsoleServicePorts {
  readonly directoryListing: DirectoryListingPortV2;
  readonly dataDir: DataDirPortV2;
  readonly sessionStore: SessionEventLogReadonlyStorePortV2;
  readonly snapshotStore: SnapshotStorePortV2;
  readonly pinnedWorkflowStore: PinnedWorkflowStorePortV2;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_SESSIONS_TO_LOAD = 500;

// ---------------------------------------------------------------------------
// Run completion map — keyed by runId, true when preferred tip snapshot
// has engineState.kind === 'complete'.
// ---------------------------------------------------------------------------

type RunCompletionMap = Readonly<Record<string, boolean>>;

// ---------------------------------------------------------------------------
// Label resolution maps
// ---------------------------------------------------------------------------

/** nodeId → human-readable step title (e.g. "Phase 0: Triage") */
type StepLabelMap = Readonly<Record<string, string>>;

/** workflowHash → human-readable workflow name */
type WorkflowNameMap = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConsoleService {
  constructor(private readonly ports: ConsoleServicePorts) {}

  getSessionList(): ResultAsync<ConsoleSessionListResponse, ConsoleServiceError> {
    return this.ports.directoryListing
      .readdirWithMtime(this.ports.dataDir.sessionsDir())
      .mapErr((fsErr): ConsoleServiceError => ({
        code: 'ENUMERATION_FAILED',
        message: `Failed to enumerate sessions: ${fsErr.message}`,
      }))
      .andThen((entries) => {
        const SESSION_DIR_PATTERN = /^sess_[a-zA-Z0-9_]+$/;
        const validEntries = entries
          .filter((e) => SESSION_DIR_PATTERN.test(e.name))
          .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
          .slice(0, MAX_SESSIONS_TO_LOAD);

        const mtimeBySessionId = new Map(validEntries.map((e) => [e.name, e.mtimeMs]));
        const sessionIds = validEntries.map((e) => asSessionId(e.name));
        return this.collectSessionSummaries(sessionIds, mtimeBySessionId);
      });
  }

  getSessionDetail(sessionIdStr: string): ResultAsync<ConsoleSessionDetail, ConsoleServiceError> {
    const sessionId = asSessionId(sessionIdStr);
    return this.ports.sessionStore
      .load(sessionId)
      .mapErr((storeErr): ConsoleServiceError => ({
        code: 'SESSION_LOAD_FAILED',
        message: `Failed to load session ${sessionIdStr}: ${storeErr.message}`,
      }))
      .andThen((truth) => {
        const dagRes = projectRunDagV2(truth.events);
        if (dagRes.isErr()) {
          return resolveRunCompletion(truth.events, this.ports.snapshotStore)
            .map((completionMap) => projectSessionDetail(sessionId, truth, completionMap, {}, {}));
        }
        const dag = dagRes.value;

        return RA.combine([
          resolveRunCompletion(truth.events, this.ports.snapshotStore),
          resolveStepLabels(dag, this.ports.snapshotStore, this.ports.pinnedWorkflowStore),
          resolveWorkflowNames(dag, this.ports.pinnedWorkflowStore),
        ] as const).map(([completionMap, stepLabels, workflowNames]) =>
          projectSessionDetail(sessionId, truth, completionMap, stepLabels, workflowNames)
        );
      });
  }

  getNodeDetail(sessionIdStr: string, nodeId: string): ResultAsync<ConsoleNodeDetail, ConsoleServiceError> {
    const sessionId = asSessionId(sessionIdStr);
    return this.ports.sessionStore
      .load(sessionId)
      .mapErr((storeErr): ConsoleServiceError => ({
        code: 'SESSION_LOAD_FAILED',
        message: `Failed to load session ${sessionIdStr}: ${storeErr.message}`,
      }))
      .andThen((truth) => {
        const dagRes = projectRunDagV2(truth.events);
        if (dagRes.isErr()) {
          return errAsync<ConsoleNodeDetail, ConsoleServiceError>({
            code: 'NODE_NOT_FOUND',
            message: `Node ${nodeId} not found in session ${sessionIdStr}`,
          });
        }

        return resolveStepLabels(dagRes.value, this.ports.snapshotStore, this.ports.pinnedWorkflowStore)
          .map((stepLabels) => {
            const result = projectNodeDetail(truth.events, nodeId, stepLabels);
            return result;
          })
          .andThen((result) => {
            if (!result) {
              return errAsync<ConsoleNodeDetail, ConsoleServiceError>({
                code: 'NODE_NOT_FOUND',
                message: `Node ${nodeId} not found in session ${sessionIdStr}`,
              });
            }
            return okAsync(result);
          });
      });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private collectSessionSummaries(
    sessionIds: readonly SessionId[],
    mtimeBySessionId: ReadonlyMap<string, number>,
  ): ResultAsync<ConsoleSessionListResponse, ConsoleServiceError> {
    const tasks = sessionIds.map((id) =>
      this.loadSessionSummary(id, mtimeBySessionId.get(id) ?? 0)
    );
    return RA.combine(tasks).map((results) => {
      const sessions = results.filter((s): s is ConsoleSessionSummary => s !== null);
      return { sessions, totalCount: sessions.length };
    });
  }

  private loadSessionSummary(
    sessionId: SessionId,
    lastModifiedMs: number,
  ): ResultAsync<ConsoleSessionSummary | null, never> {
    return this.ports.sessionStore
      .load(sessionId)
      .andThen((truth) => {
        const dagRes = projectRunDagV2(truth.events);
        const workflowNamesRA = dagRes.isOk()
          ? resolveWorkflowNames(dagRes.value, this.ports.pinnedWorkflowStore)
          : okAsync({} as WorkflowNameMap);

        return RA.combine([
          resolveRunCompletion(truth.events, this.ports.snapshotStore),
          workflowNamesRA,
        ] as const).map(([completionMap, workflowNames]) =>
          projectSessionSummary(sessionId, truth, completionMap, workflowNames, lastModifiedMs)
        );
      })
      .orElse(() => okAsync(null));
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ConsoleServiceError {
  readonly code: 'ENUMERATION_FAILED' | 'SESSION_LOAD_FAILED' | 'NODE_NOT_FOUND';
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Completion resolution (I/O boundary)
// ---------------------------------------------------------------------------

/**
 * Load preferred-tip snapshots to determine which runs have completed.
 *
 * Graceful degradation: if a snapshot cannot be loaded, the run is treated
 * as not-complete (never fails the overall operation).
 */
function resolveRunCompletion(
  events: readonly DomainEventV1[],
  snapshotStore: SnapshotStorePortV2,
): ResultAsync<RunCompletionMap, never> {
  const dagRes = projectRunDagV2(events);
  if (dagRes.isErr()) return okAsync({});

  return resolveRunCompletionFromDag(dagRes.value, snapshotStore);
}

function resolveRunCompletionFromDag(
  dag: RunDagProjectionV2,
  snapshotStore: SnapshotStorePortV2,
): ResultAsync<RunCompletionMap, never> {
  const tipRefs = collectPreferredTipSnapshotRefs(dag);
  if (tipRefs.length === 0) return okAsync({});

  const tasks = tipRefs.map(({ runId, snapshotRef }) =>
    snapshotStore
      .getExecutionSnapshotV1(snapshotRef)
      .map((snapshot): [string, boolean] => [
        runId,
        snapshot?.enginePayload.engineState.kind === 'complete',
      ])
      .orElse(() => okAsync([runId, false] as [string, boolean]))
  );

  return RA.combine(tasks).map((entries) => Object.fromEntries(entries));
}

function collectPreferredTipSnapshotRefs(
  dag: RunDagProjectionV2,
): readonly { readonly runId: string; readonly snapshotRef: ReturnType<typeof asSnapshotRef> }[] {
  const refs: { runId: string; snapshotRef: ReturnType<typeof asSnapshotRef> }[] = [];
  for (const run of Object.values(dag.runsById)) {
    if (!run.preferredTipNodeId) continue;
    const tip = run.nodesById[run.preferredTipNodeId];
    if (tip) refs.push({ runId: run.runId, snapshotRef: asSnapshotRef(asSha256Digest(tip.snapshotRef)) });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Step label resolution (I/O boundary)
// ---------------------------------------------------------------------------

/**
 * Resolve human-readable step titles for all nodes in a DAG.
 *
 * Chain: node.snapshotRef → execution snapshot → pending.step.stepId
 *      + node.workflowHash → pinned workflow → step definition → title
 *
 * Graceful: unreachable snapshots/workflows produce no label (never fails).
 */
function resolveStepLabels(
  dag: RunDagProjectionV2,
  snapshotStore: SnapshotStorePortV2,
  pinnedWorkflowStore: PinnedWorkflowStorePortV2,
): ResultAsync<StepLabelMap, never> {
  const allNodes: RunDagNodeV2[] = [];
  for (const run of Object.values(dag.runsById)) {
    allNodes.push(...Object.values(run.nodesById));
  }
  if (allNodes.length === 0) return okAsync({});

  const uniqueSnapshotRefs = [...new Set(allNodes.map((n) => n.snapshotRef))];

  const snapshotTasks = uniqueSnapshotRefs.map((ref) =>
    snapshotStore
      .getExecutionSnapshotV1(asSnapshotRef(asSha256Digest(ref)))
      .map((snap): [string, ExecutionSnapshotFileV1 | null] => [ref, snap])
      .orElse(() => okAsync([ref, null] as [string, ExecutionSnapshotFileV1 | null]))
  );

  return RA.combine(snapshotTasks).andThen((snapshotEntries) => {
    const snapshotByRef = new Map(snapshotEntries);
    const uniqueHashes = [...new Set(allNodes.map((n) => n.workflowHash))];

    const workflowTasks = uniqueHashes.map((hash) =>
      pinnedWorkflowStore
        .get(asWorkflowHash(asSha256Digest(hash)))
        .map((compiled): [string, ReadonlyMap<string, string>] => [
          hash,
          compiled ? extractStepTitlesFromCompiled(compiled) : new Map(),
        ])
        .orElse(() => okAsync([hash, new Map<string, string>()] as [string, ReadonlyMap<string, string>]))
    );

    return RA.combine(workflowTasks).map((workflowEntries) => {
      const titlesByHash = new Map(workflowEntries);
      const labels: Record<string, string> = {};

      for (const node of allNodes) {
        const snap = snapshotByRef.get(node.snapshotRef);
        const stepId = snap ? extractPendingStepId(snap) : null;
        if (!stepId) continue;

        const titles = titlesByHash.get(node.workflowHash);
        const title = titles?.get(stepId);
        labels[node.nodeId] = title ?? stepId;
      }

      return labels;
    });
  });
}

/**
 * Resolve human-readable workflow names from pinned workflows.
 * Groups by workflowHash to avoid duplicate loads.
 */
function resolveWorkflowNames(
  dag: RunDagProjectionV2,
  pinnedWorkflowStore: PinnedWorkflowStorePortV2,
): ResultAsync<WorkflowNameMap, never> {
  const hashSet = new Set<string>();
  for (const run of Object.values(dag.runsById)) {
    if (run.workflow.kind === 'with_workflow') {
      hashSet.add(run.workflow.workflowHash);
    }
  }
  if (hashSet.size === 0) return okAsync({});

  const tasks = [...hashSet].map((hash) =>
    pinnedWorkflowStore
      .get(asWorkflowHash(asSha256Digest(hash)))
      .map((compiled): [string, string | null] => [hash, compiled?.name ?? null])
      .orElse(() => okAsync([hash, null] as [string, string | null]))
  );

  return RA.combine(tasks).map((entries) => {
    const names: Record<string, string> = {};
    for (const [hash, name] of entries) {
      if (name) names[hash] = name;
    }
    return names;
  });
}

/** Extract the stepId from an execution snapshot's pending state. */
function extractPendingStepId(snapshot: ExecutionSnapshotFileV1): string | null {
  const state = snapshot.enginePayload.engineState;
  if ((state.kind === 'running' || state.kind === 'blocked') && state.pending.kind === 'some') {
    return String(state.pending.step.stepId);
  }
  return null;
}

/** Extract step ID → title map from a compiled workflow snapshot. */
function extractStepTitlesFromCompiled(compiled: CompiledWorkflowSnapshot): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();

  if (compiled.sourceKind === 'v1_preview') {
    titles.set(compiled.preview.stepId, compiled.preview.title);
    return titles;
  }

  const def = compiled.definition as Record<string, unknown>;
  const steps = Array.isArray(def?.['steps']) ? def['steps'] as Record<string, unknown>[] : [];
  for (const step of steps) {
    if (typeof step['id'] === 'string' && typeof step['title'] === 'string') {
      titles.set(step['id'], step['title']);
    }
    if (step['type'] === 'loop' && Array.isArray(step['body'])) {
      for (const bodyStep of step['body'] as Record<string, unknown>[]) {
        if (typeof bodyStep['id'] === 'string' && typeof bodyStep['title'] === 'string') {
          titles.set(bodyStep['id'], bodyStep['title']);
        }
      }
    }
  }

  return titles;
}

// ---------------------------------------------------------------------------
// Session title derivation (pure)
// ---------------------------------------------------------------------------

/** Well-known context keys that may describe the session's purpose. */
const TITLE_CONTEXT_KEYS = ['goal', 'taskDescription', 'mrTitle', 'prTitle', 'ticketTitle', 'problem'] as const;

/**
 * Derive a descriptive session title from available event data.
 *
 * Priority:
 * 1. Explicit context fields (goal, taskDescription, mrTitle, ...)
 * 2. First recap's descriptive content (stripped of markdown headings)
 * 3. null (caller falls back to workflowName or sessionId)
 */
function deriveSessionTitle(events: readonly DomainEventV1[]): string | null {
  // 1. Check context_set for well-known descriptive keys
  const contextRes = projectRunContextV2(events);
  if (contextRes.isOk()) {
    for (const runCtx of Object.values(contextRes.value.byRunId)) {
      for (const key of TITLE_CONTEXT_KEYS) {
        const val = runCtx.context[key];
        if (typeof val === 'string' && val.trim().length > 0) {
          return truncateTitle(val.trim());
        }
      }
    }
  }

  // 2. Extract first descriptive line from the root node's recap
  const title = extractTitleFromFirstRecap(events);
  if (title) return title;

  return null;
}

/**
 * Extract a title-like string from the first recap note in the session.
 * Skips markdown headings that just repeat the step name and looks for
 * the first substantive content line.
 */
function extractTitleFromFirstRecap(events: readonly DomainEventV1[]): string | null {
  const outputsRes = projectNodeOutputsV2(events);
  if (outputsRes.isErr()) return null;

  // Find root node (lowest eventIndex node_created)
  let rootNodeId: string | null = null;
  let minIndex = Infinity;
  for (const e of events) {
    if (e.kind === EVENT_KIND.NODE_CREATED && e.eventIndex < minIndex) {
      minIndex = e.eventIndex;
      rootNodeId = e.scope.nodeId;
    }
  }
  if (!rootNodeId) return null;

  const nodeOutputs = outputsRes.value.nodesById[rootNodeId];
  if (!nodeOutputs) return null;

  const recaps = nodeOutputs.currentByChannel[OUTPUT_CHANNEL.RECAP];
  const first = recaps?.[0];
  if (!first || first.payload.payloadKind !== PAYLOAD_KIND.NOTES) return null;

  return extractDescriptiveText(first.payload.notesMarkdown);
}

/**
 * From a markdown recap, extract the most descriptive text to use as a title.
 * Skips top-level headings (which tend to be step names) and looks for content
 * that describes the specific task.
 */
function extractDescriptiveText(markdown: string): string | null {
  const lines = markdown.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) continue;
    if (/^[-_*]{3,}$/.test(line)) continue;
    if (line.startsWith('|')) continue;

    // Bold-label lines like "**MR Title/Purpose:** some value" — extract the value
    const boldLabel = line.match(/^\*{2}[^*]+\*{2}:?\s*(.*)/);
    if (boldLabel) {
      const value = boldLabel[1]?.trim();
      if (value && value.length > 10) return truncateTitle(value);
      continue;
    }

    // List-item bold labels like "- **Label:** value"
    const listBoldLabel = line.match(/^-\s+\*{2}[^*]+\*{2}:?\s*(.*)/);
    if (listBoldLabel) {
      const value = listBoldLabel[1]?.trim();
      if (value && value.length > 10) return truncateTitle(value);
      continue;
    }

    // Any substantive text line
    if (line.length > 10) {
      return truncateTitle(line);
    }
  }

  return null;
}

/** Extract the git branch name from observation events. */
function extractGitBranch(events: readonly DomainEventV1[]): string | null {
  for (const e of events) {
    if (e.kind !== EVENT_KIND.OBSERVATION_RECORDED) continue;
    if (e.data.key === 'git_branch') {
      return e.data.value.value;
    }
  }
  return null;
}

function truncateTitle(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

// ---------------------------------------------------------------------------
// Pure projections (no I/O)
// ---------------------------------------------------------------------------

function projectSessionSummary(
  sessionId: SessionId,
  truth: LoadedSessionTruthV2,
  completionByRunId: RunCompletionMap,
  workflowNames: WorkflowNameMap,
  lastModifiedMs: number,
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

  const sessionTitle = deriveSessionTitle(events);
  const gitBranch = extractGitBranch(events);

  const runs = Object.values(dag.runsById);
  const run = runs[0];
  if (!run) {
    return {
      sessionId,
      sessionTitle,
      workflowId: null,
      workflowName: null,
      workflowHash: null,
      runId: null,
      status: 'in_progress',
      health: sessionHealth,
      nodeCount: 0,
      edgeCount: 0,
      tipCount: 0,
      hasUnresolvedGaps: false,
      recapSnippet: null,
      gitBranch,
      lastModifiedMs,
    };
  }

  const workflow = run.workflow;
  const workflowId = workflow.kind === 'with_workflow' ? workflow.workflowId : null;
  const workflowHash = workflow.kind === 'with_workflow' ? workflow.workflowHash : null;
  const workflowName = workflowHash ? (workflowNames[workflowHash] ?? null) : null;

  const statusSignals = statusRes.isOk() ? statusRes.value.byRunId[run.runId] : undefined;
  const status = deriveRunStatus(
    statusSignals?.isBlocked ?? false,
    statusSignals?.hasUnresolvedCriticalGaps ?? false,
    completionByRunId[run.runId] ?? false,
  );

  const hasUnresolvedGaps = gapsRes.isOk()
    ? Object.keys(gapsRes.value.unresolvedCriticalByRunId).length > 0
    : false;

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
    sessionTitle,
    workflowId,
    workflowName,
    workflowHash,
    runId: run.runId,
    status,
    health: sessionHealth,
    nodeCount: Object.keys(run.nodesById).length,
    edgeCount: run.edges.length,
    tipCount: run.tipNodeIds.length,
    hasUnresolvedGaps,
    recapSnippet,
    gitBranch,
    lastModifiedMs,
  };
}

function projectSessionDetail(
  sessionId: SessionId,
  truth: LoadedSessionTruthV2,
  completionByRunId: RunCompletionMap,
  stepLabels: StepLabelMap,
  workflowNames: WorkflowNameMap,
): ConsoleSessionDetail {
  const { events } = truth;
  const health = projectSessionHealthV2(truth);
  const sessionHealth: ConsoleSessionHealth =
    health.isOk() && health.value.kind === 'healthy' ? 'healthy' : 'corrupt';

  const sessionTitle = deriveSessionTitle(events);

  const dagRes = projectRunDagV2(events);
  if (dagRes.isErr()) {
    return { sessionId, sessionTitle, health: sessionHealth, runs: [] };
  }

  const statusRes = projectRunStatusSignalsV2(events);
  const gapsRes = projectGapsV2(events);

  const runs: ConsoleDagRun[] = Object.values(dagRes.value.runsById).map((run) => {
    const statusSignals = statusRes.isOk() ? statusRes.value.byRunId[run.runId] : undefined;
    const status = deriveRunStatus(
      statusSignals?.isBlocked ?? false,
      statusSignals?.hasUnresolvedCriticalGaps ?? false,
      completionByRunId[run.runId] ?? false,
    );

    const tipSet = new Set(run.tipNodeIds);
    const nodes: ConsoleDagNode[] = Object.values(run.nodesById).map((node) => ({
      nodeId: node.nodeId,
      nodeKind: node.nodeKind,
      parentNodeId: node.parentNodeId,
      createdAtEventIndex: node.createdAtEventIndex,
      isPreferredTip: node.nodeId === run.preferredTipNodeId,
      isTip: tipSet.has(node.nodeId),
      stepLabel: stepLabels[node.nodeId] ?? null,
    }));

    const edges: ConsoleDagEdge[] = run.edges.map((edge) => ({
      edgeKind: edge.edgeKind,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      createdAtEventIndex: edge.createdAtEventIndex,
    }));

    const workflow = run.workflow;
    const wfHash = workflow.kind === 'with_workflow' ? workflow.workflowHash : null;

    return {
      runId: run.runId,
      workflowId: workflow.kind === 'with_workflow' ? workflow.workflowId : null,
      workflowName: wfHash ? (workflowNames[wfHash] ?? null) : null,
      workflowHash: wfHash,
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

  return { sessionId, sessionTitle, health: sessionHealth, runs };
}

/**
 * Derive run status from signals.
 *
 * Priority: blocked > complete_with_gaps > complete > in_progress.
 * `complete_with_gaps` means the workflow finished but left unresolved follow-ups
 * (design lock: treated as "done-with-follow-ups", not "still in progress").
 */
function deriveRunStatus(isBlocked: boolean, hasUnresolvedCriticalGaps: boolean, isComplete: boolean): ConsoleRunStatus {
  if (isBlocked) return 'blocked';
  if (isComplete) return hasUnresolvedCriticalGaps ? 'complete_with_gaps' : 'complete';
  return 'in_progress';
}

/**
 * Pure projection: compose per-node detail from the event log.
 *
 * Returns null if the node doesn't exist in any run's DAG.
 * Gracefully degrades: if a sub-projection fails, that section is empty rather
 * than failing the entire node detail.
 */
function projectNodeDetail(
  events: readonly DomainEventV1[],
  nodeId: string,
  stepLabels: StepLabelMap,
): ConsoleNodeDetail | null {
  const dagRes = projectRunDagV2(events);
  if (dagRes.isErr()) return null;

  const { node, run } = findNodeInDag(dagRes.value, nodeId) ?? {};
  if (!node || !run) return null;

  const tipSet = new Set(run.tipNodeIds);

  const recapMarkdown = extractRecapMarkdown(events, nodeId);
  const artifacts = extractArtifacts(events, nodeId);
  const advanceOutcome = extractAdvanceOutcome(events, nodeId);
  const validations = extractValidations(events, nodeId);
  const gaps = extractGaps(events, nodeId);

  return {
    nodeId: node.nodeId,
    nodeKind: node.nodeKind,
    parentNodeId: node.parentNodeId,
    createdAtEventIndex: node.createdAtEventIndex,
    isPreferredTip: node.nodeId === run.preferredTipNodeId,
    isTip: tipSet.has(node.nodeId),
    stepLabel: stepLabels[node.nodeId] ?? null,
    recapMarkdown,
    artifacts,
    advanceOutcome,
    validations,
    gaps,
  };
}

function findNodeInDag(
  dag: RunDagProjectionV2,
  nodeId: string,
): { readonly node: RunDagProjectionV2['runsById'][string]['nodesById'][string]; readonly run: RunDagProjectionV2['runsById'][string] } | null {
  for (const run of Object.values(dag.runsById)) {
    const node = run.nodesById[nodeId];
    if (node) return { node, run };
  }
  return null;
}

function extractRecapMarkdown(events: readonly DomainEventV1[], nodeId: string): string | null {
  const outputsRes = projectNodeOutputsV2(events);
  if (outputsRes.isErr()) return null;

  const nodeOutputs = outputsRes.value.nodesById[nodeId];
  if (!nodeOutputs) return null;

  const recaps = nodeOutputs.currentByChannel[OUTPUT_CHANNEL.RECAP];
  const latest = recaps?.at(-1);
  if (latest && latest.payload.payloadKind === PAYLOAD_KIND.NOTES) {
    return latest.payload.notesMarkdown;
  }
  return null;
}

function extractArtifacts(events: readonly DomainEventV1[], nodeId: string): readonly ConsoleArtifact[] {
  const artifactsRes = projectArtifactsV2(events);
  if (artifactsRes.isErr()) return [];

  const nodeArtifacts = artifactsRes.value.byNodeId[nodeId];
  if (!nodeArtifacts) return [];

  return nodeArtifacts.artifacts.map((a) => ({
    sha256: a.sha256,
    contentType: a.contentType,
    byteLength: a.byteLength,
    content: a.content,
  }));
}

function extractAdvanceOutcome(events: readonly DomainEventV1[], nodeId: string): ConsoleAdvanceOutcome | null {
  const outcomesRes = projectAdvanceOutcomesV2(events);
  if (outcomesRes.isErr()) return null;

  const outcome = outcomesRes.value.byNodeId[nodeId];
  if (!outcome) return null;

  return {
    attemptId: outcome.latestAttemptId,
    kind: outcome.outcome.kind as ConsoleAdvanceOutcomeKind,
    recordedAtEventIndex: outcome.recordedAtEventIndex,
  };
}

function extractValidations(events: readonly DomainEventV1[], nodeId: string): readonly ConsoleValidationResult[] {
  const results: ConsoleValidationResult[] = [];
  for (const e of events) {
    if (e.kind !== EVENT_KIND.VALIDATION_PERFORMED) continue;
    if (e.scope.nodeId !== nodeId) continue;

    results.push({
      validationId: e.data.validationId,
      attemptId: e.data.attemptId,
      contractRef: e.data.contractRef,
      outcome: (e.data.result.valid ? 'pass' : 'fail') as ConsoleValidationOutcome,
      issues: [...e.data.result.issues],
      suggestions: [...e.data.result.suggestions],
    });
  }
  return results;
}

function extractGaps(events: readonly DomainEventV1[], nodeId: string): readonly ConsoleNodeGap[] {
  const gapsRes = projectGapsV2(events);
  if (gapsRes.isErr()) return [];

  const gaps: ConsoleNodeGap[] = [];
  for (const gap of Object.values(gapsRes.value.byGapId)) {
    if (gap.nodeId !== nodeId) continue;
    gaps.push({
      gapId: gap.gapId,
      severity: gap.severity as 'critical' | 'non_critical',
      summary: gap.summary,
      isResolved: gapsRes.value.resolvedGapIds.has(gap.gapId),
    });
  }
  return gaps;
}
