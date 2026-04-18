/**
 * Standalone Console Server
 *
 * Serves the WorkRail console UI as an independent process with zero coupling
 * to the daemon or MCP server. Reads session state directly from the filesystem
 * and pushes live updates to the browser via SSE backed by fs.watch.
 *
 * Lifecycle:
 *   startStandaloneConsole() -> binds port -> mounts console routes -> writes lock
 *   stop()                   -> calls route disposer -> closes server -> deletes lock
 *
 * Lock file:
 *   ~/.workrail/daemon-console.lock -- JSON: { pid, port }
 *   Written on bind, deleted on stop. Allows `worktrain spawn` to discover the port.
 *
 * Design notes:
 * - No DI container. Direct construction of infrastructure adapters.
 * - No primary election. Caller is responsible for not starting two instances.
 *   (If two `worktrain console` processes compete for the same port, the second
 *   one gets EADDRINUSE and exits cleanly with an error message.)
 * - ConsoleService and mountConsoleRoutes are the same implementations used by
 *   the daemon console. Reusing them ensures identical behavior with no drift.
 */

import express from 'express';
import cors from 'cors';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { LocalDataDirV2 } from '../v2/infra/local/data-dir/index.js';
import { LocalDirectoryListingV2 } from '../v2/infra/local/directory-listing/index.js';
import { NodeFileSystemV2 } from '../v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../v2/infra/local/pinned-workflow-store/index.js';
import { LocalSessionEventLogStoreV2 } from '../v2/infra/local/session-store/index.js';
import { ConsoleService } from '../v2/usecases/console-service.js';
import { mountConsoleRoutes } from '../v2/usecases/console-routes.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StandaloneConsoleHandle {
  readonly port: number;
  stop(): Promise<void>;
}

export type StandaloneConsoleError =
  | { readonly kind: 'port_conflict'; readonly port: number }
  | { readonly kind: 'io_error'; readonly message: string };

export type StandaloneConsoleResult =
  | ({ readonly kind: 'ok' } & StandaloneConsoleHandle)
  | ({ readonly kind: 'port_conflict' } & { readonly port: number })
  | ({ readonly kind: 'io_error' } & { readonly message: string });

export interface StartStandaloneConsoleOptions {
  /** Port to bind. Default: 3456. */
  readonly port?: number;
  /**
   * Override the data directory root. Default: WORKRAIL_DATA_DIR env var,
   * then ~/.workrail/data.
   */
  readonly dataDir?: string;
  /** Override the lock file path. Default: ~/.workrail/daemon-console.lock. */
  readonly lockFilePath?: string;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Start the standalone console HTTP server.
 *
 * The console reads session data directly from the filesystem and has no
 * runtime dependency on the daemon or MCP server. It can be started before,
 * after, or without either of them.
 *
 * Returns:
 * - { kind: 'ok', port, stop } on successful bind
 * - { kind: 'port_conflict', port } when the port is already in use
 * - { kind: 'io_error', message } on other errors
 */
export async function startStandaloneConsole(
  options: StartStandaloneConsoleOptions = {},
): Promise<StandaloneConsoleResult> {
  const port = options.port ?? 3456;
  const env = process.env as Record<string, string | undefined>;

  // Resolve the data directory (mirrors LocalDataDirV2 logic).
  const dataRoot = options.dataDir
    ?? env['WORKRAIL_DATA_DIR']
    ?? path.join(os.homedir(), '.workrail', 'data');

  // Override WORKRAIL_DATA_DIR in the env passed to LocalDataDirV2 so that
  // all derived paths (sessionsDir, snapshotsDir, etc.) are consistent.
  const envWithDataDir: Record<string, string | undefined> = {
    ...env,
    WORKRAIL_DATA_DIR: dataRoot,
  };

  const lockFilePath = options.lockFilePath
    ?? path.join(os.homedir(), '.workrail', 'daemon-console.lock');

  // ---------------------------------------------------------------------------
  // Build infrastructure adapters
  //
  // These are the same adapters the MCP server and daemon use. The console
  // only needs the read-side: session store, snapshot store, pinned workflows,
  // and directory listing. No write adapters are constructed here.
  // ---------------------------------------------------------------------------

  const dataDir = new LocalDataDirV2(envWithDataDir);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const directoryListing = new LocalDirectoryListingV2(fsPort);
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedWorkflowStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);

