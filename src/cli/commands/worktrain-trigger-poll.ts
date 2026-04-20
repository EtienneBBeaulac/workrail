/**
 * WorkTrain Trigger Poll Command
 *
 * `worktrain trigger poll <triggerId>` -- force an immediate poll cycle on a
 * github_queue_poll trigger, without waiting for the configured interval.
 *
 * Design invariants:
 * - All I/O is injected via WorktrainTriggerPollDeps. Zero direct fs/fetch imports.
 * - All failures are returned as CliResult -- never thrown.
 * - Port discovery reads daemon-console.lock, defaults to 3200 per spec.
 * - The CLI fetch has a 30s timeout to prevent hanging when the poll cycle is slow.
 * - Prints [Poll] progress lines to stdout; errors to stderr.
 */

import type { CliResult } from '../types/cli-result.js';
import { failure, success } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Injected dependencies for the trigger poll command.
 * All real I/O is behind these interfaces for full testability.
 */
export interface WorktrainTriggerPollDeps {
  /**
   * HTTP POST function.
   * WHY injectable: allows tests to inject fake responses without real HTTP.
   */
  readonly fetch: (
    url: string,
    opts: { method: string; signal?: AbortSignal },
  ) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
  /** Read a file as UTF-8 string. Used for daemon-console.lock port discovery. */
  readonly readFile: (path: string) => Promise<string>;
  /** Write a line to stdout (progress and results). */
  readonly print: (line: string) => void;
  /** Write a line to stderr (errors and warnings). */
  readonly stderr: (line: string) => void;
  /** Return the current user's home directory. */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...paths: string[]) => string;
}

export interface WorktrainTriggerPollOpts {
  /** The trigger ID to poll (e.g. 'self-improvement'). */
  readonly triggerId: string;
  /** Override the console HTTP server port. Default: auto-discover from lock file, then 3200. */
  readonly port?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default console HTTP server port when lock file is absent.
 *
 * WHY 3200: the spec states "defaults to 3200" for trigger commands.
 * In practice, the daemon console writes daemon-console.lock (port 3456),
 * and lock-file discovery returns 3456. 3200 is the final fallback only.
 */
const DEFAULT_POLL_PORT = 3200;

/**
 * Lock file names under ~/.workrail/, checked in priority order.
 * daemon-console.lock is written by the daemon console at port 3456.
 */
const LOCK_FILE_NAMES = ['daemon-console.lock', 'dashboard.lock'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// PORT DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Discover the console HTTP server port.
 *
 * Priority:
 * 1. Explicit --port flag (caller-provided override)
 * 2. Port from ~/.workrail/daemon-console.lock (daemon console)
 * 3. Port from ~/.workrail/dashboard.lock (MCP server, legacy)
 * 4. Default: 3200 (spec requirement for trigger commands)
 */
async function discoverConsolePort(
  deps: Pick<WorktrainTriggerPollDeps, 'readFile' | 'homedir' | 'joinPath'>,
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

  return DEFAULT_POLL_PORT;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the worktrain trigger poll command.
 *
 * On success: prints cycle result and returns success (exit 0).
 * On error: returns failure with a descriptive message (exit 1).
 */
export async function executeWorktrainTriggerPollCommand(
  deps: WorktrainTriggerPollDeps,
  opts: WorktrainTriggerPollOpts,
): Promise<CliResult> {
  const triggerId = opts.triggerId.trim();
  if (!triggerId) {
    deps.stderr('[Poll] Error: triggerId must not be empty.');
    return failure('triggerId must not be empty.');
  }

  const port = await discoverConsolePort(deps, opts.port);
  const url = `http://127.0.0.1:${port}/api/v2/triggers/${encodeURIComponent(triggerId)}/poll`;

  deps.print(`[Poll] Forcing immediate poll cycle for trigger: ${triggerId}`);

  let responseBody: unknown;
  try {
    const response = await deps.fetch(url, {
      method: 'POST',
      // WHY 30s timeout: poll cycles involve GitHub API calls and can take several seconds.
      // Without a timeout, the CLI would hang indefinitely if the cycle stalls.
      signal: AbortSignal.timeout(30_000),
    });

    responseBody = await response.json();

    if (!response.ok) {
      const errMsg = typeof (responseBody as Record<string, unknown>)['error'] === 'string'
        ? (responseBody as Record<string, unknown>)['error'] as string
        : `HTTP ${response.status}`;
      deps.stderr(`[Poll] Error: ${errMsg}`);
      return failure(errMsg);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
    const isTimeout = e instanceof Error && e.name === 'TimeoutError';

    if (isConnRefused) {
      deps.stderr(
        `[Poll] Error: Could not connect to WorkTrain daemon on port ${port}. ` +
        `Ensure the daemon is running with: worktrain daemon`,
      );
      return failure(`Could not connect to daemon on port ${port}`);
    }
    if (isTimeout) {
      deps.stderr(`[Poll] Error: Request timed out after 30s. The poll cycle may still be running.`);
      return failure('Request timed out after 30s');
    }
    deps.stderr(`[Poll] Error: ${msg}`);
    return failure(msg);
  }

  // Parse and print the response
  const body = responseBody as Record<string, unknown>;
  const data = body['data'] as Record<string, unknown> | undefined;

  if (data !== undefined) {
    const cycleRan = data['cycleRan'];
    const message = typeof data['message'] === 'string' ? data['message'] : '';
    if (cycleRan === true) {
      deps.print(`[Poll] ${message || 'Poll cycle started.'}`);
    } else {
      deps.print(`[Poll] ${message || 'Poll cycle skipped (previous cycle still running).'}`);
    }
  }

  deps.print('[Poll] Done.');
  return success();
}
