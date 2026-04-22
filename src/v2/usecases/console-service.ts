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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { type ResultAsync, ResultAsync as RA } from 'neverthrow';
import { okAsync, errAsync, err } from 'neverthrow';
import type { DirectoryListingPortV2 } from '../ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../ports/session-event-log-store.port.js';
import type { SnapshotStorePortV2 } from '../ports/snapshot-store.port.js';
import type { PinnedWorkflowStorePortV2 } from '../ports/pinned-workflow-store.port.js';
import type { DaemonRegistry } from '../infra/in-memory/daemon-registry/index.js';
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
import { projectSessionMetricsV2 } from '../projections/session-metrics.js';
import { asSortedEventLog, type SortedEventLog } from '../durable-core/sorted-event-log.js';
import { projectRunExecutionTraceV2 } from '../projections/run-execution-trace.js';
import { OUTPUT_CHANNEL, PAYLOAD_KIND, EVENT_KIND } from '../durable-core/constants.js';
import type {
  ConsoleSessionListResponse,
  ConsoleSessionSummary,
  ConsoleSessionDetail,
  ConsoleDagRun,
  ConsoleDagNode,
  ConsoleDagEdge,
  ConsoleGhostStep,
  ConsoleRunStatus,
  ConsoleSessionStatus,
  ConsoleSessionHealth,
  ConsoleNodeDetail,
  ConsoleValidationResult,
  ConsoleValidationOutcome,
  ConsoleAdvanceOutcome,
  ConsoleAdvanceOutcomeKind,
  ConsoleNodeGap,
  ConsoleArtifact,
  ConsoleToolActivity,
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
  /** Optional: when provided, isLive is computed from the registry's snapshot.
   * When absent, isLive is always false (safe default for MCP-only mode). */
  readonly daemonRegistry?: DaemonRegistry;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_SESSIONS_TO_LOAD = 500;

// ---------------------------------------------------------------------------
// Dormancy
// ---------------------------------------------------------------------------

/** Sessions in_progress with no activity for this long are considered dormant.
 * Override via WORKRAIL_DORMANCY_THRESHOLD_MS env var (milliseconds, must be > 0). */
const DORMANCY_THRESHOLD_MS = (() => {
  const override = parseInt(process.env['WORKRAIL_DORMANCY_THRESHOLD_MS'] ?? '', 10);
  return Number.isFinite(override) && override > 0 ? override : 60 * 60 * 1000;
})();

/** Autonomous sessions are considered "live" only when the DaemonRegistry has a recent
 * heartbeat for the session. If the daemon crashes, the heartbeat stops advancing and
 * the LIVE badge disappears after this threshold.
 *
 * 10 minutes is intentionally generous: coding workflow steps can include long Bash
 * commands and multi-file reads. A timer-based heartbeat (within a step) will tighten
 * this in a future daemon iteration; for MVP, heartbeats fire at continue_workflow advances.
 */
const AUTONOMOUS_HEARTBEAT_THRESHOLD_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Live activity (daemon event log)
// ---------------------------------------------------------------------------

/**
 * Maximum number of tool activity entries to return in liveActivity.
 * WHY 5: enough to show recent activity without overwhelming the console UI.
 */
const LIVE_ACTIVITY_MAX_ENTRIES = 5;

/**
 * Maximum bytes to read from the daemon event log file tail.
 * WHY 100KB: at ~200 bytes/event, this covers ~500 events -- far more than
 * LIVE_ACTIVITY_MAX_ENTRIES. Matches the tail-read pattern in console-routes.ts.
 */
const DAEMON_EVENT_LOG_READ_LIMIT_BYTES = 100 * 1024;

/**
 * Directory for daemon event log JSONL files.
 * Format: YYYY-MM-DD.jsonl, one per day, rotated automatically by DaemonEventEmitter.
 */
const DAEMON_EVENTS_DIR = path.join(os.homedir(), '.workrail', 'events', 'daemon');

/**
 * Determine whether a session is currently live by inspecting today's daemon event log.
 *
 * A session is live if and only if:
 * - Any event with a matching `workrailSessionId` exists in today's log
 * - AND no `session_completed` event exists for the same `workrailSessionId`
 *
 * WHY any event, not session_started: `session_started` is emitted BEFORE
 * `executeStartWorkflow()` returns, so it never carries `workrailSessionId`.
 * All subsequent events (tool_called, step_advanced, llm_turn_started, etc.) are
 * emitted after the session ID is known and always include `workrailSessionId`.
 * Checking for any correlated event is therefore the correct liveness signal.
 *
 * WHY event log instead of DaemonRegistry: DaemonRegistry is in-memory and resets
 * when the standalone console restarts. The daemon event log is durable on disk --
 * it reflects the true session lifecycle regardless of whether the console process
 * was restarted since the session began.
 *
 * Best-effort: returns false on any error (file not found, parse error, etc.).
 * Never throws or propagates errors -- correctness must never depend on this check.
 *
 * @param workrailSessionId - The WorkRail session ID (sess_xxx) to check.
 */
async function isSessionLiveFromEventLog(workrailSessionId: string): Promise<boolean> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(DAEMON_EVENTS_DIR, `${date}.jsonl`);

  try {
    let raw: string;
    const stat = await fs.stat(filePath);
    if (stat.size > DAEMON_EVENT_LOG_READ_LIMIT_BYTES) {
      const fd = await fs.open(filePath, 'r');
      const offset = stat.size - DAEMON_EVENT_LOG_READ_LIMIT_BYTES;
      const buf = Buffer.alloc(DAEMON_EVENT_LOG_READ_LIMIT_BYTES);
      try {
        await fd.read(buf, 0, DAEMON_EVENT_LOG_READ_LIMIT_BYTES, offset);
      } finally {
        await fd.close();
      }
      raw = buf.toString('utf8');
    } else {
      raw = await fs.readFile(filePath, 'utf8');
    }

    // hasSeen: true when ANY event with a matching workrailSessionId has been observed.
    // All post-start events carry workrailSessionId; session_started does not (see JSDoc above).
    let hasSeen = false;
    let hasCompleted = false;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event['workrailSessionId'] !== workrailSessionId) continue;
        hasSeen = true;
        if (event['kind'] === 'session_completed') hasCompleted = true;
      } catch {
        // Malformed line -- skip it
      }
    }

    return hasSeen && !hasCompleted;
  } catch {
    // File not found, permission error, parse error, etc. -- safe default: not live.
    return false;
  }
}

