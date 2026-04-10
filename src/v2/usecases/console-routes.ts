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
import { toWorkflowSourceInfo } from '../../types/workflow.js';
import type { WorkflowService } from '../../application/services/workflow-service.js';
import type { ToolCallTimingRingBuffer } from '../../mcp/tool-call-timing.js';
import { DEV_MODE } from '../../mcp/dev-mode.js';

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
    watcher = fs.watch(sessionsDir, { recursive: true }, (_eventType, filename) => {
      // Only broadcast on .jsonl writes (session event log files).
      // Session event logs are the canonical signal that a workflow step
      // has advanced. Ignoring other file types (temp files, lock files,
      // snapshot JSON, recaps) prevents spurious SSE events that would
      // otherwise trigger unnecessary session refetches.
      // filename can be null on some platforms -- guard required.
      if (filename !== null && filename.endsWith('.jsonl')) {
        broadcastChange();
      }
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

// ---------------------------------------------------------------------------
// Workflow tags cache
// ---------------------------------------------------------------------------

interface WorkflowTagEntry {
  readonly tags: readonly string[];
  readonly hidden?: boolean;
}

interface WorkflowTagsFile {
  readonly version: number;
  readonly tags: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
  readonly workflows: Record<string, WorkflowTagEntry>;
}

let cachedWorkflowTags: WorkflowTagsFile | null = null;

function loadWorkflowTags(): WorkflowTagsFile {
  if (cachedWorkflowTags !== null) return cachedWorkflowTags;
  const tagsPath = path.resolve(__dirname, '../../../spec/workflow-tags.json');
  try {
    cachedWorkflowTags = JSON.parse(fs.readFileSync(tagsPath, 'utf8')) as WorkflowTagsFile;
    return cachedWorkflowTags;
  } catch {
    return { version: 0, tags: [], workflows: {} };
  }
}

export function mountConsoleRoutes(
  app: Application,
  consoleService: ConsoleService,
  workflowService?: WorkflowService,
  timingRingBuffer?: ToolCallTimingRingBuffer,
): void {
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
    res.on('close', () => { sseClients.delete(res); }); // F4: catch external res.end() immediately
  });

  // ---------------------------------------------------------------------------
  // Perf: recent tool call timings
  //
  // GET /api/v2/perf/tool-calls?limit=N
  //
  // Returns the most recent N tool call timing observations from the ring buffer
  // (newest first, max 100). Only mounted when WORKRAIL_DEV=1 so this endpoint
  // is never reachable in production servers.
  //
  // The ring buffer is optional: if not wired in, the endpoint returns an empty
  // array rather than 404 so clients can always query it unconditionally.
  // The devMode field lets consumers distinguish "no calls happened" from
  // "DEV_MODE is off and the buffer was never wired in".
  // ---------------------------------------------------------------------------
  if (DEV_MODE) {
    app.get('/api/v2/perf/tool-calls', (req: Request, res: Response) => {
      const rawLimit = req.query['limit'];
      const limit = typeof rawLimit === 'string' ? parseInt(rawLimit, 10) : undefined;
      const safeLimit = (limit !== undefined && Number.isFinite(limit) && limit > 0) ? limit : undefined;
      const observations = timingRingBuffer ? timingRingBuffer.recent(safeLimit) : [];
      res.json({ success: true, data: { observations, total: timingRingBuffer?.size ?? 0, devMode: DEV_MODE } });
    });
  }

  // List all v2 sessions
  app.get('/api/v2/sessions', async (_req: Request, res: Response) => {
    const result = await consoleService.getSessionList();
    result.match(
      (data) => res.json({ success: true, data }),
      (error) => res.status(500).json({ success: false, error: error.message }),
    );
  });

  // List git worktrees grouped by repo, with enriched status and active session counts.
  // Repo roots are derived from the server process CWD only. Active session counts
  // (for worktree badges) come from a full session scan on each request.
  //
  // Per-request timeout: if git scanning takes longer than 8 s, respond with the
  // cached result (or an empty list) so the UI never spins indefinitely.

  // CWD root + discovered repo roots, refreshed on a TTL like the original design.
  let cwdRepoRootPromise: Promise<string | null> | null = null;
  let cachedRepoRoots: readonly string[] = [];
  let repoRootsExpiresAt = 0;
  const REPO_ROOTS_TTL_MS = 60_000;

  /**
   * Discovers standalone git repos by scanning up to 2 levels under ~/git.
   * Filters out linked worktrees (their --git-common-dir points outside the dir).
   * This replicates the original session-repoRoot-based discovery without needing
   * repoRoot on sessions, which was removed as an unreliable field.
   */
  async function discoverMainRepoRoots(): Promise<readonly string[]> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const candidates: string[] = [];
    const base = path.join(process.env.HOME ?? '/tmp', 'git');
    try {
      const level1 = await fs.promises.readdir(base, { withFileTypes: true });
      for (const l1 of level1) {
        if (!l1.isDirectory()) continue;
        const l1path = path.join(base, l1.name);
        try { await fs.promises.access(path.join(l1path, '.git')); candidates.push(l1path); continue; } catch {}
        try {
          const level2 = await fs.promises.readdir(l1path, { withFileTypes: true });
          for (const l2 of level2) {
            if (!l2.isDirectory()) continue;
            const l2path = path.join(l1path, l2.name);
            try { await fs.promises.access(path.join(l2path, '.git')); candidates.push(l2path); } catch {}
          }
        } catch {}
      }
    } catch {}

    // Filter: keep only repos whose git-common-dir lives inside the repo dir itself.
    // Linked worktrees (git worktree add) have their common-dir pointing to the main
    // repo's .git, so they're excluded. This eliminates .claude-worktrees/ entries
    // and any other linked worktrees without git commands on every single candidate.
    const roots: string[] = [];
    await Promise.all(candidates.map(async (dir) => {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
          cwd: dir, timeout: 3_000,
        });
        const commonDir = path.resolve(dir, stdout.trim());
        // A main repo's common-dir is inside (or equal to) its own dir.
        if (commonDir.startsWith(dir + path.sep) || commonDir === dir) {
          roots.push(dir);
        }
      } catch {}
    }));
    return roots;
  }

  /** 8 s ceiling for the entire worktrees response, well above the p99 git scan time. */
  const WORKTREES_REQUEST_TIMEOUT_MS = 8_000;

  app.get('/api/v2/worktrees', async (_req: Request, res: Response) => {
    // Timeout race: if the scan takes too long, return an empty repo list so the
    // client doesn't spin. The next poll will retry, and the in-flight scan result
    // will be cached by then.
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('worktrees scan timeout')), WORKTREES_REQUEST_TIMEOUT_MS)
    );

    try {
      const sessionResult = await consoleService.getSessionList();
      const sessions = sessionResult.isOk() ? sessionResult.value.sessions : [];
      const activeSessions = buildActiveSessionCounts(sessions);

      cwdRepoRootPromise ??= resolveRepoRoot(process.cwd());
      if (Date.now() > repoRootsExpiresAt) {
        const [cwdRoot, discovered] = await Promise.all([
          cwdRepoRootPromise,
          discoverMainRepoRoots(),
        ]);
        const repoRootsSet = new Set<string>(discovered);
        if (cwdRoot !== null) repoRootsSet.add(cwdRoot);
        cachedRepoRoots = [...repoRootsSet];
        repoRootsExpiresAt = Date.now() + REPO_ROOTS_TTL_MS;
      }
      const repoRoots = cachedRepoRoots;

      const data = await Promise.race([
        getWorktreeList(repoRoots, activeSessions),
        timeoutPromise,
      ]);
      res.json({ success: true, data });
    } catch (e) {
      if (e instanceof Error && e.message === 'worktrees scan timeout') {
        // Respond with empty data instead of leaving the client hanging.
        // The background scan is still running and will populate the cache.
        res.json({ success: true, data: { repos: [] } });
      } else {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
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

  // Workflow catalog endpoints. Only mounted when a workflowService is provided.
  // Uses loadAllWorkflows() to load all definitions in one pass (avoids N+1).
  if (workflowService) {
    app.get('/api/v2/workflows', async (_req: Request, res: Response) => {
      try {
        const tagsFile = loadWorkflowTags();
        const allWorkflows = await workflowService.loadAllWorkflows();
        const workflows = allWorkflows
          .filter((w) => !tagsFile.workflows[w.definition.id]?.hidden)
          .map((w) => {
            const { definition, source } = w;
            const tagEntry = tagsFile.workflows[definition.id];
            return {
              id: definition.id,
              name: definition.name,
              description: definition.description,
              version: definition.version,
              tags: tagEntry?.tags ?? [],
              source: toWorkflowSourceInfo(source),
              ...(definition.about !== undefined ? { about: definition.about } : {}),
              ...(definition.examples?.length ? { examples: [...definition.examples] } : {}),
            };
          });
        res.json({ success: true, data: { workflows } });
      } catch (e) {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

    app.get('/api/v2/workflows/:workflowId', async (req: Request, res: Response) => {
      const { workflowId } = req.params;
      try {
        const workflow = await workflowService.getWorkflowById(workflowId);
        if (!workflow) {
          return res.status(404).json({ success: false, error: `Workflow not found: ${workflowId}` });
        }
        const tagsFile = loadWorkflowTags();
        if (tagsFile.workflows[workflowId]?.hidden) {
          return res.status(404).json({ success: false, error: `Workflow not found: ${workflowId}` });
        }
        const { definition, source } = workflow;
        const tagEntry = tagsFile.workflows[workflowId];
        return res.json({
          success: true,
          data: {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            version: definition.version,
            tags: tagEntry?.tags ?? [],
            source: toWorkflowSourceInfo(source),
            stepCount: definition.steps.length,
            ...(definition.about !== undefined ? { about: definition.about } : {}),
            ...(definition.examples?.length ? { examples: [...definition.examples] } : {}),
            ...(definition.preconditions?.length ? { preconditions: [...definition.preconditions] } : {}),
          },
        });
      } catch (e) {
        return res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  // --- Static file serving for Console UI ---

  const consoleDist = resolveConsoleDist();
  if (consoleDist) {
    // Serve console static assets under /console.
    // index.html is served with no-cache so the browser always revalidates on
    // version upgrades. Versioned asset files (JS/CSS with content hashes) can
    // still be cached aggressively by the browser via their hash-in-filename.
    app.use('/console', express.static(consoleDist, {
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    }));

    // SPA catch-all: any /console/* route serves index.html
    // (lets React handle client-side routing)
    // Cache-Control: no-cache ensures the browser always revalidates index.html
    // so a WorkRail upgrade is reflected immediately without a hard refresh.
    app.get('/console/*path', (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
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
