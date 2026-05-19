/**
 * WorkTrain dispatch command.
 *
 * Manually dispatches a workflow session via the running daemon.
 * Replaces `worktrain spawn`, `worktrain run pipeline`, and
 * `worktrain run pr-review --pr <n>`.
 *
 * Usage:
 *   worktrain dispatch <task> -w <workspace>
 *   worktrain dispatch <task> --workflow <id> -w <workspace>
 *   worktrain dispatch --pr <n> -w <workspace>
 *   worktrain dispatch <task> --wait -w <workspace>
 *   worktrain dispatch <task> --json -w <workspace>
 *
 * Design invariants:
 * - All I/O is injected via WorktrainDispatchCommandDeps. Zero direct fs/fetch imports.
 * - Only the session ID is written to stdout (without --json). All other output to stderr.
 * - With --json: outputs {"sessionId":"..."} on dispatch, or {"sessionId":"...","outcome":"...","detail":"..."} when --wait.
 * - dispatch ALWAYS routes through the daemon HTTP. No in-process fallback.
 *   If the daemon is not running, exit 1 with a clear actionable message.
 * - --wait: polls parseDaemonEvents at 5s intervals (2s initial delay for session_started).
 *   Exit 0=success, 1=failure/stuck, 2=timed out before terminal event.
 * - --pr routes to wr.mr-review workflow for that PR number.
 * - --workflow overrides adaptive routing.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure, misuse } from '../types/cli-result.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktrainDispatchCommandDeps {
  /** HTTP POST function for daemon dispatch. */
  readonly fetch: (
    url: string,
    opts: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
  /** Read a file as UTF-8 string (for port discovery and --wait polling). */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Write the session ID to stdout. */
  readonly stdout: (line: string) => void;
  /** Write progress/errors to stderr. */
  readonly stderr: (line: string) => void;
  /** Return the current user's home directory. */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...paths: string[]) => string;
  /** Return true if the path is absolute. */
  readonly pathIsAbsolute: (p: string) => boolean;
  /** Stat a path; throws on ENOENT. */
  readonly statPath: (p: string) => Promise<{ isDirectory: () => boolean }>;
  /** Sleep for ms milliseconds (for --wait polling). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Timestamp in ms (for --wait timeout). Default: Date.now */
  readonly now?: () => number;
}

