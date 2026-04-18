/**
 * WorkTrain Console Command
 *
 * Starts a standalone HTTP server that serves the WorkRail console UI.
 * Reads session state directly from the filesystem via file-watching.
 * Zero coupling to the daemon or MCP server -- works whether they run or not.
 *
 * Design invariants:
 * - All I/O is injected via WorktrainConsoleCommandDeps. No direct fs/http imports.
 * - No lock file, no port election, no primary/secondary pattern.
 * - File-watching drives SSE push to the browser (same latency as today).
 * - Returns when the server binds successfully; the caller keeps the process alive.
 * - Returns a stop handle so the caller can clean up on SIGINT/SIGTERM.
 *
 * Usage:
 *   worktrain console                      # default port 3456
 *   worktrain console --port 4000          # custom port
 *   worktrain console --workspace ~/proj   # workspace-scoped view (future)
 */

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface WorktrainConsoleCommandDeps {
  /** Absolute path to the user home directory. */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...paths: string[]) => string;
  /** Start the console HTTP server with the given options. Returns a start outcome. */
  readonly startConsole: (opts: ConsoleStartOpts) => Promise<ConsoleStartOutcome>;
  /** Write a line to stdout. */
  readonly stdout: (line: string) => void;
  /** Write a line to stderr. */
  readonly stderr: (line: string) => void;
}

export interface ConsoleStartOpts {
  readonly port: number;
  readonly dataDir: string;
  readonly lockFilePath: string;
}

export interface ConsoleStartResult {
  readonly kind: 'ok';
  readonly port: number;
  readonly stop: () => Promise<void>;
}

export type ConsoleStartError =
  | { readonly kind: 'port_conflict'; readonly port: number }
  | { readonly kind: 'io_error'; readonly message: string };

export type ConsoleStartOutcome =
  | ConsoleStartResult
  | { readonly kind: 'port_conflict'; readonly port: number }
  | { readonly kind: 'io_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorktrainConsoleCommandOpts {
  /** Port to bind the console server. Default: 3456. */
  readonly port?: number;
  /** Workspace path for scoped view (optional, not yet used for filtering). */
  readonly workspace?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 3456;
const LOCK_FILE_NAME = 'daemon-console.lock';
const DATA_DIR_ENV = 'WORKRAIL_DATA_DIR';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Execute the `worktrain console` command.
 *
 * This is a long-running command: it resolves the server address and returns
 * a stop handle. The composition root (cli-worktrain.ts) is responsible for
 * keeping the process alive and calling stop() on signal.
 */
export async function executeWorktrainConsoleCommand(
  deps: WorktrainConsoleCommandDeps,
  opts: WorktrainConsoleCommandOpts,
): Promise<WorktrainConsoleCommandResult> {
  const port = opts.port ?? DEFAULT_PORT;

  // Derive the data dir the same way LocalDataDirV2 does (env-first, then default).
  const dataDir = process.env[DATA_DIR_ENV]
    ?? deps.joinPath(deps.homedir(), '.workrail', 'data');

  const lockFilePath = deps.joinPath(deps.homedir(), '.workrail', LOCK_FILE_NAME);

  const outcome = await deps.startConsole({ port, dataDir, lockFilePath });

  if (outcome.kind === 'port_conflict') {
    return {
      kind: 'port_conflict',
      port: outcome.port,
    };
  }

  if (outcome.kind === 'io_error') {
    return {
      kind: 'io_error',
      message: outcome.message,
    };
  }

  // outcome.kind === 'ok'
  deps.stderr(`[Console] Listening at http://localhost:${outcome.port}/console`);

  return {
    kind: 'ok',
    port: outcome.port,
    stop: outcome.stop,
  };
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type WorktrainConsoleCommandResult =
  | { readonly kind: 'ok'; readonly port: number; readonly stop: () => Promise<void> }
  | { readonly kind: 'port_conflict'; readonly port: number }
  | { readonly kind: 'io_error'; readonly message: string };
