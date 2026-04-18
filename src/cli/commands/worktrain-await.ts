/**
 * WorkTrain Await Command
 *
 * Blocks until a set of WorkRail workflow sessions complete, then prints
 * structured JSON results to stdout.
 *
 * Usage:
 *   worktrain await --sessions <h1,h2,...> [--mode all|any] [--timeout 30m]
 *
 * Exit codes:
 *   0 -- all sessions succeeded (or any succeeded, when --mode any)
 *   1 -- any session failed, timed out, or was not found
 *
 * Design invariants:
 * - All I/O is injected via WorktrainAwaitCommandDeps. Zero direct fs/fetch imports.
 * - Only the JSON result is written to stdout. All other output goes to stderr.
 * - All failures are returned as CliResult failure variants -- never thrown.
 * - Default timeout matches WORKFLOW_TIMEOUT_MS (30m) in workflow-runner.ts.
 */

import type { CliResult } from '../types/cli-result.js';
import { failure, misuse } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface WorktrainAwaitCommandDeps {
  /** HTTP GET function. */
  readonly fetch: (url: string) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
  /** Read a file as UTF-8 string. Used for dashboard lock file port discovery. */
  readonly readFile: (path: string) => Promise<string>;
  /** Write a line to stdout (ONLY the JSON result). */
  readonly stdout: (line: string) => void;
  /** Write a line to stderr (progress, status updates). */
  readonly stderr: (line: string) => void;
  /** Return the current user's home directory. */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...paths: string[]) => string;
  /** Sleep for the given number of milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Return the current wall-clock time in milliseconds. */
  readonly now: () => number;
}

export interface WorktrainAwaitCommandOpts {
  /** Comma-separated list of session handles to wait for. */
  readonly sessions: string;
  /** Wait mode: 'all' (default) waits for all sessions; 'any' returns when first succeeds. */
  readonly mode?: 'all' | 'any';
  /**
   * Timeout duration string (e.g. "30m", "1h", "90s").
   * Default: "30m" (matches WORKFLOW_TIMEOUT_MS in workflow-runner.ts).
   * On timeout, all pending sessions are marked as timed out and exit code is 1.
   */
  readonly timeout?: string;
  /** Override the console HTTP server port. Default: auto-discover from lock file, then 3456. */
  readonly port?: number;
  /**
   * Poll interval in milliseconds. Default: 3000ms.
   * Exposed as an option to allow faster polling in tests.
   */
  readonly pollInterval?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Outcome of a single awaited session.
 *
 * - 'success'     -- session reached a terminal success state (complete / complete_with_gaps)
 * - 'failed'      -- session reached a terminal failure state (blocked)
 * - 'timeout'     -- wall-clock timeout elapsed while session was still running, OR session
 *                    status is 'dormant' (no activity for an extended period)
 * - 'not_found'   -- no session with this handle exists on the server (404)
 * - 'not_awaited' -- session was still running when --mode any fired because another session
 *                    succeeded; we stopped waiting before this session reached a terminal state.
 *                    NOT the same as 'timeout': the session was not stuck or slow, we simply
 *                    no longer needed it.
 */
export type SessionOutcome = 'success' | 'failed' | 'timeout' | 'not_found' | 'not_awaited';

export interface SessionResult {
  readonly handle: string;
  readonly outcome: SessionOutcome;
  /** The session status at completion time (from ConsoleSessionStatus). */
  readonly status: string | null;
  /** Wall-clock duration in milliseconds from await start to session completion. */
  readonly durationMs: number;
}

export interface AwaitResult {
  readonly results: readonly SessionResult[];
  readonly allSucceeded: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Default console HTTP server port. */
const DEFAULT_CONSOLE_PORT = 3456;

/**
 * Lock file names under ~/.workrail/, checked in priority order.
 *
 * daemon-console.lock: written by `worktrain console` (standalone console, preferred)
 * dashboard.lock:      written by the MCP server's HttpServer (legacy fallback)
 */
const LOCK_FILE_NAMES = ['daemon-console.lock', 'dashboard.lock'] as const;

/**
 * Default timeout: 30 minutes.
 * WHY 30m: matches WORKFLOW_TIMEOUT_MS in src/daemon/workflow-runner.ts.
 * A session that is running normally will complete or error within this window.
 * No infinite polling -- this prevents coordinator scripts from hanging forever
 * if a session gets stuck in_progress.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Poll interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

// ═══════════════════════════════════════════════════════════════════════════
// DURATION PARSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a duration string into milliseconds.
 *
 * Supported formats: "30m", "1h", "90s", "300" (bare integer = seconds).
 * Returns null if the string is not a valid duration.
 */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Bare integer: treat as seconds
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n > 0 ? n * 1000 : null;
  }

