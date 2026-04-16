/**
 * WorkTrain Spawn Command
 *
 * Starts a WorkRail workflow session non-interactively and prints the session
 * handle (session ID) to stdout immediately.
 *
 * Usage:
 *   worktrain spawn --workflow <id> --goal <text> --workspace <path>
 *
 * Design invariants:
 * - All I/O is injected via WorktrainSpawnCommandDeps. Zero direct fs/fetch imports.
 * - Only the session handle is written to stdout. All other output goes to stderr.
 * - All failures are returned as CliResult failure variants -- never thrown.
 * - Port discovery reads ~/.workrail/dashboard.lock first; falls back to --port or 3456.
 */

import type { CliResult } from '../types/cli-result.js';
import { failure, misuse } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface WorktrainSpawnCommandDeps {
  /**
   * HTTP POST function. Returns a minimal response shape so tests can inject fakes.
   * The real implementation uses globalThis.fetch or node:fetch.
   */
  readonly fetch: (
    url: string,
    opts: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
  /** Read a file as UTF-8 string. Used for dashboard lock file port discovery. */
  readonly readFile: (path: string) => Promise<string>;
  /** Write a line to stdout (ONLY the session handle). */
  readonly stdout: (line: string) => void;
  /** Write a line to stderr (progress, errors, warnings). */
  readonly stderr: (line: string) => void;
  /** Return the current user's home directory. */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...paths: string[]) => string;
  /** Return true if the path is absolute. */
  readonly pathIsAbsolute: (p: string) => boolean;
  /** Stat a path and return whether it is a directory. Throws on ENOENT. */
  readonly statPath: (p: string) => Promise<{ isDirectory: () => boolean }>;
}

export interface WorktrainSpawnCommandOpts {
  /** Workflow ID to run. */
  readonly workflow: string;
  /** One-sentence goal for the workflow session. */
  readonly goal: string;
  /** Absolute path to the workspace directory. */
  readonly workspace: string;
  /** Override the console HTTP server port. Default: auto-discover from lock file, then 3456. */
  readonly port?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Default console HTTP server port (matches HttpServer.ts default). */
const DEFAULT_CONSOLE_PORT = 3456;

/** Lock file name under ~/.workrail/. Contains running server port. */
const LOCK_FILE_NAME = 'dashboard.lock';

// ═══════════════════════════════════════════════════════════════════════════
// PORT DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Discover the console HTTP server port.
 *
 * Priority:
 * 1. Explicit --port flag (caller-provided override)
 * 2. Port from ~/.workrail/dashboard.lock (running server)
 * 3. Default: 3456
 *
 * The lock file is JSON: { pid, port, startedAt, ... }. If absent or
 * unparseable, falls back silently to the default port.
 */
async function discoverConsolePort(
  deps: Pick<WorktrainSpawnCommandDeps, 'readFile' | 'homedir' | 'joinPath'>,
  portOverride?: number,
): Promise<number> {
  if (portOverride !== undefined && portOverride > 0) {
    return portOverride;
  }

  const lockPath = deps.joinPath(deps.homedir(), '.workrail', LOCK_FILE_NAME);
  try {
    const raw = await deps.readFile(lockPath);
    const parsed = JSON.parse(raw) as { port?: unknown };
    if (typeof parsed.port === 'number' && parsed.port > 0) {
      return parsed.port;
    }
  } catch {
    // ENOENT or parse error -- fall through to default
  }

  return DEFAULT_CONSOLE_PORT;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the worktrain spawn command.
 *
 * On success: writes the session handle to stdout and returns success.
 * On error: returns failure with a descriptive message (nothing written to stdout).
 */
export async function executeWorktrainSpawnCommand(
  deps: WorktrainSpawnCommandDeps,
  opts: WorktrainSpawnCommandOpts,
): Promise<CliResult> {
  // ---- Validate inputs at the boundary ----
  const workflowId = opts.workflow.trim();
  if (!workflowId) {
    return misuse('--workflow is required and must not be empty.');
  }

  const goal = opts.goal.trim();
  if (!goal) {
    return misuse('--goal is required and must not be empty.');
  }

  const workspace = opts.workspace.trim();
  if (!workspace) {
    return misuse('--workspace is required and must not be empty.');
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

  // ---- Port discovery ----
  const port = await discoverConsolePort(deps, opts.port);
  const url = `http://127.0.0.1:${port}/api/v2/auto/dispatch`;

  deps.stderr(`Dispatching workflow '${workflowId}' to daemon at port ${port}...`);

  // ---- HTTP dispatch ----
  let responseBody: unknown;
  try {
    const response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, goal, workspacePath: workspace }),
    });

    responseBody = await response.json();

    if (!response.ok) {
      const errorMsg = isErrorResponse(responseBody)
        ? responseBody.error
        : `HTTP ${response.status}`;
      if (response.status === 503) {
        return failure(
          `WorkTrain daemon is not ready: ${errorMsg}\n` +
          'Ensure the daemon is running with: worktrain daemon',
        );
      }
      return failure(`Dispatch failed: ${errorMsg}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isConnectionRefused =
      message.includes('ECONNREFUSED') ||
      message.includes('fetch failed') ||
      message.includes('connect ECONNREFUSED');
    if (isConnectionRefused) {
      return failure(
        `Could not connect to WorkTrain daemon on port ${port}.\n` +
        'Ensure the daemon is running with: worktrain daemon\n' +
        `If the daemon is running on a different port, use: --port <n>`,
      );
    }
    return failure(`Dispatch request failed: ${message}`);
  }

  // ---- Extract session handle ----
  if (!isSuccessResponse(responseBody)) {
    const errorMsg = isErrorResponse(responseBody)
      ? responseBody.error
      : 'unexpected response shape';
    return failure(`Dispatch failed: ${errorMsg}`);
  }

  const sessionHandle = responseBody.data.sessionHandle;
  if (typeof sessionHandle !== 'string' || !sessionHandle) {
    return failure('Dispatch succeeded but no session handle was returned. Is the daemon up to date?');
  }

  // ---- Write handle to stdout (only stdout output) ----
  deps.stdout(sessionHandle);

  return { kind: 'success' };
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPE GUARDS
// ═══════════════════════════════════════════════════════════════════════════

function isSuccessResponse(
  body: unknown,
): body is { success: true; data: { sessionHandle: unknown; workflowId: unknown } } {
  return (
    body !== null &&
    typeof body === 'object' &&
    (body as Record<string, unknown>)['success'] === true &&
    typeof (body as Record<string, unknown>)['data'] === 'object'
  );
}

function isErrorResponse(body: unknown): body is { success: false; error: string } {
  return (
    body !== null &&
    typeof body === 'object' &&
    (body as Record<string, unknown>)['success'] === false &&
    typeof (body as Record<string, unknown>)['error'] === 'string'
  );
}
