/**
 * WorkTrain Overview Command  (`worktrain status`)
 *
 * Prints a plain-English overview of active and recently completed sessions.
 * Reads session data directly from ~/.workrail/data/sessions/ -- no daemon required.
 *
 * Design:
 * - Pure function: all I/O injected via WorktrainOverviewCommandDeps
 * - ConsoleService reads the same session files the console UI uses
 * - ACTIVE  = isComplete false  AND  lastModifiedMs within configurable threshold
 * - RECENT  = isComplete true   AND  lastModifiedMs within last 24 hours
 * - StatusDataPacket exported for reuse by the console landing view
 *
 * Follows the same pattern as worktrain-spawn.ts (pure executeXxx + injected deps).
 */

import { LocalDataDirV2 } from '../../v2/infra/local/data-dir/index.js';
import { LocalDirectoryListingV2 } from '../../v2/infra/local/directory-listing/index.js';
import { NodeFileSystemV2 } from '../../v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../../v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../v2/infra/local/pinned-workflow-store/index.js';
import { LocalSessionEventLogStoreV2 } from '../../v2/infra/local/session-store/index.js';
import { ConsoleService } from '../../v2/usecases/console-service.js';
import type { ConsoleSessionSummary } from '../../v2/usecases/console-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One session in the overview packet. Designed for reuse by the console
 * landing view -- do not change field names without updating the console.
 */
export interface StatusSession {
  readonly sessionId: string;
  readonly title: string;
  readonly status: 'active' | 'recent';
  /** The raw session status from the underlying session record (e.g. 'in_progress', 'blocked', 'dormant', 'complete'). */
  readonly rawStatus: string;
  /** Workflow step label, or step ID as fallback, or null if unavailable. */
  readonly stepLabel: string | null;
  /** Filesystem mtime of the session directory (epoch ms). */
  readonly lastModifiedMs: number;
  /** Whether the workflow run is complete. */
  readonly isComplete: boolean;
}

/**
 * Machine-readable output packet for `worktrain status --json`.
 * Exported for reuse by the console landing view.
 */
export interface StatusDataPacket {
  /** Epoch ms when this snapshot was taken. */
  readonly asOfMs: number;
  readonly activeSessions: readonly StatusSession[];
  readonly recentSessions: readonly StatusSession[];
  /** True when the data reflects last-known state (daemon not required). */
  readonly isDaemonless: true;
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface WorktrainOverviewCommandDeps {
  /**
   * Return the current epoch time in milliseconds.
   * Injected so tests can control "now".
   */
  readonly now: () => number;
  /**
   * Build and return a ConsoleService instance for the given data directory.
   * Injected so tests can substitute a fake service without hitting the filesystem.
   */
  readonly buildConsoleService: (dataDir: string) => ConsoleService;
  /** Return the home directory (used to resolve the default data directory). */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...parts: string[]) => string;
  /** Write a line to stdout. */
  readonly print: (line: string) => void;
  /**
   * Read the WORKRAIL_DATA_DIR env var. Returns undefined when not set.
   * Injected for testability.
   */
  readonly getDataDirEnv: () => string | undefined;
  /**
   * Read the contents of a file as a UTF-8 string. Returns '' on any error
   * (file not found, permission denied, etc.) so the caller can degrade
   * gracefully without branching on error kinds.
   *
   * WHY injected: keeps executeWorktrainOverviewCommand a pure function with
   * all I/O at the boundary. Enables unit tests without vi.mock.
   */
  readonly readEventLog: (filePath: string) => Promise<string>;
}