export interface WorktrainDispatchCommandOpts {
  /** Free-text task description for adaptive routing. */
  readonly task?: string;
  /** Explicit workflow ID -- overrides adaptive routing. */
  readonly workflow?: string;
  /** PR number -- dispatches wr.mr-review for this PR. */
  readonly pr?: number;
  /** Absolute path to the workspace directory. */
  readonly workspace: string;
  /** Block until the session reaches a terminal state. */
  readonly wait?: boolean;
  /** Emit machine-readable JSON to stdout. */
  readonly json?: boolean;
  /** Override the daemon HTTP port. */
  readonly port?: number;
  /** Wait timeout in ms. Default: 30 minutes. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONSOLE_PORT = 3456;
const LOCK_FILE_NAMES = ['daemon-console.lock', 'dashboard.lock'] as const;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INITIAL_DELAY_MS = 2_000;
const POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Port discovery (same pattern as worktrain-spawn.ts)
// ---------------------------------------------------------------------------

async function discoverDaemonPort(
  deps: Pick<WorktrainDispatchCommandDeps, 'readFile' | 'homedir' | 'joinPath'>,
  portOverride?: number,
): Promise<number> {
  if (portOverride !== undefined && portOverride > 0) return portOverride;

  for (const lockFileName of LOCK_FILE_NAMES) {
    const lockPath = deps.joinPath(deps.homedir(), '.workrail', lockFileName);
    try {
      const raw = await deps.readFile(lockPath);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { port?: unknown };
      if (typeof parsed.port === 'number' && parsed.port > 0) return parsed.port;
    } catch {
      // ENOENT or parse error -- try next
    }
  }
  return DEFAULT_CONSOLE_PORT;
}

// ---------------------------------------------------------------------------
// Outcome polling for --wait (reads daemon event log files)
// ---------------------------------------------------------------------------

type SessionOutcome = 'success' | 'failure' | 'timeout_waiting';

async function pollForOutcome(
  deps: Pick<WorktrainDispatchCommandDeps, 'readFile' | 'homedir' | 'joinPath' | 'sleep' | 'stderr' | 'now'>,
  sessionId: string,
  timeoutMs: number,
): Promise<SessionOutcome> {
  const nowFn = deps.now ?? Date.now;
  const deadline = nowFn() + timeoutMs;
  const eventsDir = deps.joinPath(deps.homedir(), '.workrail', 'events', 'daemon');

  // Initial delay: the daemon may not have written session_started yet.
  await deps.sleep(POLL_INITIAL_DELAY_MS);

  while (nowFn() < deadline) {
    const outcome = await checkOutcome(deps, eventsDir, sessionId);
    if (outcome !== null) return outcome;

    const remaining = deadline - nowFn();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return 'timeout_waiting';
}

async function checkOutcome(
  deps: Pick<WorktrainDispatchCommandDeps, 'readFile' | 'joinPath'>,
  eventsDir: string,
  sessionId: string,
): Promise<'success' | 'failure' | null> {
  // Scan last 2 days (session spanning midnight is unlikely for --wait use case).
  const now = Date.now();
  for (let i = 0; i < 2; i++) {
    const date = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const filePath = deps.joinPath(eventsDir, `${date}.jsonl`);
    const content = await deps.readFile(filePath);
    if (!content) continue;

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event['sessionId'] !== sessionId) continue;
      if (event['kind'] !== 'session_completed' && event['kind'] !== 'session_aborted') continue;

      const outcome = event['outcome'];
      if (outcome === 'success') return 'success';
      return 'failure';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main command execution
// ---------------------------------------------------------------------------

/**
 * Execute the worktrain dispatch command.
 *
 * On success without --wait: writes session ID to stdout, returns success.
 * On success with --wait: writes session outcome to stdout (--json) or stderr.
 * On error: returns failure with actionable message.
 */
export async function executeWorktrainDispatchCommand(
  deps: WorktrainDispatchCommandDeps,
  opts: WorktrainDispatchCommandOpts,
): Promise<CliResult> {
  // ---- Validate workspace ----
  const workspace = opts.workspace.trim();
  if (!workspace) {
    return misuse('-w/--workspace is required and must not be empty.');
  }
  if (!deps.pathIsAbsolute(workspace)) {
    return misuse(`--workspace must be an absolute path, got: ${workspace}`);
  }
  try {
    const stat = await deps.statPath(workspace);
    if (!stat.isDirectory()) {
      return failure(`--workspace must be an existing directory: ${workspace}`);
    }
  } catch {
    return failure(`--workspace does not exist: ${workspace}`);
  }

  // ---- Resolve workflow ID and goal ----
  let workflowId: string | undefined;
  let goal: string;

  if (opts.pr !== undefined) {
    // PR dispatch: route to wr.mr-review
    workflowId = 'wr.mr-review';
    goal = `Review PR #${opts.pr}`;
  } else if (opts.workflow) {
    // Explicit workflow override
    workflowId = opts.workflow.trim();
    goal = opts.task?.trim() ?? `Run ${workflowId}`;
  } else if (opts.task?.trim()) {
    // Adaptive routing: no workflowId, let the daemon decide
    goal = opts.task.trim();
  } else {
    return misuse('Provide a <task> description, --workflow <id>, or --pr <n>.');
  }

  // ---- Port discovery + HTTP dispatch ----
  const port = await discoverDaemonPort(deps, opts.port);
  const url = `http://127.0.0.1:${port}/api/v2/auto/dispatch`;

  deps.stderr(`Dispatching to daemon at port ${port}...`);

  let responseBody: unknown;
  try {
    const body: Record<string, unknown> = { goal, workspacePath: workspace };
    if (workflowId) body['workflowId'] = workflowId;
    if (opts.pr !== undefined) body['context'] = { prNumber: opts.pr };

    const response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    responseBody = await response.json();

    if (!response.ok) {
      const errMsg = isErrorResponse(responseBody)
        ? responseBody.error
        : `HTTP ${response.status}`;
      if (response.status === 503 || response.status === 0) {
        return failure(
          `Daemon is not running. Start it with: worktrain daemon start\n` +
          `(tried port ${port})`,
        );
      }
      if (response.status === 503) {
        return failure(`WorkTrain daemon is not ready: ${errMsg}`);
      }
      return failure(`Dispatch failed: ${errMsg}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return failure(
        `Daemon is not running. Start it with: worktrain daemon start\n` +
        `(tried port ${port})`,
      );
    }
    return failure(`Dispatch request failed: ${msg}`);
  }

  // ---- Extract session ID from response ----
  const data = isDataResponse(responseBody) ? responseBody.data : null;
  const sessionId = typeof (data as Record<string, unknown>)?.['sessionHandle'] === 'string'
    ? (data as Record<string, unknown>)['sessionHandle'] as string
    : null;

  if (!sessionId) {
    return failure('Dispatch succeeded but no session ID was returned.');
  }

  // ---- Without --wait: print session ID and return ----
  if (!opts.wait) {
    if (opts.json) {
      deps.stdout(JSON.stringify({ sessionId }));
    } else {
      deps.stdout(sessionId);
    }
    return success({ message: `Session dispatched: ${sessionId}` });
  }

  // ---- With --wait: poll for terminal state ----
  deps.stderr(`Waiting for session ${sessionId} to complete...`);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outcome = await pollForOutcome(deps, sessionId, timeoutMs);

  if (opts.json) {
    const jsonOutcome = outcome === 'timeout_waiting' ? 'timeout' : outcome;
    deps.stdout(JSON.stringify({ sessionId, outcome: jsonOutcome }));
  } else {
    deps.stderr(`Session ${sessionId}: ${outcome}`);
  }

  if (outcome === 'success') {
    return success({ message: `Session ${sessionId} completed successfully.` });
  } else if (outcome === 'timeout_waiting') {
    // Exit code 2 for timeout_waiting -- distinguish from session failure (exit 1).
    // The CliResult 'failure' kind maps to exit 1; we need a way to signal exit 2.
    // Use failure with a sentinel prefix that interpretCliResultWithoutDI can detect.
    // WHY sentinel: CliResult has two failure kinds; adding a third is scope creep.
    // The caller (cli-worktrain.ts action) checks the message and exits 2 directly.
    return failure(`__exit2__ Session ${sessionId} timed out waiting for terminal state.`);
  } else {
    return failure(`Session ${sessionId} ended with outcome: ${outcome}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isErrorResponse(body: unknown): body is { error: string } {
  return typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['error'] === 'string';
}

function isDataResponse(body: unknown): body is { data: unknown } {
  return typeof body === 'object' && body !== null && 'data' in (body as object);
}
