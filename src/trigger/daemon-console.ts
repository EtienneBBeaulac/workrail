/**
 * WorkRail Daemon Console
 *
 * Starts a standalone Express HTTP server on port 3456 that hosts the console
 * dashboard. Designed to be called from the daemon startup path so the console
 * stays up as long as the daemon process runs, regardless of MCP server state.
 *
 * Lifecycle:
 *   start -> binds port -> mounts console routes -> writes daemon-console.lock
 *   stop  -> calls stopWatcher disposer -> closes server -> deletes daemon-console.lock
 *
 * Lock file format:
 *   ~/.workrail/daemon-console.lock -- JSON: { pid: number, port: number }
 *
 * Port conflicts (EADDRINUSE) are returned as err({ kind: 'port_conflict' }).
 * The caller should log a clear message and continue -- the trigger listener
 * still works on port 3200 even when the console cannot start.
 */

import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { V2ToolContext } from '../mcp/types.js';
import type { TriggerRouter } from './trigger-router.js';
import type { PollingScheduler } from './polling-scheduler.js';
import type { WorkflowService } from '../application/services/workflow-service.js';
import type { SteerRegistry } from '../daemon/workflow-runner.js';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONSOLE_PORT = 3456;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DaemonConsoleHandle {
  readonly port: number;
  stop(): Promise<void>;
}

export type DaemonConsoleError =
  | { readonly kind: 'port_conflict'; readonly port: number }
  | { readonly kind: 'io_error'; readonly message: string };

export interface StartDaemonConsoleOptions {
  /** Override the default port (3456). Pass 0 to let the OS pick a free port. */
  readonly port?: number;
  /** TriggerRouter instance to pass to the AUTO dispatch endpoint. */
  readonly triggerRouter?: TriggerRouter;
  /** Package version string for stamping perf records. */
  readonly serverVersion?: string;
  /** WorkflowService for the workflow catalog API endpoints. */
  readonly workflowService?: WorkflowService;
  /** Override the lock file path (for testing). */
  readonly lockFilePath?: string;
  /**
   * Steer registry for coordinator injection via POST /sessions/:id/steer.
   * Must be the same instance passed to TriggerRouter's constructor so the HTTP
   * endpoint can reach callbacks registered by running daemon sessions.
   * When absent, the steer endpoint returns 503.
   */
  readonly steerRegistry?: SteerRegistry;
  /**
   * PollingScheduler instance for POST /api/v2/triggers/:id/poll (force immediate poll).
   * Must be the same instance created by startTriggerListener().
   * When absent, the poll endpoint returns 503.
   */
  readonly pollingScheduler?: PollingScheduler;
}

// ---------------------------------------------------------------------------
// Daemon console startup
// ---------------------------------------------------------------------------

/**
 * Start the daemon-owned HTTP console server.
 *
 * Returns:
 * - ok(DaemonConsoleHandle) on successful startup
 * - err(DaemonConsoleError) on startup failure (port conflict, I/O error)
 */
export async function startDaemonConsole(
  ctx: V2ToolContext,
  options: StartDaemonConsoleOptions = {},
): Promise<Result<DaemonConsoleHandle, DaemonConsoleError>> {
  const port = options.port ?? DEFAULT_CONSOLE_PORT;
  const lockFilePath = options.lockFilePath ?? path.join(os.homedir(), '.workrail', 'daemon-console.lock');

  // Build the Express app with all console routes mounted.
  const app = express();

  // CORS: allow browser clients from any origin. The server is bound to
  // 127.0.0.1 only, so this is safe for local developer use.
  app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'If-None-Match'],
  }));

  // ETag support for efficient polling
  app.set('etag', 'strong');

  // Lazy-import to avoid circular dependency at module load time.
  const { ConsoleService } = await import('../v2/usecases/console-service.js');
  const { mountConsoleRoutes } = await import('../v2/usecases/console-routes.js');

  // Both dataDir and directoryListing are optional in V2Dependencies.
  // They are always present when the daemon starts (the daemon uses createToolContext()
  // which initializes them), but we guard here to satisfy the type contract.
  if (!ctx.v2.dataDir || !ctx.v2.directoryListing) {
    return err({ kind: 'io_error', message: 'V2 data dir or directory listing not available' });
  }

  const consoleService = new ConsoleService({
    directoryListing: ctx.v2.directoryListing,
    dataDir: ctx.v2.dataDir,
    sessionStore: ctx.v2.sessionStore,
    snapshotStore: ctx.v2.snapshotStore,
    pinnedWorkflowStore: ctx.v2.pinnedStore,
  });

  // Mount console routes. Pass ctx as v2ToolContext to enable the AUTO dispatch
  // endpoint, triggerRouter so dispatches go through the daemon's queue,
  // steerRegistry so POST /sessions/:id/steer can reach running session callbacks,
  // and pollingScheduler so POST /api/v2/triggers/:id/poll can force immediate cycles.
  // timingRingBuffer and toolCallsPerfFile are intentionally omitted -- the daemon
  // console does not track per-tool timing (dev perf endpoint returns empty).
  const stopWatcher = mountConsoleRoutes(
    app,
    consoleService,
    options.workflowService,
    undefined,          // timingRingBuffer -- not tracked in daemon context
    undefined,          // toolCallsPerfFile -- not tracked in daemon context
    options.serverVersion,
    ctx,
    options.triggerRouter,
    options.steerRegistry,
    options.pollingScheduler,
  );

  // 404 catch-all (must be installed after all routes)
  app.use((req: express.Request, res: express.Response) => {
    res.status(404).json({ success: false, error: 'Not found', path: req.path });
  });

  // ---------------------------------------------------------------------------
  // Bind the server
  // ---------------------------------------------------------------------------
  return new Promise((resolve) => {
    const server = http.createServer(app);

    server.on('error', (error: NodeJS.ErrnoException) => {
      // Clean up the watcher since the server never started
      try { stopWatcher(); } catch { /* ignore */ }

      if (error.code === 'EADDRINUSE') {
        resolve(err({ kind: 'port_conflict', port }));
      } else {
        resolve(err({ kind: 'io_error', message: error.message }));
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = (addr && typeof addr === 'object') ? addr.port : port;

      // Write lock file. Non-fatal: if the write fails, the daemon still works --
      // future tooling that reads the lock will just not find it.
      const lockDir = path.dirname(lockFilePath);
      void fs.mkdir(lockDir, { recursive: true })
        .then(() => fs.writeFile(
          lockFilePath,
          JSON.stringify({ pid: process.pid, port: actualPort }),
          'utf-8',
        ))
        .catch((writeErr: unknown) => {
          console.warn(
            '[DaemonConsole] Could not write lock file:',
            writeErr instanceof Error ? writeErr.message : String(writeErr),
          );
        });

      console.log(`[DaemonConsole] Console available at http://localhost:${actualPort}/console`);

      // Build the stop handle
      let stopped = false;
      const stop = (): Promise<void> => {
        if (stopped) return Promise.resolve();
        stopped = true;

        return new Promise<void>((res) => {
          // 1. Stop the sessions directory watcher
          try { stopWatcher(); } catch { /* ignore */ }

          // 2. Close the HTTP server
          server.close(() => {
            // 3. Delete the lock file (non-fatal)
            void fs.unlink(lockFilePath)
              .catch(() => { /* already gone or never written -- ok */ })
              .finally(() => res());
          });

          // Timeout: if server.close() hangs (open keep-alive connections),
          // force resolve after 5s so the daemon can still exit cleanly.
          setTimeout(() => res(), 5000);
        });
      };

      resolve(ok({ port: actualPort, stop }));
    });
  });
}