  const match = /^(\d+)(s|m|h)$/i.exec(trimmed);
  if (!match) return null;

  const n = parseInt(match[1] ?? '0', 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = (match[2] ?? '').toLowerCase();
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PORT DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

async function discoverConsolePort(
  deps: Pick<WorktrainAwaitCommandDeps, 'readFile' | 'homedir' | 'joinPath'>,
  portOverride?: number,
): Promise<number> {
  if (portOverride !== undefined && portOverride > 0) {
    return portOverride;
  }

  for (const lockFileName of LOCK_FILE_NAMES) {
    const lockPath = deps.joinPath(deps.homedir(), '.workrail', lockFileName);
    try {
      const raw = await deps.readFile(lockPath);
      const parsed = JSON.parse(raw) as { port?: unknown };
      if (typeof parsed.port === 'number' && parsed.port > 0) {
        return parsed.port;
      }
    } catch {
      // ENOENT or parse error -- try next lock file
    }
  }

  return DEFAULT_CONSOLE_PORT;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS MAPPING
// ═══════════════════════════════════════════════════════════════════════════

/** Terminal statuses from ConsoleSessionStatus. */
const TERMINAL_STATUSES = new Set(['complete', 'complete_with_gaps', 'blocked', 'dormant']);

/** Statuses that map to a successful outcome. */
const SUCCESS_STATUSES = new Set(['complete', 'complete_with_gaps']);

/** Map a ConsoleSessionStatus to a SessionOutcome. Returns null if still in progress. */
function statusToOutcome(status: string): SessionOutcome | null {
  if (!TERMINAL_STATUSES.has(status)) return null;
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (status === 'blocked') return 'failed';
  // dormant = no activity for a long time = effectively timed out
  return 'timeout';
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION STATUS POLL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Poll GET /api/v2/sessions/:sessionId for a single session.
 *
 * Returns:
 * - `{ outcome, status }` when the session is in a terminal state
 * - `null` when the session is still in progress
 * - `{ outcome: 'not_found', status: null }` when the session does not exist (404)
 * - throws on unexpected HTTP errors (caller handles)
 */
async function pollSession(
  sessionHandle: string,
  port: number,
  deps: Pick<WorktrainAwaitCommandDeps, 'fetch'>,
): Promise<{ outcome: SessionOutcome; status: string | null } | null> {
  const url = `http://127.0.0.1:${port}/api/v2/sessions/${encodeURIComponent(sessionHandle)}`;
  const response = await deps.fetch(url);

  if (response.status === 404) {
    return { outcome: 'not_found', status: null };
  }

  if (!response.ok) {
    // Unexpected error -- let the caller handle it
    throw new Error(`Unexpected HTTP ${response.status} polling session ${sessionHandle}`);
  }

  const body = await response.json() as Record<string, unknown>;
  if (!body['success']) {
    return { outcome: 'not_found', status: null };
  }

  // Extract status from the session detail.
  // ConsoleSessionDetail: { sessionId, sessionTitle, health, runs: ConsoleDagRun[] }
  // We use the first run's status (most recent run in a session).
  const data = body['data'] as Record<string, unknown> | undefined;
  if (!data) return null;

  // Try ConsoleSessionDetail path (GET /api/v2/sessions/:id)
  const runs = data['runs'];
  if (Array.isArray(runs) && runs.length > 0) {
    const firstRun = runs[0] as Record<string, unknown>;
    const runStatus = typeof firstRun['status'] === 'string' ? firstRun['status'] : null;
    if (runStatus !== null) {
      const outcome = statusToOutcome(runStatus);
      if (outcome !== null) {
        return { outcome, status: runStatus };
      }
      // in_progress or unknown -- still running
      return null;
    }
  }

  // Try ConsoleSessionSummary path (from list endpoint -- fallback)
  const summaryStatus = typeof data['status'] === 'string' ? data['status'] : null;
  if (summaryStatus !== null) {
    const outcome = statusToOutcome(summaryStatus);
    if (outcome !== null) {
      return { outcome, status: summaryStatus };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the worktrain await command.
 *
 * On completion: writes the JSON result to stdout and returns success (exit 0)
 * if all sessions succeeded, or failure (exit 1) if any failed/timed out.
 */
export async function executeWorktrainAwaitCommand(
  deps: WorktrainAwaitCommandDeps,
  opts: WorktrainAwaitCommandOpts,
): Promise<CliResult> {
  // ---- Validate inputs ----
  const rawSessions = opts.sessions.trim();
  if (!rawSessions) {
    return misuse('--sessions is required and must not be empty.');
  }

  const handles = rawSessions
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  if (handles.length === 0) {
    return misuse('--sessions must contain at least one session handle.');
  }

  const mode = opts.mode ?? 'all';
  if (mode !== 'all' && mode !== 'any') {
    return misuse(`--mode must be 'all' or 'any', got: ${mode}`);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (opts.timeout !== undefined) {
    const parsed = parseDurationMs(opts.timeout);
    if (parsed === null) {
      return misuse(
        `--timeout must be a duration like '30m', '1h', '90s', got: ${opts.timeout}`,
      );
    }
    timeoutMs = parsed;
  }

  const pollInterval = opts.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;

  // ---- Port discovery ----
  const port = await discoverConsolePort(deps, opts.port);
  deps.stderr(`Awaiting ${handles.length} session(s) on port ${port} (mode: ${mode}, timeout: ${timeoutMs / 1000}s)...`);

  // ---- Poll loop ----
  const startMs = deps.now();
  const pending = new Set(handles);
  const results = new Map<string, SessionResult>();

  while (pending.size > 0) {
    // Check timeout
    const elapsed = deps.now() - startMs;
    if (elapsed >= timeoutMs) {
      for (const handle of pending) {
        results.set(handle, {
          handle,
          outcome: 'timeout',
          status: null,
          durationMs: deps.now() - startMs,
        });
      }
      pending.clear();
      deps.stderr(`Timeout reached after ${Math.round(elapsed / 1000)}s.`);
      break;
    }

    // Poll all pending sessions
    for (const handle of [...pending]) {
      let pollResult: { outcome: SessionOutcome; status: string | null } | null;
      try {
        pollResult = await pollSession(handle, port, deps);
      } catch (err) {
        // Unexpected HTTP error -- treat as failed for this session
        const message = err instanceof Error ? err.message : String(err);
        deps.stderr(`Warning: error polling session ${handle}: ${message}`);
        results.set(handle, {
          handle,
          outcome: 'failed',
          status: null,
          durationMs: deps.now() - startMs,
        });
        pending.delete(handle);
        continue;
      }

      if (pollResult !== null) {
        results.set(handle, {
          handle,
          outcome: pollResult.outcome,
          status: pollResult.status,
          durationMs: deps.now() - startMs,
        });
        pending.delete(handle);
        deps.stderr(
          `Session ${handle}: ${pollResult.outcome} (status: ${pollResult.status ?? 'n/a'})`,
        );

        // For --mode any: if first success found, mark remaining as not yet complete
        if (mode === 'any' && pollResult.outcome === 'success') {
          // Fill remaining pending with 'not_awaited' -- they were still running when we
          // stopped waiting, not timed out. Using 'timeout' here would conflate "session was
          // still running when we decided to stop" with "session actually hit the time limit".
          for (const remaining of pending) {
            results.set(remaining, {
              handle: remaining,
              outcome: 'not_awaited',
              status: null,
              durationMs: deps.now() - startMs,
            });
          }
          pending.clear();
          break;
        }
      }
    }

    if (pending.size > 0) {
      deps.stderr(`${pending.size} session(s) still running... (${Math.round((deps.now() - startMs) / 1000)}s elapsed)`);
      await deps.sleep(pollInterval);
    }
  }

  // ---- Build result ----
  const resultArray: SessionResult[] = handles.map((handle) => {
    return (
      results.get(handle) ?? {
        handle,
        outcome: 'not_found' as SessionOutcome,
        status: null,
        durationMs: deps.now() - startMs,
      }
    );
  });

  const allSucceeded =
    mode === 'all'
      ? resultArray.every((r) => r.outcome === 'success')
      : resultArray.some((r) => r.outcome === 'success');

  const awaitResult: AwaitResult = {
    results: resultArray,
    allSucceeded,
  };

  // ---- Write JSON to stdout (only stdout output) ----
  deps.stdout(JSON.stringify(awaitResult, null, 2));

  if (!allSucceeded) {
    return failure(
      'One or more sessions did not succeed.',
      { exitCode: { kind: 'general_error' } },
    );
  }

  return { kind: 'success' };
}
