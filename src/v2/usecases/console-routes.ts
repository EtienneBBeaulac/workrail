/**
 * Console API routes for the v2 Console UI.
 *
 * Mostly read-only GET endpoints. POST /api/v2/auto/dispatch is an intentional
 * exception for the autonomous dispatch feature -- it fires a workflow run
 * asynchronously and returns immediately (fire-and-forget).
 *
 * Response shape: { success: true, data: T } | { success: false, error: string }
 * (matches existing HttpServer.ts pattern)
 */
import express from 'express';
import type { Application, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { ConsoleService } from './console-service.js';
import { getWorktreeList, buildActiveSessionCounts, resolveRepoRoot, setEnrichmentCompleteCallback } from './worktree-service.js';
import { toWorkflowSourceInfo } from '../../types/workflow.js';
import type { WorkflowService } from '../../application/services/workflow-service.js';
import type { ToolCallTimingEntry, ToolCallTimingRingBuffer } from '../../mcp/tool-call-timing.js';
import { isDevMode } from '../../mcp/dev-mode.js';
import type { TriggerRouter } from '../../trigger/trigger-router.js';
import type { V2ToolContext } from '../../mcp/types.js';
import type { SteerRegistry } from '../../daemon/workflow-runner.js';
import { runWorkflow } from '../../daemon/workflow-runner.js';
import { assertNever } from '../../runtime/assert-never.js';
import { executeStartWorkflow } from '../../mcp/handlers/v2-execution/start.js';
import { parseContinueTokenOrFail } from '../../mcp/handlers/v2-token-ops.js';

// ---------------------------------------------------------------------------
// Workspace SSE broadcast
//
// A lightweight pub/sub for pushing change notifications to connected console
// clients. When the sessions directory changes (new session, status update,
// recap written) all connected EventSource clients receive a 'change' event so
// they can immediately re-fetch instead of waiting for the next poll interval.
//
// NOTE: sseClients and sseDebounceTimer are intentionally declared inside
// mountConsoleRoutes() (not at module scope). Module-level state is shared
// across all calls to mountConsoleRoutes(), causing SSE broadcasts from one
// WorkRail instance's watcher to fire on a different instance's browser clients.
// Closure scope makes shared state structurally impossible.
// ---------------------------------------------------------------------------

/**
 * Watch the sessions directory and broadcast a change event whenever any file
 * inside it changes. Returns a cleanup function.
 *
 * Uses fs.watch with recursive:true (supported on macOS and Windows).
 * On unsupported platforms the watcher silently degrades -- clients fall back
 * to their polling interval.
 */
function watchSessionsDir(sessionsDir: string, onChanged: () => void): (() => void) {
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
        onChanged();
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
 *
 * The Vite build (console/vite.config.ts) outputs to dist/console-ui/ to avoid
 * clobbering dist/console/standalone-console.js, which TypeScript compiles from
 * src/console/standalone-console.ts. Both the released path and the source-tree
 * development path use the console-ui suffix.
 */
function resolveConsoleDist(): string | null {
  // Released/compiled server path: dist/v2/usecases -> ../../console-ui
  const releasedDist = path.join(__dirname, '../../console-ui');
  if (fs.existsSync(releasedDist)) return releasedDist;

  // Source tree path during local development/testing: src/v2/usecases -> ../../../dist/console-ui
  const fromSourceBuild = path.join(__dirname, '../../../dist/console-ui');
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
  toolCallsPerfFile?: string,
  serverVersion?: string,
  v2ToolContext?: V2ToolContext,
  triggerRouter?: TriggerRouter,
  steerRegistry?: SteerRegistry,
  pollingScheduler?: import('../../trigger/polling-scheduler.js').PollingScheduler,
): () => void {
  // SSE state: per-instance, not module-level (see comment block above).
  const sseClients = new Set<Response>();
  let sseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Debounce a change notification so rapid successive writes (e.g. a sequence
   * of event appends in one continue_workflow call) collapse into one broadcast.
   */
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

  // Start watching the sessions directory so SSE clients get notified of changes.
  // stopWatcher is returned as a disposer -- the caller (HttpServer.mountRoutes)
  // stores it and invokes it during stop(). process.once('exit') is intentionally
  // NOT used here: it accumulates one listener per mountConsoleRoutes() call,
  // causing MaxListenersExceededWarning on stderr which corrupts the MCP stdio channel.
  const stopWatcher = watchSessionsDir(consoleService.getSessionsDir(), broadcastChange);

  // Wire up background enrichment completion callback.
  // When background worktree enrichment finishes, broadcast a `worktrees-updated`
  // SSE event so connected clients know to refetch the enriched git badge data.
  // Debounced at 2s to collapse rapid completions (e.g. multiple repos finishing
  // within the same second) into a single broadcast.
  let enrichmentBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  setEnrichmentCompleteCallback(() => {
    if (enrichmentBroadcastTimer !== null) clearTimeout(enrichmentBroadcastTimer);
    enrichmentBroadcastTimer = setTimeout(() => {
      enrichmentBroadcastTimer = null;
      for (const client of sseClients) {
        try {
          client.write('data: {"type":"worktrees-updated"}\n\n');
        } catch {
          sseClients.delete(client);
        }
      }
    }, 2_000);
  });

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
  // Per-session SSE endpoint
  //
  // GET /api/v2/sessions/:sessionId/events
  //
  // Streams structured daemon events for a single session in real time. Designed
  // for coordinator scripts that need to observe a running session and decide
  // whether to call POST /sessions/:id/steer.
  //
  // Implementation notes:
  // - Validates the session exists before opening the stream (404 if not found).
  // - Watches the daemon event log file (~/.workrail/events/daemon/YYYY-MM-DD.jsonl)
  //   and tails new events as they are appended by DaemonEventEmitter.
  // - Filters events by workrailSessionId matching the URL param.
  // - Included event kinds: tool_called, tool_call_started, tool_call_completed,
  //   tool_call_failed, tool_error, step_advanced, session_completed, issue_reported,
  //   agent_stuck, llm_turn_started, llm_turn_completed.
  // - Closes the stream cleanly after a session_completed event is forwarded.
  // - Auth: none required (localhost-only, 127.0.0.1 binding, same as all other routes).
  // ---------------------------------------------------------------------------

  /** Daemon event log directory -- matches the path in console-service.ts and daemon-events.ts. */
  const daemonEventsDir = path.join(
    process.env['HOME'] ?? os.homedir(),
    '.workrail', 'events', 'daemon',
  );

  /**
   * Tail-read all lines appended AFTER `prevSize` bytes from the daemon event log file.
   * Returns an array of raw JSON-parsed event objects, skipping malformed lines.
   * Returns [] when the file is not yet created or cannot be read.
   */
  async function tailDaemonEvents(filePath: string, prevSize: number): Promise<readonly Record<string, unknown>[]> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size <= prevSize) return [];
      const fd = await fs.promises.open(filePath, 'r');
      const length = stat.size - prevSize;
      const buf = Buffer.alloc(length);
      try {
        await fd.read(buf, 0, length, prevSize);
      } finally {
        await fd.close();
      }
      const chunk = buf.toString('utf8');
      return chunk
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
        });
    } catch {
      return [];
    }
  }

  // Event kinds forwarded to the per-session SSE stream.
  // Omitted: daemon_started, trigger_fired, session_queued, session_started, delivery_attempted
  // (these are workspace-level, not per-session coordinator signals).
  const SESSION_SSE_EVENT_KINDS = new Set([
    'tool_called',
    'tool_call_started',
    'tool_call_completed',
    'tool_call_failed',
    'tool_error',
    'step_advanced',
    'session_completed',
    'issue_reported',
    'agent_stuck',
    'llm_turn_started',
    'llm_turn_completed',
    'signal_emitted',  // emitted by signal_coordinator tool
  ]);

  app.get('/api/v2/sessions/:sessionId/events', async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    // Validate session exists before opening SSE stream.
    // NOTE: the session store returns ok() for unknown IDs (empty manifest, not an error).
    // We detect non-existent sessions by checking for an empty runs array.
    const sessionResult = await consoleService.getSessionDetail(sessionId);
    if (sessionResult.isErr()) {
      const status = sessionResult.error.code === 'SESSION_LOAD_FAILED' ? 404 : 500;
      res.status(status).json({ success: false, error: sessionResult.error.message });
      return;
    }
    const sessionDetail = sessionResult.value;
    if (!sessionDetail || !sessionDetail.runs || sessionDetail.runs.length === 0) {
      res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
      return;
    }

    // Set SSE headers.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send connected event immediately so client knows the stream is live.
    res.write(`data: ${JSON.stringify({ kind: 'connected', sessionId })}\n\n`);

    // Track current file position so we only read newly-appended bytes.
    // currentLogDate and currentLogPath are updated on every poll to handle UTC midnight rollover.
    let currentLogDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let currentLogPath = path.join(daemonEventsDir, `${currentLogDate}.jsonl`);
    let fileOffset = 0;
    try {
      const stat = await fs.promises.stat(currentLogPath);
      fileOffset = stat.size; // start from end of existing content
    } catch {
      // File not yet created -- start from 0
    }

    let isClosed = false;
    let isProcessing = false;
    let watcher: ReturnType<typeof fs.watch> | null = null;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      try { watcher?.close(); } catch { /* ignore */ }
      try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    };

    /** Read new events from the log file, filter by sessionId, and write matching ones to the stream. */
    const processNewEvents = async () => {
      if (isClosed || isProcessing) return;
      isProcessing = true;

      // Handle UTC midnight rollover: if the date changed, switch to the new log file.
      const todayDate = new Date().toISOString().slice(0, 10);
      if (todayDate !== currentLogDate) {
        currentLogDate = todayDate;
        currentLogPath = path.join(daemonEventsDir, `${currentLogDate}.jsonl`);
        fileOffset = 0;
      }

      const newEvents = await tailDaemonEvents(currentLogPath, fileOffset);

      for (const event of newEvents) {
        if (isClosed) break;

        // Filter: must match this session and be a coordinator-relevant kind.
        const kind = typeof event['kind'] === 'string' ? event['kind'] : null;
        const evtSessionId = typeof event['workrailSessionId'] === 'string'
          ? event['workrailSessionId']
          : null;

        if (!kind || !SESSION_SSE_EVENT_KINDS.has(kind)) continue;
        if (evtSessionId !== sessionId) continue;

        // Write the event to the SSE stream.
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          cleanup();
          return;
        }

        // Close the stream after forwarding the terminal event.
        if (kind === 'session_completed') {
          cleanup();
          return;
        }
      }

      // Update fileOffset to current file size (covers all lines just consumed).
      try {
        const stat = await fs.promises.stat(currentLogPath);
        fileOffset = stat.size;
      } catch {
        // File was deleted or renamed mid-read -- reset to 0 for next poll.
        fileOffset = 0;
      }
      isProcessing = false;
    };

    // Watch the daemon events directory. The log file for today may not exist yet;
    // fs.watch on the directory fires on any file change within it, including file creation.
    // WHY directory not file: midnight rollover creates a new YYYY-MM-DD.jsonl file;
    // watching the directory fires when that file is created. processNewEvents() handles
    // the rollover by recomputing currentLogPath when the date changes.
    try {
      fs.mkdirSync(daemonEventsDir, { recursive: true });
    } catch { /* ignore */ }

    try {
      watcher = fs.watch(daemonEventsDir, { recursive: false }, (_eventType, filename) => {
        if (filename !== null && filename.endsWith('.jsonl')) {
          void processNewEvents();
        }
      });
      watcher.on('error', cleanup);
    } catch {
      // fs.watch not supported on this platform -- SSE stream stays open but receives no events
      // (coordinator can still disconnect and poll via the session detail endpoint).
    }

    // Keepalive: send SSE comments every 30s to prevent proxy timeouts.
    const keepaliveInterval = setInterval(() => {
      if (isClosed) { clearInterval(keepaliveInterval); return; }
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepaliveInterval);
        cleanup();
      }
    }, 30_000);

    // Max connection time: 4 hours. After that, close cleanly. Coordinators should
    // reconnect if they need to observe beyond that window.
    const maxConnectionTimeout = setTimeout(() => {
      clearInterval(keepaliveInterval);
      cleanup();
    }, 4 * 60 * 60 * 1000);

    req.on('close', () => {
      clearInterval(keepaliveInterval);
      clearTimeout(maxConnectionTimeout);
      cleanup();
    });
    res.on('close', () => {
      clearInterval(keepaliveInterval);
      clearTimeout(maxConnectionTimeout);
      cleanup();
    });

    // Do an initial scan to catch any events that fired between session validation and
    // the watch being established (small race window).
    void processNewEvents();
  });

  // ---------------------------------------------------------------------------
  // Perf: recent tool call timings
  //
  // GET /api/v2/perf/tool-calls?limit=N
  //
  // Merges in-memory ring buffer (recent entries) with JSONL disk store (30-day
  // window). Dedupes entries written to both sinks. Only mounted when WORKRAIL_DEV=1.
  //
  // JSONL reader: reads all timing entries from disk, skipping malformed lines.
  // Entries older than 30 days are filtered out (lazy eviction -- no file rewrite).
  // ---------------------------------------------------------------------------
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  /** Cap how much of the JSONL file we read per request.
   *  At ~150 bytes/entry this is ~35,000 entries -- far more than 30 days of typical usage.
   *  Reading from the end of the file gives the most recent data when the cap is hit. */
  const PERF_FILE_READ_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB

  async function readDiskEntries(perfFile: string): Promise<readonly ToolCallTimingEntry[]> {
    try {
      const stat = await fs.promises.stat(perfFile);
      let raw: string;
      if (stat.size > PERF_FILE_READ_LIMIT_BYTES) {
        // File is large -- read only the tail so memory use stays bounded.
        // The first line in the slice may be truncated; filter(Boolean) + JSON.parse catch handles it.
        const fd = await fs.promises.open(perfFile, 'r');
        const offset = stat.size - PERF_FILE_READ_LIMIT_BYTES;
        const buf = Buffer.alloc(PERF_FILE_READ_LIMIT_BYTES);
        await fd.read(buf, 0, PERF_FILE_READ_LIMIT_BYTES, offset);
        await fd.close();
        raw = buf.toString('utf8');
      } else {
        raw = await fs.promises.readFile(perfFile, 'utf8');
      }
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      return raw
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const entry = JSON.parse(line) as ToolCallTimingEntry;
            if (
              typeof entry.toolName !== 'string' ||
              typeof entry.startedAtMs !== 'number' ||
              typeof entry.durationMs !== 'number' ||
              (entry.outcome !== 'success' && entry.outcome !== 'error' && entry.outcome !== 'unknown_tool')
            ) return [];
            // Entries written before serverVersion was added get a fallback to avoid undefined at runtime
            const safeEntry: ToolCallTimingEntry = typeof entry.serverVersion === 'string'
              ? entry
              : { ...entry, serverVersion: 'unknown' };
            if (safeEntry.startedAtMs < cutoff) return [];
            return [safeEntry];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  const devMode = isDevMode();
  if (devMode) {
    app.get('/api/v2/perf/tool-calls', async (req: Request, res: Response) => {
      const rawLimit = req.query['limit'];
      const limit = typeof rawLimit === 'string' ? parseInt(rawLimit, 10) : undefined;
      const safeLimit = (limit !== undefined && Number.isFinite(limit) && limit > 0) ? limit : undefined;

      // Read from disk async (persistent store, filtered to 30d window)
      const diskEntries = toolCallsPerfFile ? await readDiskEntries(toolCallsPerfFile) : [];

      // Read from in-memory ring buffer (recent entries, may overlap with disk)
      const ringEntries = timingRingBuffer ? timingRingBuffer.recent(safeLimit) : [];

      // Enrich in-memory entries with serverVersion (ring buffer stores ToolCallTiming, not ToolCallTimingEntry)
      const version = serverVersion ?? 'unknown';
      const ringEntriesWithVersion: readonly ToolCallTimingEntry[] = ringEntries.map((t) => ({
        ...t,
        serverVersion: version,
      }));

      // Merge: prefer in-memory entries; dedupe disk entries that overlap.
      // Key includes durationMs to avoid false-positive dedup on same-ms parallel calls.
      const dedupeKey = (e: ToolCallTimingEntry) => `${e.toolName}:${e.startedAtMs}:${e.durationMs}`;
      const inMemoryKeys = new Set(ringEntriesWithVersion.map(dedupeKey));
      const diskOnlyEntries = diskEntries.filter((e) => !inMemoryKeys.has(dedupeKey(e)));

      // Combine: in-memory (newest-first) + disk-only entries (oldest-first from file)
      // Sort by startedAtMs descending so response is always newest-first.
      const allEntries: readonly ToolCallTimingEntry[] = [...ringEntriesWithVersion, ...diskOnlyEntries]
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .slice(0, safeLimit ?? undefined);

      res.json({ success: true, data: { observations: allEntries, devMode } });
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
   * Derives repo roots from the remembered-roots.json file, which records every
   * workspacePath passed to start_workflow. Each path is resolved to its canonical
   * git repo root via resolveRepoRoot(), so linked worktrees (e.g. .claude-worktrees/)
   * all collapse to their shared main repo. Result is deduplicated.
   *
   * This is the correct source of truth: only repos that have had actual sessions
   * appear, with no filesystem scanning needed.
   */
  async function discoverMainRepoRoots(): Promise<readonly string[]> {
    const dataDir = process.env['WORKRAIL_DATA_DIR']
      ?? path.join(process.env.HOME ?? '/tmp', '.workrail', 'data');
    const rootsFile = path.join(dataDir, 'workflow-sources', 'remembered-roots.json');

    let workspacePaths: string[] = [];
    try {
      const raw = await fs.promises.readFile(rootsFile, 'utf8');
      const parsed = JSON.parse(raw) as { roots?: { path: string }[] };
      workspacePaths = (parsed.roots ?? []).map((r) => r.path).filter(Boolean);
    } catch {
      return [];
    }

    // Resolve each workspace path to its canonical git repo root in parallel.
    // Linked worktrees resolve to the main repo, deduplicating automatically.
    const resolved = await Promise.all(workspacePaths.map((p) => resolveRepoRoot(p)));
    const roots = new Set(resolved.filter((r): r is string => r !== null));
    return [...roots];
  }

  /** Response timeout: discovery + scan must complete within this window.
   *  Set above PER_REPO_TIMEOUT_MS so fast repos return even if slow ones timeout. */
  const WORKTREES_REQUEST_TIMEOUT_MS = 12_000;

  app.get('/api/v2/worktrees', async (_req: Request, res: Response) => {
    // Timeout race: if the scan takes too long, return an empty repo list so the
    // client doesn't spin. The next poll will retry, and the in-flight scan result
    // will be cached by then.
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('worktrees scan timeout')), WORKTREES_REQUEST_TIMEOUT_MS);
    });

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
      if (timeoutId !== null) clearTimeout(timeoutId);
      res.json({ success: true, data });
    } catch (e) {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (e instanceof Error && e.message === 'worktrees scan timeout') {
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

  // ---------------------------------------------------------------------------
  // AUTO dispatch endpoint
  //
  // POST /api/v2/auto/dispatch
  //
  // Accepts a workflow dispatch request and fires it asynchronously. Returns
  // immediately -- the workflow runs in the background. The caller can track
  // progress via GET /api/v2/sessions once the daemon registers the session.
  //
  // Returns 503 when no V2ToolContext is available (daemon not running in same
  // process, or v2 tools disabled).
  // ---------------------------------------------------------------------------
  // POST /api/v2/auto/dispatch -- LOCAL DEVELOPER USE ONLY.
  // This endpoint has no auth. It is intentionally unprotected for local developer
  // use where the console HTTP server should be bound to 127.0.0.1 only (the default
  // HttpServer binding). Do NOT expose this port on a shared or production host.
  // TODO(security): add token auth before any multi-user deployment.
  app.post('/api/v2/auto/dispatch', express.json(), async (req: Request, res: Response) => {
    if (!v2ToolContext) {
      res.status(503).json({ success: false, error: 'Autonomous dispatch requires v2 tools enabled.' });
      return;
    }

    const body = req.body as { workflowId?: unknown; goal?: unknown; workspacePath?: unknown; context?: unknown };
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath.trim() : '';

    if (!workflowId || !goal || !workspacePath) {
      res.status(400).json({ success: false, error: 'workflowId, goal, and workspacePath are required.' });
      return;
    }

    // Validate workspacePath is an absolute path that exists on disk.
    // This is a local-developer-only feature; this check prevents obvious mistakes.
    const nodePath = await import('node:path');
    const nodeFs = await import('node:fs/promises');
    if (!nodePath.isAbsolute(workspacePath)) {
      res.status(400).json({ success: false, error: 'workspacePath must be an absolute path.' });
      return;
    }
    try {
      const stat = await nodeFs.stat(workspacePath);
      if (!stat.isDirectory()) {
        res.status(400).json({ success: false, error: 'workspacePath must be an existing directory.' });
        return;
      }
    } catch {
      res.status(400).json({ success: false, error: `workspacePath does not exist: ${workspacePath}` });
      return;
    }

    const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : undefined;

    // Resolve API key from environment -- the dispatch endpoint has the same
    // credential requirements as the daemon CLI.
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey && !process.env['AWS_PROFILE'] && !process.env['AWS_ACCESS_KEY_ID']) {
      res.status(503).json({ success: false, error: 'No LLM credentials available. Set ANTHROPIC_API_KEY or AWS_PROFILE.' });
      return;
    }

    // ---------------------------------------------------------------------------
    // Synchronous session creation: allocate a session ID before enqueuing the
    // agent loop. This allows returning a stable sessionHandle to the caller so
    // tools like `worktrain spawn` can track the session via GET /api/v2/sessions/:id.
    //
    // WHY synchronous: the session store write is fast (~10-50ms, no LLM call).
    // The agent loop still runs asynchronously -- only session creation is foreground.
    //
    // WHY executeStartWorkflow() here instead of inside runWorkflow(): runWorkflow()
    // calls executeStartWorkflow() internally. To avoid double-session-creation,
    // we pass the pre-allocated response via WorkflowTrigger._preAllocatedStartResponse.
    // runWorkflow() skips its own executeStartWorkflow() call when this field is set.
    // ---------------------------------------------------------------------------
    const startResult = await executeStartWorkflow(
      { workflowId, workspacePath, goal },
      v2ToolContext,
      // Mark as autonomous so isAutonomous is derivable from the event log.
      // workspacePath is written into the context_set event so the console can group sessions
      // by workspace even when workspace anchor resolution produces empty observations.
      { is_autonomous: 'true', workspacePath },
    );

    if (startResult.isErr()) {
      const errDetail = `${startResult.error.kind}${
        'message' in startResult.error ? `: ${(startResult.error as { message: string }).message}` : ''
      }`;
      res.status(400).json({ success: false, error: `Session creation failed: ${errDetail}` });
      return;
    }

    const startResponse = startResult.value.response;
    const startContinueToken = startResponse.continueToken;

    // Decode the session ID from the continueToken so we can return it as the handle.
    // WHY decode instead of returning sessionId from executeStartWorkflow directly:
    // The public V2StartWorkflowOutputSchema does not expose sessionId (to avoid a
    // breaking schema change). parseContinueTokenOrFail() is the established in-process
    // path used by workflow-runner.ts loadSessionNotes() for the same purpose.
    let sessionHandle: string;
    if (startContinueToken) {
      const tokenResult = await parseContinueTokenOrFail(
        startContinueToken,
        v2ToolContext.v2.tokenCodecPorts,
        v2ToolContext.v2.tokenAliasStore,
      );
      if (tokenResult.isErr()) {
        // This is an internal error -- the session was just created, the token
        // should always be decodable. Log and return 500 so the caller is informed.
        console.error(
          `[ConsoleRoutes] Failed to decode session handle from continueToken: ${tokenResult.error.message}`,
        );
        res.status(500).json({ success: false, error: 'Internal error: could not extract session handle.' });
        return;
      }
      sessionHandle = tokenResult.value.sessionId;
    } else {
      // isComplete=true on start means the workflow completed immediately (single-step).
      // No agent loop needed; use workflowId as a fallback handle.
      sessionHandle = workflowId;
    }

    // If TriggerRouter is available, use its queue (serializes by workflowId).
    // Otherwise, fire directly using the shared runWorkflow() function.
    // In both cases, pass _preAllocatedStartResponse to skip re-creating the session.
    const trigger = { workflowId, goal, workspacePath, context, _preAllocatedStartResponse: startResponse };
    if (triggerRouter) {
      triggerRouter.dispatch(trigger);
    } else {
      // Direct fire-and-forget: no queue serialization in this path.
      void runWorkflow(
        trigger,
        v2ToolContext,
        apiKey ?? '',
        undefined,   // daemonRegistry -- not available in this path
        undefined,   // emitter -- not available in this path
        steerRegistry,
      ).then((result) => {
        if (result._tag === 'success') {
          console.log(`[ConsoleRoutes] Auto dispatch completed: workflowId=${workflowId} stopReason=${result.stopReason}`);
        } else if (result._tag === 'delivery_failed') {
          // delivery_failed not expected here -- this path has no callbackUrl.
          // Handled to keep the union exhaustive after WorkflowRunResult was widened (GAP-3).
          // WHY soft handling (log-only, not assertNever): this is a fire-and-forget .then() callback
          // with no user-visible outcome; there is no parent LLM that acts on the result. Contrast
          // with makeSpawnAgentTool, which uses assertNever because the outcome is returned to the
          // parent LLM and silently mapping delivery_failed to success would corrupt the session.
          console.log(`[ConsoleRoutes] Auto dispatch delivery failed: workflowId=${workflowId}`);
        } else if (result._tag === 'timeout') {
          console.log(`[ConsoleRoutes] Auto dispatch timed out: workflowId=${workflowId}`);
        } else if (result._tag === 'error') {
          console.log(`[ConsoleRoutes] Auto dispatch failed: workflowId=${workflowId} error=${result.message}`);
        } else if (result._tag === 'stuck') {
          console.log(`[ConsoleRoutes] Auto dispatch stuck: workflowId=${workflowId} reason=${result.reason} message=${result.message}`);
        } else {
          // Compile-time exhaustiveness guard. If WorkflowRunResult gains a new variant
          // this will fail to compile, forcing the developer to handle the new case.
          // At runtime this is unreachable -- all current variants are handled above.
          assertNever(result);
        }
      });
    }

    res.json({ success: true, data: { status: 'dispatched', workflowId, sessionHandle } });
  });

  // ---------------------------------------------------------------------------
  // AUTO triggers list endpoint
  //
  // GET /api/v2/triggers
  //
  // Returns the current trigger index. When the trigger system is disabled
  // (no triggerRouter), returns an empty list rather than an error -- the
  // console handles the empty case gracefully.
  // ---------------------------------------------------------------------------
  app.get('/api/v2/triggers', (_req: Request, res: Response) => {
    if (!triggerRouter) {
      res.json({ success: true, data: { triggers: [] } });
      return;
    }

    const triggers = triggerRouter.listTriggers().map((t) => ({
      id: t.id,
      provider: t.provider,
      workflowId: t.workflowId,
      workspacePath: t.workspacePath,
      goal: t.goal,
    }));

    res.json({ success: true, data: { triggers } });
  });

  // ---------------------------------------------------------------------------
  // Trigger force-poll endpoint
  //
  // POST /api/v2/triggers/:triggerId/poll
  //
  // Forces one immediate poll cycle for the named github_queue_poll trigger,
  // bypassing the configured interval timer. Useful for manual testing and
  // for cases where operators want to trigger a cycle without restarting the daemon.
  //
  // Daemon-only: requires pollingScheduler to be provided at server startup.
  // Standalone console returns 503.
  //
  // Returns:
  //   200 { success: true, data: { cycleRan: boolean, triggerId: string } }
  //   400 if trigger not found or not a github_queue_poll trigger
  //   503 if pollingScheduler not available (standalone console)
  // ---------------------------------------------------------------------------
  app.post('/api/v2/triggers/:triggerId/poll', async (req: Request, res: Response) => {
    if (!pollingScheduler) {
      res.status(503).json({ success: false, error: 'Force poll not available (not a daemon context).' });
      return;
    }

    const triggerId = req.params['triggerId'] ?? '';
    if (!triggerId) {
      res.status(400).json({ success: false, error: 'Missing triggerId' });
      return;
    }

    const result = await pollingScheduler.forcePoll(triggerId);

    switch (result.kind) {
      case 'ok':
        res.json({
          success: true,
          data: {
            triggerId,
            cycleRan: result.cycleRan,
            message: result.cycleRan
              ? `Poll cycle started for trigger '${triggerId}'.`
              : `Poll cycle skipped for trigger '${triggerId}' -- a previous cycle is still running.`,
          },
        });
        return;
      case 'not_found':
        res.status(400).json({ success: false, error: `Trigger '${triggerId}' not found` });
        return;
      case 'wrong_provider':
        res.status(400).json({
          success: false,
          error: `Trigger '${triggerId}' is not a queue poll trigger (provider: ${result.provider})`,
        });
        return;
      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = result;
        res.status(500).json({ success: false, error: 'Unexpected forcePoll result' });
        void _exhaustive;
        return;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Session steer endpoint
  //
  // POST /api/v2/sessions/:sessionId/steer
  //
  // Injects text into a running daemon session's next agent turn. The coordinator
  // calls this endpoint between a session's complete_step() call and the daemon's
  // next agent.steer() invocation. The injected text is concatenated with the step
  // advance text and delivered in a single steer message on the next turn_end event.
  //
  // Daemon-only: requires steerRegistry to be provided at server startup (i.e., the
  // daemon passes it via mountConsoleRoutes). Standalone console returns 503.
  //
  // Auth: localhost-only (127.0.0.1 binding in daemon-console.ts). No token auth in v1.
  // TODO(v2): Add token auth before any multi-user or remote deployment.
  //
  // Registration gap: sessions register their steer callback ~50ms after creation.
  // A coordinator calling this endpoint immediately after POST /auto/dispatch may
  // receive 404. Retry once on 404 during session start-up.
  //
  // MCP-mode sessions do not register callbacks -- this endpoint returns 404 for them.
  // TODO(v2): Extend to MCP-mode sessions if mid-step injection proves necessary.
  // ---------------------------------------------------------------------------
  app.post('/api/v2/sessions/:sessionId/steer', express.json(), (req: Request, res: Response) => {
    if (!steerRegistry) {
      res.status(503).json({ success: false, error: 'Steer not available (not a daemon context).' });
      return;
    }
    const { sessionId } = req.params;
    const body = req.body as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ success: false, error: 'text is required and must be a non-empty string.' });
      return;
    }
    const callback = steerRegistry.get(sessionId);
    if (!callback) {
      res.status(404).json({ success: false, error: 'Session not found or not a daemon session.' });
      return;
    }
    callback(text);
    res.json({ success: true });
  });

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

  return stopWatcher;
}