export interface WorktrainOverviewCommandOpts {
  /** Output raw JSON packet instead of human-readable text. */
  readonly json?: boolean;
  /** Filter sessions by workspace path prefix (reserved, not yet enforced in data). */
  readonly workspace?: string;
  /**
   * Milliseconds of inactivity before an in-progress session is no longer
   * considered "active". Default: 2 hours.
   */
  readonly activeThresholdMs?: number;
  /**
   * Milliseconds to look back for "recently completed" sessions.
   * Default: 24 hours.
   */
  readonly recentWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default active threshold: 2 hours. */
const DEFAULT_ACTIVE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/** Default recent window: 24 hours. */
const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Format an epoch ms delta as a human-readable "Xm ago" or "Xh ago" string.
 */
function formatRelativeTime(deltaMs: number): string {
  const totalMinutes = Math.floor(deltaMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format an epoch ms delta as "running Xm" or "running Xh" for active sessions.
 */
function formatRunningTime(deltaMs: number): string {
  const totalMinutes = Math.floor(deltaMs / 60_000);
  if (totalMinutes < 60) return `running ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `running ${hours}h`;
}

/**
 * Build a display title for a session: sessionTitle if available, workflowId as
 * fallback, or a truncated sessionId as last resort.
 */
function buildSessionTitle(s: ConsoleSessionSummary): string {
  if (s.sessionTitle && s.sessionTitle.trim().length > 0) {
    return s.sessionTitle.trim();
  }
  if (s.workflowName && s.workflowName.trim().length > 0) {
    return s.workflowName.trim();
  }
  if (s.workflowId && s.workflowId.trim().length > 0) {
    return s.workflowId.trim();
  }
  // Last resort: truncated session ID
  return String(s.sessionId).slice(0, 20) + '...';
}

/**
 * Get the human-readable step label from the session summary.
 * ConsoleSessionSummary does not carry a pendingStepId -- the preferred tip's
 * stepLabel is surfaced through the DAG node, which requires a full session detail
 * load. For the overview we have enough: the run status already encodes whether
 * the session is in_progress / complete, and the session title describes the task.
 *
 * We return null here; callers that want the step label should load session detail.
 * The StatusSession type keeps `stepLabel` for forward-compatibility once the
 * console integrates this command.
 */
function extractStepLabel(_s: ConsoleSessionSummary): string | null {
  return null;
}

/**
 * Parse today's daemon JSONL event log and return a human-readable "Daemon: ..." status line.
 *
 * Logic:
 * - Find the most recent `daemon_heartbeat` or `daemon_stopped` event.
 * - If `daemon_stopped` is most recent: "stopped gracefully (HH:MM:SS)" or "crashed (HH:MM:SS)"
 * - If `daemon_heartbeat` is most recent and < 90s ago: "running (last heartbeat Xs ago, N active sessions)"
 * - If `daemon_heartbeat` is most recent but >= 90s ago: "may have crashed (last heartbeat Xh ago)"
 * - If neither found: "no events today"
 *
 * WHY 90s staleness threshold: 3x the 30s heartbeat interval. One missed heartbeat is noise;
 * three consecutive misses indicates the daemon is likely no longer running.
 */
function parseDaemonStatusLine(nowMs: number, eventLogContent: string): string {
  let latestHeartbeat: { ts: number; activeSessions: number } | null = null;
  let latestStopped: { ts: number; reason: string } | null = null;

  for (const raw of eventLogContent.split('\n')) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // Skip malformed lines silently.
    }

    const kind = typeof obj['kind'] === 'string' ? obj['kind'] : '';
    const ts = typeof obj['ts'] === 'number' ? obj['ts'] : null;
    if (ts === null) continue;

    if (kind === 'daemon_heartbeat') {
      if (latestHeartbeat === null || ts > latestHeartbeat.ts) {
        const activeSessions = typeof obj['activeSessions'] === 'number' ? obj['activeSessions'] : 0;
        latestHeartbeat = { ts, activeSessions };
      }
    } else if (kind === 'daemon_stopped') {
      if (latestStopped === null || ts > latestStopped.ts) {
        const reason = typeof obj['reason'] === 'string' ? obj['reason'] : 'unknown';
        latestStopped = { ts, reason };
      }
    }
  }

  // Neither event found today.
  if (latestHeartbeat === null && latestStopped === null) {
    return 'Daemon: no events today';
  }

  // Determine which event is most recent.
  const heartbeatTs = latestHeartbeat?.ts ?? -Infinity;
  const stoppedTs = latestStopped?.ts ?? -Infinity;

  if (stoppedTs >= heartbeatTs && latestStopped !== null) {
    // Stopped event is most recent.
    const stoppedTime = new Date(latestStopped.ts).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    if (latestStopped.reason === 'graceful') {
      return `Daemon: stopped gracefully (${stoppedTime})`;
    }
    return `Daemon: crashed (${stoppedTime})`;
  }

  // Heartbeat event is most recent.
  if (latestHeartbeat !== null) {
    const agoMs = nowMs - latestHeartbeat.ts;
    if (agoMs < 90_000) {
      const agoSec = Math.round(agoMs / 1000);
      const sessions = latestHeartbeat.activeSessions;
      const sessionStr = sessions === 1 ? '1 active session' : `${sessions} active sessions`;
      return `Daemon: running (last heartbeat ${agoSec}s ago, ${sessionStr})`;
    }
    // Stale heartbeat -- daemon may have crashed.
    return `Daemon: may have crashed (last heartbeat ${formatRelativeTime(agoMs)})`;
  }

  return 'Daemon: no events today';
}

/**
 * True when a ConsoleSessionSummary represents a completed run.
 * Maps the ConsoleSessionStatus discriminated union explicitly.
 */
function isCompleted(s: ConsoleSessionSummary): boolean {
  return s.status === 'complete' || s.status === 'complete_with_gaps';
}

/**
 * True when a ConsoleSessionSummary represents an in-progress (or blocked/dormant) run.
 * We treat blocked/dormant as "still active" for the overview -- the user should know.
 */
function isInProgress(s: ConsoleSessionSummary): boolean {
  return s.status === 'in_progress' || s.status === 'blocked' || s.status === 'dormant';
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Execute the `worktrain status` overview command.
 *
 * Reads sessions directly from the filesystem via ConsoleService. Never connects
 * to the daemon or any HTTP server. Returns a CliResult for process lifecycle
 * management, but all user-visible output is written via deps.print().
 *
 * Errors from ConsoleService (e.g. sessions dir not found) are surfaced as
 * informational messages rather than hard failures -- an empty sessions directory
 * is a valid state for a fresh WorkTrain installation.
 */
export async function executeWorktrainOverviewCommand(
  deps: WorktrainOverviewCommandDeps,
  opts: WorktrainOverviewCommandOpts = {},
): Promise<void> {
  const nowMs = deps.now();
  const activeThresholdMs = opts.activeThresholdMs ?? DEFAULT_ACTIVE_THRESHOLD_MS;
  const recentWindowMs = opts.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;

  // Resolve data directory: WORKRAIL_DATA_DIR env var takes priority over default.
  const dataDir = deps.getDataDirEnv()
    ?? deps.joinPath(deps.homedir(), '.workrail', 'data');

  const consoleService = deps.buildConsoleService(dataDir);

  // Load session list. Gracefully degrade on error: show "no sessions" instead of
  // crashing. The overview is a convenience command; partial data is better than nothing.
  const sessionListResult = await consoleService.getSessionList();
  const sessions = sessionListResult.isOk() ? sessionListResult.value.sessions : [];

  // Classify sessions.
  const activeSessions: StatusSession[] = [];
  const recentSessions: StatusSession[] = [];

  for (const s of sessions) {
    const lastMod = s.lastModifiedMs;
    const age = nowMs - lastMod;

    if (isInProgress(s) && age <= activeThresholdMs) {
      activeSessions.push({
        sessionId: String(s.sessionId),
        title: buildSessionTitle(s),
        status: 'active',
        rawStatus: s.status,
        stepLabel: extractStepLabel(s),
        lastModifiedMs: lastMod,
        isComplete: false,
      });
    } else if (isCompleted(s) && age <= recentWindowMs) {
      recentSessions.push({
        sessionId: String(s.sessionId),
        title: buildSessionTitle(s),
        status: 'recent',
        rawStatus: s.status,
        stepLabel: extractStepLabel(s),
        lastModifiedMs: lastMod,
        isComplete: true,
      });
    }
  }

  // Sort: most-recent first within each bucket.
  activeSessions.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  recentSessions.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

  const packet: StatusDataPacket = {
    asOfMs: nowMs,
    activeSessions,
    recentSessions,
    isDaemonless: true,
  };

  if (opts.json) {
    deps.print(JSON.stringify(packet, null, 2));
    return;
  }

  // Read today's daemon event log for the Daemon: status line.
  // WHY async read before output: keeps all I/O at the top; the status line is
  // printed as part of the header section below.
  const todayDate = new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
  const eventLogPath = deps.joinPath(deps.homedir(), '.workrail', 'events', 'daemon', `${todayDate}.jsonl`);
  const eventLogContent = await deps.readEventLog(eventLogPath);
  const daemonStatusLine = parseDaemonStatusLine(nowMs, eventLogContent);

  // Human-readable output.
  const date = new Date(nowMs);
  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  deps.print(`WorkTrain  [${dateStr}  ${timeStr}]`);
  deps.print(daemonStatusLine);
  deps.print('Note: live session detection requires daemon (showing last-known state).');
  deps.print('');

  if (activeSessions.length === 0 && recentSessions.length === 0) {
    deps.print('No recent sessions. Run `worktrain daemon` to start.');
    return;
  }

  if (activeSessions.length > 0) {
    deps.print(`ACTIVE (${activeSessions.length} session${activeSessions.length !== 1 ? 's' : ''})`);
    for (const s of activeSessions) {
      const runningStr = formatRunningTime(nowMs - s.lastModifiedMs);
      deps.print(`  ${s.rawStatus}  ${s.title}`);
      if (s.stepLabel) {
        deps.print(`               Step -- ${s.stepLabel}  --  ${runningStr}`);
      } else {
        deps.print(`               ${runningStr}`);
      }
      deps.print('');
    }
  }

  if (recentSessions.length > 0) {
    deps.print(`RECENT (last 24h, ${recentSessions.length} completed)`);
    for (const s of recentSessions) {
      const agoStr = formatRelativeTime(nowMs - s.lastModifiedMs);
      deps.print(`  done  ${s.title}    ${agoStr}`);
    }
    deps.print('');
  }

  deps.print('Run `worktrain console` for full session details.');
}

// ---------------------------------------------------------------------------
// Factory: build real ConsoleService from data directory path
// ---------------------------------------------------------------------------

/**
 * Construct a ConsoleService that reads from the given data directory.
 * This is the real implementation used in the CLI composition root.
 * Tests inject their own fake via the deps interface.
 */
export function buildConsoleServiceFromDataDir(dataDir: string): ConsoleService {
  const envWithDataDir: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    WORKRAIL_DATA_DIR: dataDir,
  };

  const dataDirPort = new LocalDataDirV2(envWithDataDir);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const directoryListing = new LocalDirectoryListingV2(fsPort);
  const sessionStore = new LocalSessionEventLogStoreV2(dataDirPort, fsPort, sha256);
  const snapshotStore = new LocalSnapshotStoreV2(dataDirPort, fsPort, crypto);
  const pinnedWorkflowStore = new LocalPinnedWorkflowStoreV2(dataDirPort, fsPort);

  return new ConsoleService({
    directoryListing,
    dataDir: dataDirPort,
    sessionStore,
    snapshotStore,
    pinnedWorkflowStore,
    // daemonRegistry omitted: overview command never tracks live daemon heartbeats.
  });
}