  // ---------------------------------------------------------------------------
  // Build ConsoleService and mount routes
  // ---------------------------------------------------------------------------

  const consoleService = new ConsoleService({
    directoryListing,
    dataDir,
    sessionStore,
    snapshotStore,
    pinnedWorkflowStore,
    // daemonRegistry is omitted: the standalone console never tracks live daemon
    // heartbeats. The isLive badge will always be false, which is correct since
    // the standalone console does not know which sessions are actively running.
    // A future iteration could read daemon-state.json from disk to derive this.
  });

  const app = express();

  // CORS: allow browser clients from any origin (safe: bound to 127.0.0.1).
  app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'If-None-Match'],
  }));

  // ETag support for efficient browser caching of API responses.
  app.set('etag', 'strong');

  // Mount the console API routes and static file serving.
  // mountConsoleRoutes returns a disposer that closes the FSWatcher.
  // workflowService and v2ToolContext are intentionally omitted:
  // - Workflow catalog (GET /api/v2/workflows) requires a WorkflowService.
  //   The standalone console does not load workflow definitions -- it only
  //   displays session history. If this feature is needed in the future,
  //   WorkflowService can be constructed here without daemon coupling.
  // - AUTO dispatch (POST /api/v2/auto/dispatch) requires a V2ToolContext with
  //   live session execution infrastructure. The standalone console is read-only;
  //   dispatching new workflows is out of scope.
  const stopWatcher = mountConsoleRoutes(
    app,
    consoleService,
    undefined,   // workflowService -- not needed for session history view
    undefined,   // timingRingBuffer -- no in-process tool call tracking
    undefined,   // toolCallsPerfFile -- same as above
    undefined,   // serverVersion -- no stamping needed
    undefined,   // v2ToolContext -- no autonomous dispatch
    undefined,   // triggerRouter -- no trigger info
  );

  // Redirect / to /console for convenience (must be before 404 catch-all).
  app.get('/', (_req: express.Request, res: express.Response) => {
    res.redirect('/console');
  });

  // 404 catch-all (must be after all routes).
  app.use((req: express.Request, res: express.Response) => {
    res.status(404).json({ success: false, error: 'Not found', path: req.path });
  });

  // ---------------------------------------------------------------------------
  // Bind the server
  // ---------------------------------------------------------------------------

  return new Promise((resolve) => {
    const server = http.createServer(app);

    server.on('error', (error: NodeJS.ErrnoException) => {
      // Clean up the FSWatcher since the server never started.
      try { stopWatcher(); } catch { /* ignore */ }

      if (error.code === 'EADDRINUSE') {
        resolve({ kind: 'port_conflict', port });
      } else {
        resolve({ kind: 'io_error', message: error.message });
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = (addr && typeof addr === 'object') ? addr.port : port;

      // Write lock file so `worktrain spawn` and other tools can discover the port.
      // Non-fatal: if the write fails the server still works.
      const lockDir = path.dirname(lockFilePath);
      void fs.mkdir(lockDir, { recursive: true })
        .then(() => fs.writeFile(
          lockFilePath,
          JSON.stringify({ pid: process.pid, port: actualPort }),
          'utf-8',
        ))
        .catch((writeErr: unknown) => {
          console.warn(
            '[StandaloneConsole] Could not write lock file:',
            writeErr instanceof Error ? writeErr.message : String(writeErr),
          );
        });

      let stopped = false;
      const stop = (): Promise<void> => {
        if (stopped) return Promise.resolve();
        stopped = true;

        return new Promise<void>((res) => {
          // 1. Stop the sessions directory watcher.
          try { stopWatcher(); } catch { /* ignore */ }

          // Safety timeout: if server.close() hangs (open keep-alive connections),
          // force-resolve after 5 s so the process can still exit cleanly.
          const safetyTimer = setTimeout(() => res(), 5_000);

          // 2. Close the HTTP server (waits for open connections to drain).
          server.close(() => {
            // Cancel the safety timer -- server closed in time.
            clearTimeout(safetyTimer);
            // 3. Delete the lock file (best-effort; ignore errors).
            void fs.unlink(lockFilePath)
              .catch(() => { /* already gone or never written -- ok */ })
              .finally(() => res());
          });
        });
      };

      resolve({ kind: 'ok', port: actualPort, stop });
    });
  });
}
