/**
 * Console API routes — read-only endpoints for the v2 Console UI.
 *
 * All routes are GET-only (invariant: Console is read-only).
 * Response shape: { success: true, data: T } | { success: false, error: string }
 * (matches existing HttpServer.ts pattern)
 */
import express from 'express';
import type { Application, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import type { ConsoleService } from './console-service.js';
import { getWorktreeList, buildActiveSessionCounts, resolveRepoRoot } from './worktree-service.js';

// ---------------------------------------------------------------------------
// Workspace SSE broadcast
//
// A lightweight pub/sub for pushing change notifications to connected console
// clients. When the sessions directory changes (new session, status update,
// recap written) all connected EventSource clients receive a 'change' event so
// they can immediately re-fetch instead of waiting for the next poll interval.
// ---------------------------------------------------------------------------

const sseClients = new Set<Response>();

/**
 * Debounce a change notification so rapid successive writes (e.g. a sequence
 * of event appends in one continue_workflow call) collapse into one broadcast.
 */
let sseDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastChange(): void {
  if (sseDebounceTimer !== null) return; // already scheduled
  sseDebounceTimer = setTimeout(() => {
    sseDebounceTimer = null;
    for (const client of sseClients) {
      try {
        client.write('data: {"type":"change"}\n\n');
      } catch {
        // Client already disconnected -- remove it
        sseClients.delete(client);
      }
    }
  }, 200);
}

/**
 * Watch the sessions directory and broadcast a change event whenever any file
 * inside it changes. Returns a cleanup function.
 *
 * Uses fs.watch with recursive:true (supported on macOS and Windows).
 * On unsupported platforms the watcher silently degrades -- clients fall back
 * to their polling interval.
 */
function watchSessionsDir(sessionsDir: string): (() => void) {
  // Create the directory if it doesn't exist yet (first run before any session)
  try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch { /* ignore */ }

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(sessionsDir, { recursive: true }, () => {
      broadcastChange();
    });
    watcher.on('error', () => { /* ignore watch errors -- polling fallback covers gaps */ });
  } catch {
    // fs.watch recursive not supported on this platform -- polling only
  }
  return () => { watcher?.close(); };
}

/**
 * Resolve the console dist directory.
 * Works both from source (src/) and from compiled output (dist/).
 */
function resolveConsoleDist(): string | null {
  // Released/compiled server path: dist/v2/usecases -> ../../console
  const releasedDist = path.join(__dirname, '../../console');
  if (fs.existsSync(releasedDist)) return releasedDist;

  // Source tree path during local development/testing: src/v2/usecases -> ../../../dist/console
  const fromSourceBuild = path.join(__dirname, '../../../dist/console');
  if (fs.existsSync(fromSourceBuild)) return fromSourceBuild;

  // Backward-compatible fallback for older layouts that built in-place
  const legacyConsoleDist = path.join(__dirname, '../../../console/dist');
  if (fs.existsSync(legacyConsoleDist)) return legacyConsoleDist;

  return null;
}

export function mountConsoleRoutes(app: Application, consoleService: ConsoleService): void {
  // Start watching the sessions directory so SSE clients get notified of changes
  const stopWatcher = watchSessionsDir(consoleService.getSessionsDir());
  // Clean up watcher if the process exits gracefully
  process.once('exit', stopWatcher);

  // --- API routes ---

  // SSE: push a 'change' event to all connected console clients whenever the
  // workspace changes (new session, status update, recap written). Clients
  // listen on this endpoint and call queryClient.invalidateQueries() to refetch.
  app.get('/api/v2/workspace/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
    res.flushHeaders();

    // Send a heartbeat immediately so the client knows the connection is live
    res.write('data: {"type":"connected"}\n\n');

    sseClients.add(res);

    // Remove client on disconnect
    req.on('close', () => { sseClients.delete(res); });
  });

  // List all v2 sessions
  app.get('/api/v2/sessions', async (_req: Request, res: Response) => {
    const result = await consoleService.getSessionList();
    result.match(
      (data) => res.json({ success: true, data }),
      (error) => res.status(500).json({ success: false, error: error.message }),
    );
  });

  // List git worktrees grouped by repo, with enriched status and active session counts.
  // Repo roots are derived from session observations (repo_root anchor) so the view
  // covers all repos agents have worked in, not just the current CWD's repo.

  // CWD root: stable for the lifetime of the process — resolve once, cache forever.
  let cwdRepoRootPromise: Promise<string | null> | null = null;

  // Repo roots from sessions: changes only when new sessions appear from new repos.
  // Cache with a TTL so we re-scan sessions infrequently rather than on every request.
  // Active session counts (for worktree badges) still come from each full session scan.
  const REPO_ROOTS_TTL_MS = 60_000;
  let cachedRepoRoots: readonly string[] = [];
  let repoRootsExpiresAt = 0;

  app.get('/api/v2/worktrees', async (_req: Request, res: Response) => {
    try {
      const sessionResult = await consoleService.getSessionList();
      const sessions = sessionResult.isOk() ? sessionResult.value.sessions : [];
      const activeSessions = buildActiveSessionCounts(sessions);

      // Refresh the known-repos set at most once per TTL window.
      if (Date.now() > repoRootsExpiresAt) {
        cwdRepoRootPromise ??= resolveRepoRoot(process.cwd());
        const cwdRoot = await cwdRepoRootPromise;
        const repoRootSet = new Set<string>(
          sessions.map(s => s.repoRoot).filter((r): r is string => r !== null),
        );
        if (cwdRoot !== null) repoRootSet.add(cwdRoot);
        cachedRepoRoots = [...repoRootSet];
        repoRootsExpiresAt = Date.now() + REPO_ROOTS_TTL_MS;
      }

      const data = await getWorktreeList(cachedRepoRoots, activeSessions);
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Get session detail with full DAG
  app.get('/api/v2/sessions/:sessionId', async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const result = await consoleService.getSessionDetail(sessionId);
    result.match(
      (data) => res.json({ success: true, data }),
      (error) => {
        const status = error.code === 'SESSION_LOAD_FAILED' ? 404 : 500;
        res.status(status).json({ success: false, error: error.message });
      },
    );
  });

  // Get node detail within a session
  app.get('/api/v2/sessions/:sessionId/nodes/:nodeId', async (req: Request, res: Response) => {
    const { sessionId, nodeId } = req.params;
    const result = await consoleService.getNodeDetail(sessionId, nodeId);
    result.match(
      (data) => res.json({ success: true, data }),
      (error) => {
        const status = error.code === 'NODE_NOT_FOUND' ? 404
          : error.code === 'SESSION_LOAD_FAILED' ? 404
          : 500;
        res.status(status).json({ success: false, error: error.message });
      },
    );
  });

  // --- Static file serving for Console UI ---

  const consoleDist = resolveConsoleDist();
  if (consoleDist) {
    // Serve console static assets under /console
    app.use('/console', express.static(consoleDist));

    // SPA catch-all: any /console/* route serves index.html
    // (lets React handle client-side routing)
    app.get('/console/*path', (_req: Request, res: Response) => {
      res.sendFile(path.join(consoleDist, 'index.html'));
    });

    console.error(`[Console] UI serving from ${consoleDist}`);
  } else {
    // No built console -- serve a helpful message
    app.get('/console', (_req: Request, res: Response) => {
      res.status(503).json({
        error: 'Console not built',
        message: 'Run "cd console && npm run build" to build the Console UI.',
      });
    });
    console.error('[Console] UI not found (run: cd console && npm run build)');
  }
}