/**
 * Read the last N tool activity events from today's daemon event log for a given session.
 *
 * Reads from BOTH the coarse stream (tool_called) and fine-grained stream (tool_call_started)
 * to show all tool activity regardless of which stream emitted it. See ToolCallStartedEvent
 * in daemon-events.ts for documentation of the dual-stream model.
 *
 * Best-effort: returns null on any error (file not found, parse error, etc.).
 * Never throws or propagates errors -- this is observability, not correctness.
 * Returns [] when no matching events found (log readable but empty for this session).
 *
 * @param workrailSessionId - The WorkRail session ID to filter by.
 * @param maxEntries - Maximum number of entries to return.
 */
async function readLiveActivity(
  workrailSessionId: string,
  maxEntries: number,
): Promise<readonly ConsoleToolActivity[] | null> {
  // WHY today-only: a session active just before UTC midnight will have events in yesterday's file; after midnight liveActivity returns null for up to 10 minutes until a new heartbeat. Known limitation.
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(DAEMON_EVENTS_DIR, `${date}.jsonl`);

  try {
    let raw: string;
    const stat = await fs.stat(filePath);
    if (stat.size > DAEMON_EVENT_LOG_READ_LIMIT_BYTES) {
      // Tail-read: read only the last DAEMON_EVENT_LOG_READ_LIMIT_BYTES.
      // First line in the slice may be truncated -- JSON.parse catch handles it.
      const fd = await fs.open(filePath, 'r');
      const offset = stat.size - DAEMON_EVENT_LOG_READ_LIMIT_BYTES;
      const buf = Buffer.alloc(DAEMON_EVENT_LOG_READ_LIMIT_BYTES);
      try {
        await fd.read(buf, 0, DAEMON_EVENT_LOG_READ_LIMIT_BYTES, offset);
      } finally {
        await fd.close();
      }
      raw = buf.toString('utf8');
    } else {
      raw = await fs.readFile(filePath, 'utf8');
    }

    const activities: ConsoleToolActivity[] = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        // Accept both coarse stream (tool_called) and fine-grained stream (tool_call_started),
        // plus agent_stuck events which are surfaced prominently in the live activity panel.
        // See dual-stream model docs in ToolCallStartedEvent in daemon-events.ts.
        const isToolEvent =
          event['kind'] === 'tool_called' ||
          event['kind'] === 'tool_call_started' ||
          event['kind'] === 'agent_stuck';
        if (
          !isToolEvent ||
          event['workrailSessionId'] !== workrailSessionId ||
          typeof event['ts'] !== 'number'
        ) {
          continue;
        }

        if (event['kind'] === 'agent_stuck') {
          // WHY toolName='agent_stuck': ConsoleToolActivity expects a toolName field.
          // Using a sentinel value makes agent_stuck events identifiable by the console UI
          // without requiring a schema change to ConsoleToolActivity.
          activities.push({
            toolName: 'agent_stuck',
            summary: `STUCK: ${String(event['reason'] ?? '?')} -- ${String(event['detail'] ?? '').slice(0, 80)}`,
            ts: event['ts'],
          });
          continue;
        }

        if (typeof event['toolName'] !== 'string') continue;

        activities.push({
          toolName: event['toolName'],
          ...(typeof event['summary'] === 'string' ? { summary: event['summary'] } : {}),
          ts: event['ts'],
        });
      } catch {
        // Malformed line -- skip it
      }
    }

    // Return last N entries (most recent activity).
    return activities.slice(-maxEntries);
  } catch {
    // File not found, permission error, etc. -- return null gracefully.
    return null;
  }
}

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

  /**
   * In-process projection cache keyed by sessionId.
   *
   * Each entry stores the mtime at the time the summary was projected and the
   * projected summary itself. On cache hit the store is not consulted and no
   * projection runs. On mtime change the entry is replaced.
   *
   * The cache is instance-scoped (not module-level) so it never leaks state
   * between independent ConsoleService instances (e.g. in tests). Entries
   * accumulate over the lifetime of the instance and are only replaced when
   * the session's mtime changes -- there is no size-based eviction.
   *
   * Only summaries with terminal statuses (`complete`, `complete_with_gaps`,
   * `blocked`, `dormant`) are cached. `in_progress` summaries are intentionally
   * excluded: a dormant session writes no new events so its mtime never
   * advances, meaning an `in_progress` entry would never be invalidated and
   * would never transition to `dormant`. Null results (load errors, corrupt
   * sessions) are also excluded and retried on the next request.
   */
  private readonly _summaryCache = new Map<string, { readonly mtime: number; readonly summary: ConsoleSessionSummary }>();

  /** Returns the absolute path to the sessions directory -- used by the SSE watcher. */
  getSessionsDir(): string {
    return this.ports.dataDir.sessionsDir();
  }

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
        // Compute session-level aggregates from events BEFORE the dagErr fork.
        // WHY before fork: these are session-level projections that apply regardless of DAG health.
        // Both the dagErr early-return path and the normal path need metrics and repoRoot.
        const metrics = projectSessionMetricsV2(truth.events);
        const repoRoot = extractRepoRoot(truth.events);

        const dagRes = projectRunDagV2(truth.events);

        const detailRA = (() => {
          if (dagRes.isErr()) {
            return resolveRunCompletion(truth.events, this.ports.snapshotStore)
              .map((completionMap) => ({
                ...projectSessionDetail(sessionId, truth, completionMap, {}, {}),
                metrics,
                repoRoot,
              }));
          }
          const dag = dagRes.value;

          return RA.combine([
            resolveRunCompletion(truth.events, this.ports.snapshotStore),
            resolveStepLabels(dag, this.ports.snapshotStore, this.ports.pinnedWorkflowStore),
            resolveWorkflowNames(dag, this.ports.pinnedWorkflowStore),
          ] as const).map(([completionMap, stepLabels, workflowNames]) => ({
            ...projectSessionDetail(sessionId, truth, completionMap, stepLabels, workflowNames),
            metrics,
            repoRoot,
          }));
        })();

        // Attach liveActivity when the session is currently live.
        // isLive: derived from the daemon event log (any correlated event seen, session_completed absent).
        // WHY event log instead of DaemonRegistry: DaemonRegistry is in-memory and resets when the
        // standalone console restarts -- the event log is durable and reflects the true session lifecycle.
        // Best-effort: any error reading the event log returns false (safe default: shows as not live).
        const isLiveRA = RA.fromSafePromise(isSessionLiveFromEventLog(sessionIdStr));

        return RA.combine([detailRA, isLiveRA] as const).andThen(([detail, isLive]) => {
          if (!isLive) {
            return okAsync({ ...detail, isLive: false, liveActivity: null });
          }

          // Session is live -- read tool activity from daemon event log.
          // WHY RA.fromSafePromise: readLiveActivity never throws (returns null on error).
          const liveActivityRA = RA.fromSafePromise(
            readLiveActivity(sessionIdStr, LIVE_ACTIVITY_MAX_ENTRIES)
          );

          // Returns [] when no tool_called events found yet (log readable but empty); null means the log file could not be read.
          return liveActivityRA.map((liveActivity) => ({ ...detail, isLive: true, liveActivity }));
        });
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
    // Capture nowMs once per list request so all sessions are evaluated against
    // the same point in time — consistent snapshot and deterministic per call.
    const nowMs = Date.now();
    const tasks = sessionIds.map((id) =>
      this.loadSessionSummary(id, mtimeBySessionId.get(id) ?? 0, nowMs)
    );
    return RA.combine(tasks).map((results) => {
      const sessions = results.filter((s): s is ConsoleSessionSummary => s !== null);
      return { sessions, totalCount: sessions.length };
    });
  }

  private loadSessionSummary(
    sessionId: SessionId,
    lastModifiedMs: number,
    nowMs: number,
  ): ResultAsync<ConsoleSessionSummary | null, never> {
    // Cache hit: return the stored summary without any disk I/O or re-projection.
    // The mtime check is the invalidation signal: if the session's event log was
    // appended to, its directory mtime advances and we fall through to a fresh load.
    const cached = this._summaryCache.get(sessionId);
    if (cached !== undefined && cached.mtime === lastModifiedMs) {
      return okAsync(cached.summary);
    }

    return this.ports.sessionStore
      .load(sessionId)
      .andThen((truth) => {
        // Compute the DAG once here and thread it through both resolveRunCompletion
        // and projectSessionSummary to avoid redundant re-projection.
        const dagRes = projectRunDagV2(truth.events);
        const workflowNamesRA = dagRes.isOk()
          ? resolveWorkflowNames(dagRes.value, this.ports.pinnedWorkflowStore)
          : okAsync({} as WorkflowNameMap);

        const completionRA = dagRes.isOk()
          ? resolveRunCompletionFromDag(dagRes.value, this.ports.snapshotStore)
          : okAsync({} as RunCompletionMap);

        // Compute isLive synchronously from the registry snapshot (no I/O).
        // The registry is read here (at the I/O assembly boundary) and passed
        // as a plain boolean to the pure projectSessionSummary() function.
        const registryEntry = this.ports.daemonRegistry?.snapshot().get(sessionId);
        const isLive = registryEntry !== undefined
          && (nowMs - registryEntry.lastHeartbeatMs) < AUTONOMOUS_HEARTBEAT_THRESHOLD_MS;

        return RA.combine([
          completionRA,
          workflowNamesRA,
        ] as const).map(([completionMap, workflowNames]) => {
          const dag = dagRes.isOk() ? dagRes.value : undefined;
          return projectSessionSummary(sessionId, truth, completionMap, workflowNames, lastModifiedMs, nowMs, dag, isLive);
        });
      })
      .map((summary) => {
        // Only cache summaries with terminal statuses. `in_progress` is excluded
        // because a session that should become `dormant` writes no new events,
        // so its mtime never changes -- a cached `in_progress` would never
        // transition to `dormant`. Terminal statuses (`complete`,
        // `complete_with_gaps`, `blocked`, `dormant`) are stable and safe to
        // cache by mtime. Null results (load errors, corrupt DAG) are also
        // excluded so they are retried on the next request.
        if (summary !== null && summary.status !== 'in_progress') {
          this._summaryCache.set(sessionId, { mtime: lastModifiedMs, summary });
        }
        return summary;
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

// ---------------------------------------------------------------------------
// Skipped step resolution (I/O boundary)
// ---------------------------------------------------------------------------

type SkippedStepsMap = Readonly<Record<string, readonly ConsoleGhostStep[]>>;

function resolveSkippedSteps(
  dag: RunDagProjectionV2,
  events: readonly DomainEventV1[],
  pinnedWorkflowStore: PinnedWorkflowStorePortV2,
): ResultAsync<SkippedStepsMap, never> {
  const traceRes = projectRunExecutionTraceV2(events);
  if (traceRes.isErr()) return okAsync({});

  const skippedByRunId: Record<string, { stepId: string; recordedAtEventIndex: number }[]> = {};
  for (const [runId, traceSummary] of Object.entries(traceRes.value.byRunId)) {
    for (const item of traceSummary.items) {
      if (item.kind !== 'evaluated_condition') continue;
      if (!item.summary.startsWith('SKIP:')) continue;
      const stepRef = item.refs.find((r) => r.kind === 'step_id');
      if (!stepRef) continue;
      const existing = skippedByRunId[runId] ?? [];
      existing.push({ stepId: stepRef.value, recordedAtEventIndex: item.recordedAtEventIndex });
      skippedByRunId[runId] = existing;
    }
  }

  if (Object.keys(skippedByRunId).length === 0) return okAsync({});

  const hashSet = new Set<string>();
  for (const run of Object.values(dag.runsById)) {
    if (run.workflow.kind === 'with_workflow') {
      hashSet.add(run.workflow.workflowHash);
    }
  }

  if (hashSet.size === 0) {
    const result: Record<string, readonly ConsoleGhostStep[]> = {};
    for (const [runId, items] of Object.entries(skippedByRunId)) {
      const seen = new Set<string>();
      const steps: ConsoleGhostStep[] = [];
      for (const { stepId } of [...items].sort((a, b) => a.recordedAtEventIndex - b.recordedAtEventIndex)) {
        if (!seen.has(stepId)) { seen.add(stepId); steps.push({ stepId, stepLabel: null }); }
      }
      result[runId] = steps;
    }
    return okAsync(result);
  }

  const workflowTasks = [...hashSet].map((hash) =>
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
    const result: Record<string, readonly ConsoleGhostStep[]> = {};
    for (const [runId, items] of Object.entries(skippedByRunId)) {
      const run = dag.runsById[runId];
      const wfHash = run?.workflow.kind === 'with_workflow' ? run.workflow.workflowHash : null;
      const titles = wfHash ? titlesByHash.get(wfHash) : undefined;
      const seen = new Set<string>();
      const steps: ConsoleGhostStep[] = [];
      for (const { stepId } of [...items].sort((a, b) => a.recordedAtEventIndex - b.recordedAtEventIndex)) {
        if (!seen.has(stepId)) { seen.add(stepId); steps.push({ stepId, stepLabel: titles?.get(stepId) ?? null }); }
      }
      result[runId] = steps;
    }
    return result;
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
 *
 * Accepts a pre-validated SortedEventLog so that callers which have already
 * called asSortedEventLog() do not repeat the O(n) sort check.
 */
function deriveSessionTitle(sortedEvents: SortedEventLog): string | null {
  // 1. Check context_set for well-known descriptive keys
  const contextRes = projectRunContextV2(sortedEvents);
  if (contextRes.isOk()) {
    for (const runCtx of Object.values(contextRes.value.byRunId)) {
      for (const key of TITLE_CONTEXT_KEYS) {
        const val = runCtx.context[key];
        if (typeof val === 'string' && val.trim().length > 0) {
          // Context keys (goal, taskDescription, etc.) are explicitly set by the
          // agent at session start -- return the full string without truncation.
          return val.trim();
        }
      }
    }
  }

  // 2. Extract first descriptive line from the root node's recap
  const title = extractTitleFromFirstRecap(sortedEvents);
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

/**
 * Extract the repo root path from session events.
 *
 * Priority:
 * 1. repo_root observation event -- written by the workspace anchor (LocalWorkspaceAnchorV2)
 *    at session start. Holds the actual git repo root, which may differ from workspacePath
 *    when the session was started from a subdirectory.
 * 2. workspacePath from an initial context_set event -- written by the daemon and dispatch
 *    handler as a fallback for sessions where workspace anchor resolution produced no anchors
 *    (e.g. non-git directories, git binary unavailable, or daemon using an older engine context
 *    without workspaceResolver). Close enough for workspace grouping in the console.
 *
 * Returns null only when neither source is available.
 */
function extractRepoRoot(events: readonly DomainEventV1[]): string | null {
  let workspacePathFallback: string | null = null;

  for (const e of events) {
    if (e.kind === EVENT_KIND.OBSERVATION_RECORDED && e.data.key === 'repo_root') {
      return e.data.value.value;
    }
    // Capture workspacePath from the initial context_set as a fallback.
    // Only 'initial' source context is used -- agent_delta context_set events may not
    // include workspacePath and would overwrite it with a different key set.
    if (
      e.kind === EVENT_KIND.CONTEXT_SET &&
      e.data.source === 'initial' &&
      workspacePathFallback === null
    ) {
      const ctx = e.data.context;
      if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
        const wp = (ctx as Record<string, unknown>)['workspacePath'];
        if (typeof wp === 'string' && wp.length > 0) {
          workspacePathFallback = wp;
        }
      }
    }
  }

  return workspacePathFallback;
}


function extractParentSessionId(events: readonly DomainEventV1[]): string | null {
  for (const e of events) {
    if (e.kind === EVENT_KIND.SESSION_CREATED) {
      const parentId = e.data.parentSessionId;
      if (typeof parentId === 'string' && parentId.length > 0) return parentId;
      return null;
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
  nowMs: number,
  precomputedDag?: RunDagProjectionV2,
  isLive = false,
): ConsoleSessionSummary | null {
  const { events } = truth;
  const health = projectSessionHealthV2(truth);
  if (health.isErr()) return null;

  const sessionHealth: ConsoleSessionHealth =
    health.value.kind === 'healthy' ? 'healthy' : 'corrupt';

  // Use a pre-computed DAG when available (threaded from loadSessionSummary) to
  // avoid a redundant projectRunDagV2 call on the same event array.
  let dag: RunDagProjectionV2 | null;
  if (precomputedDag !== undefined) {
    dag = precomputedDag;
  } else {
    const res = projectRunDagV2(events);
    dag = res.isOk() ? res.value : null;
  }
  if (dag === null) return null;

  // Validate sort order once; thread SortedEventLog through all projections and
  // deriveSessionTitle so no downstream call repeats the O(n) check.
  const sortedEventsRes = asSortedEventLog(events);
  const statusRes = sortedEventsRes.isOk() ? projectRunStatusSignalsV2(sortedEventsRes.value) : err(sortedEventsRes.error);
  const gapsRes = sortedEventsRes.isOk() ? projectGapsV2(sortedEventsRes.value) : err(sortedEventsRes.error);

  const sessionTitle = sortedEventsRes.isOk() ? deriveSessionTitle(sortedEventsRes.value) : null;
  const gitBranch = extractGitBranch(events);
  const repoRoot = extractRepoRoot(events);
  const parentSessionId = extractParentSessionId(events);

  // Derive isAutonomous from context_set events. Checks all runs; true if any run has
  // is_autonomous: 'true' in its context. Gracefully degrades to false on projection error.
  const isAutonomous = (() => {
    if (!sortedEventsRes.isOk()) return false;
    const contextRes = projectRunContextV2(sortedEventsRes.value);
    if (contextRes.isErr()) return false;
    return Object.values(contextRes.value.byRunId).some(
      (runCtx) => runCtx.context['is_autonomous'] === 'true',
    );
  })();

  const metrics = projectSessionMetricsV2(events);

  const runs = Object.values(dag.runsById);
  const run = runs[0];
  if (!run) {
    const noRunStatus: ConsoleSessionStatus =
      nowMs - lastModifiedMs > DORMANCY_THRESHOLD_MS ? 'dormant' : 'in_progress';
    return {
      sessionId,
      sessionTitle,
      workflowId: null,
      workflowName: null,
      workflowHash: null,
      runId: null,
      status: noRunStatus,
      health: sessionHealth,
      nodeCount: 0,
      edgeCount: 0,
      tipCount: 0,
      hasUnresolvedGaps: false,
      recapSnippet: null,
      gitBranch,
      repoRoot,
      lastModifiedMs,
      isAutonomous,
      isLive,
      parentSessionId,
      metrics,
    };
  }

  const workflow = run.workflow;
  const workflowId = workflow.kind === 'with_workflow' ? workflow.workflowId : null;
  const workflowHash = workflow.kind === 'with_workflow' ? workflow.workflowHash : null;
  const workflowName = workflowHash ? (workflowNames[workflowHash] ?? null) : null;

  const statusSignals = statusRes.isOk() ? statusRes.value.byRunId[run.runId] : undefined;
  const runStatus = deriveRunStatus(
    statusSignals?.isBlocked ?? false,
    statusSignals?.hasUnresolvedCriticalGaps ?? false,
    completionByRunId[run.runId] ?? false,
  );
  const status: ConsoleSessionStatus =
    runStatus === 'in_progress' && nowMs - lastModifiedMs > DORMANCY_THRESHOLD_MS
      ? 'dormant'
      : runStatus;

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
    repoRoot,
    lastModifiedMs,
    isAutonomous,
    isLive,
    parentSessionId,
    metrics,
  };
}

function projectSessionDetail(
  sessionId: SessionId,
  truth: LoadedSessionTruthV2,
  completionByRunId: RunCompletionMap,
  stepLabels: StepLabelMap,
  workflowNames: WorkflowNameMap,
  skippedStepsMap: SkippedStepsMap = {},
): ConsoleSessionDetail {
  const { events } = truth;
  const health = projectSessionHealthV2(truth);
  const sessionHealth: ConsoleSessionHealth =
    health.isOk() && health.value.kind === 'healthy' ? 'healthy' : 'corrupt';

  // Validate sort order once at the top; thread SortedEventLog through all
  // projections and deriveSessionTitle so no downstream call repeats the O(n) check.
  const sortedEventsRes = asSortedEventLog(events);
  const sessionTitle = sortedEventsRes.isOk() ? deriveSessionTitle(sortedEventsRes.value) : null;

  const dagRes = projectRunDagV2(events);
  if (dagRes.isErr()) {
    // metrics and repoRoot are null here as placeholders; the caller (getSessionDetail)
    // always overrides these with the actual computed values via spread.
    return { sessionId, sessionTitle, health: sessionHealth, runs: [], metrics: null, repoRoot: null };
  }

  const statusRes = sortedEventsRes.isOk() ? projectRunStatusSignalsV2(sortedEventsRes.value) : err(sortedEventsRes.error);
  const gapsRes = sortedEventsRes.isOk() ? projectGapsV2(sortedEventsRes.value) : err(sortedEventsRes.error);
  const executionTraceRes = projectRunExecutionTraceV2(events);

  // Richness projections -- used to populate summary boolean flags on each node.
  // All projections are called once here; per-node lookup is O(1) map access.
  const outputsRes = projectNodeOutputsV2(events);
  const artifactsRes = projectArtifactsV2(events);

  // Validations have no standalone projection; build a nodeId set in one pass.
  const failedValidationNodeIds = new Set<string>();
  for (const e of events) {
    if (e.kind !== EVENT_KIND.VALIDATION_PERFORMED) continue;
    if (!e.data.result.valid) {
      failedValidationNodeIds.add(e.scope.nodeId);
    }
  }

  // Build a per-node gap presence map from the gap projection (byGapId is the
  // only index; gaps store their nodeId directly).
  const gapNodeIds = new Set<string>();
  if (gapsRes.isOk()) {
    for (const gap of Object.values(gapsRes.value.byGapId)) {
      gapNodeIds.add(gap.nodeId);
    }
  }

  const runs: ConsoleDagRun[] = Object.values(dagRes.value.runsById).map((run) => {
    const statusSignals = statusRes.isOk() ? statusRes.value.byRunId[run.runId] : undefined;
    const status = deriveRunStatus(
      statusSignals?.isBlocked ?? false,
      statusSignals?.hasUnresolvedCriticalGaps ?? false,
      completionByRunId[run.runId] ?? false,
    );

    const tipSet = new Set(run.tipNodeIds);
    const nodes: ConsoleDagNode[] = Object.values(run.nodesById).map((node) => {
      const nodeOutputs = outputsRes.isOk() ? outputsRes.value.nodesById[node.nodeId] : undefined;
      const nodeArtifacts = artifactsRes.isOk() ? artifactsRes.value.byNodeId[node.nodeId] : undefined;
      return {
        nodeId: node.nodeId,
        nodeKind: node.nodeKind,
        parentNodeId: node.parentNodeId,
        createdAtEventIndex: node.createdAtEventIndex,
        isPreferredTip: node.nodeId === run.preferredTipNodeId,
        isTip: tipSet.has(node.nodeId),
        stepLabel: stepLabels[node.nodeId] ?? null,
        hasRecap: (nodeOutputs?.currentByChannel.recap.length ?? 0) > 0,
        hasFailedValidations: failedValidationNodeIds.has(node.nodeId),
        hasGaps: gapNodeIds.has(node.nodeId),
        hasArtifacts: (nodeArtifacts?.artifacts.length ?? 0) > 0,
      };
    });

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
      executionTraceSummary: executionTraceRes.isOk()
        ? (executionTraceRes.value.byRunId[run.runId] ?? null)
        : null,
      skippedSteps: skippedStepsMap[run.runId] ?? [],
    };
  });

  // metrics and repoRoot are null here as placeholders; the caller (getSessionDetail)
  // always overrides these with the actual computed values via spread.
  return { sessionId, sessionTitle, health: sessionHealth, runs, metrics: null, repoRoot: null };
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

  // Each call below is O(n-events). For sessions with large event logs, consider
  // caching projection results at the session level. Acceptable at current scale.
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
  const sortedEventsRes = asSortedEventLog(events);
  if (sortedEventsRes.isErr()) return [];
  const gapsRes = projectGapsV2(sortedEventsRes.value);
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
