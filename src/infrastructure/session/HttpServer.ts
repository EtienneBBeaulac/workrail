import express, { Application, Request, Response } from 'express';
import { createServer, Server as HttpServerType } from 'http';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { singleton, inject } from 'tsyringe';
import { DI } from '../../di/tokens.js';
import { SessionManager } from './SessionManager.js';
import type { ProcessLifecyclePolicy } from '../../runtime/process-lifecycle-policy.js';
import type { ProcessSignal, ProcessSignals } from '../../runtime/ports/process-signals.js';
import type { ShutdownEvents } from '../../runtime/ports/shutdown-events.js';
import { DashboardHeartbeat } from './DashboardHeartbeat.js';
import { releaseLockFile, releaseLockFileSync } from './DashboardLockRelease.js';
import cors from 'cors';
import open from 'open';
import { execSync } from 'child_process';

// Resolve package version at module load time.
// __dirname is available in CommonJS (the compile target for this project).
// The path resolves to src/infrastructure/session -> ../../../package.json.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _pkg = require(path.join(__dirname, '../../../package.json')) as { version: string };
const CURRENT_VERSION: string = _pkg.version;

export type DashboardMode = { kind: 'unified' } | { kind: 'legacy' };
export type BrowserBehavior = { kind: 'auto_open' } | { kind: 'manual' };

export interface ServerConfig {
  port?: number;
  browserBehavior?: BrowserBehavior;
  dashboardMode?: DashboardMode;
  /**
   * Override the dashboard lock file location.
   *
   * WHY: tests may run in parallel and must not share a single global lock file.
   */
  lockFilePath?: string;
}

interface DashboardLock {
  pid: number;
  port: number;
  startedAt: string;
  lastHeartbeat: string; // Track last activity for TTL-based cleanup
  projectId: string;
  projectPath: string;
  /** Package version of the process that owns the lock. Used to reclaim on upgrade. */
  version?: string;
}

/**
 * HttpServer serves the dashboard UI and provides API endpoints for session data.
 * 
 * Routes:
 * - GET / -> Dashboard home page
 * - GET /web/* -> Static dashboard assets
 * - GET /api/sessions -> List all sessions (unified: all projects)
 * - GET /api/sessions/:workflow/:id -> Get specific session
 * - GET /api/current-project -> Get current project info
 * - GET /api/projects -> List all projects
 * 
 * Features:
 * - Unified dashboard (primary/secondary pattern)
 * - First instance becomes primary on port 3456
 * - Subsequent instances skip HTTP server
 * - Auto-recovery from crashed primary
 * - Falls back to legacy mode if needed
 * - ETag support for efficient polling
 * - CORS enabled for local development
 */
@singleton()
export class HttpServer {
  private app: Application;
  private server: HttpServerType | null = null;
  private port: number;
  private baseUrl: string = '';
  private isPrimary: boolean = false;
  private lockFile: string;
  private heartbeat: DashboardHeartbeat;

  /**
   * Cached in-flight stop Promise for idempotency.
   *
   * HttpServer has a one-shot lifecycle: start once, stop once. If stop() is
   * called a second time (e.g. from the double SIGTERM race where both
   * wireShutdownHooks and setupPrimaryCleanup fire), both callers must join
   * the same in-flight teardown rather than starting a second one.
   *
   * This field is set the first time stop() runs actual teardown (server
   * non-null). Pre-start no-op calls (server === null) return a fresh
   * Promise.resolve() without caching -- otherwise a post-start stop would
   * return the pre-resolved Promise and skip teardown.
   *
   * NOTE: If restart-in-place is ever added (start -> stop -> start -> stop),
   * start() must reset this field to null so the second stop() runs teardown.
   */
  private _stopPromise: Promise<void> | null = null;
  
  constructor(
    @inject(SessionManager) private sessionManager: SessionManager,
    @inject(DI.Runtime.ProcessLifecyclePolicy)
    private readonly processLifecyclePolicy: ProcessLifecyclePolicy,
    @inject(DI.Runtime.ProcessSignals)
    private readonly processSignals: ProcessSignals,
    @inject(DI.Runtime.ShutdownEvents)
    private readonly shutdownEvents: ShutdownEvents,
    @inject(DI.Config.DashboardMode)
    private readonly dashboardMode: DashboardMode,
    @inject(DI.Config.BrowserBehavior)
    private readonly browserBehavior: BrowserBehavior
  ) {
    // Config is set via setConfig() or defaults to empty object
    this.port = 3456; // Default port
    this.lockFile = path.join(os.homedir(), '.workrail', 'dashboard.lock');
    this.heartbeat = new DashboardHeartbeat(this.lockFile, () => this.isPrimary);
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }
  
  private config: ServerConfig = {};
  
  /**
   * Set server configuration (for manual construction in tests)
   * Must be called before start() if config is needed
   */
  setConfig(config: ServerConfig): this {
    this.config = config;
    if (config.port) {
      this.port = config.port;
    }
    if (config.lockFilePath) {
      this.lockFile = config.lockFilePath;
      this.heartbeat = new DashboardHeartbeat(this.lockFile, () => this.isPrimary);
    }
    return this;
  }
  
  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // CORS for local development
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'If-None-Match']
    }));
    
    // ETag support for efficient polling
    this.app.set('etag', 'strong');
    
    // JSON parsing
    this.app.use(express.json());
    
    // Logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        try { process.stderr.write(`[HTTP] ${req.method} ${req.path} ${res.statusCode} (${duration}ms)\n`); } catch { /* ignore */ }
      });
      next();
    });
  }
  
  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Root redirects to the console — the legacy web/ UI has been retired.
    this.app.get('/', (_req: Request, res: Response) => {
      res.redirect('/console');
    });
    
    // API: List all sessions (unified: all projects when primary, current project otherwise)
    this.app.get('/api/sessions', async (req: Request, res: Response) => {
      try {
        // If primary, return sessions from all projects
        // If secondary/legacy, return only current project sessions
        const sessions = this.isPrimary
          ? await this.sessionManager.listAllProjectsSessions()
          : await this.sessionManager.listAllSessions();
          
        res.json({
          success: true,
          count: sessions.length,
          unified: this.isPrimary, // Indicate if this is unified view
          sessions: sessions.map(s => ({
            id: s.id,
            workflowId: s.workflowId,
            projectId: s.projectId,
            projectPath: s.projectPath,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            url: `/api/sessions/${s.workflowId}/${s.id}`,
            // Include dashboard summary for preview cards
            data: {
              dashboard: s.data?.dashboard || {}
            }
          }))
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: 'Failed to list sessions',
          message: error.message
        });
      }
    });
    
    // API: Get specific session
    this.app.get('/api/sessions/:workflow/:id', async (req: Request, res: Response) => {
      try {
        const { workflow, id } = req.params;
        const session = await this.sessionManager.getSession(workflow, id);
        
        if (!session) {
          return res.status(404).json({
            success: false,
            error: 'Session not found',
            workflowId: workflow,
            sessionId: id
          });
        }
        
        res.json({
          success: true,
          session
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: 'Failed to get session',
          message: error.message
        });
      }
    });
    
    // API: Get current project info
    this.app.get('/api/current-project', async (req: Request, res: Response) => {
      try {
        const project = await this.sessionManager.getCurrentProject();
        res.json({
          success: true,
          project
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: 'Failed to get project info',
          message: error.message
        });
      }
    });
    
    // API: List all projects
    this.app.get('/api/projects', async (req: Request, res: Response) => {
      try {
        const projects = await this.sessionManager.listProjects();
        res.json({
          success: true,
          count: projects.length,
          projects
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: 'Failed to list projects',
          message: error.message
        });
      }
    });
    
    // SSE: Stream session updates in real-time
    // BUG FIX #1: Fixed resource leak on client disconnect
    // - Added cleanup flag to prevent double-cleanup and detect stale state
    // - Added error handlers on req, res, and write operations
    // - Added max connection timeout (30 minutes)
    // - Added res.writableEnded check before writes
    // - Calls unwatchSession on cleanup
    this.app.get('/api/sessions/:workflow/:id/stream', async (req: Request, res: Response) => {
      const { workflow, id } = req.params;
      
      // Track cleanup state to prevent resource leaks
      let isCleanedUp = false;
      let keepaliveInterval: NodeJS.Timeout | null = null;
      let maxConnectionTimeout: NodeJS.Timeout | null = null;
      
      // Centralized cleanup function - safe to call multiple times
      const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        
        // Clear timers
        if (keepaliveInterval) {
          clearInterval(keepaliveInterval);
          keepaliveInterval = null;
        }
        if (maxConnectionTimeout) {
          clearTimeout(maxConnectionTimeout);
          maxConnectionTimeout = null;
        }
        
        // Detach event listener (safe even if never attached)
        try {
          this.sessionManager.off('session:updated', onUpdate);
        } catch {}
        
        // Stop watching (safe even if never started)
        try {
          this.sessionManager.unwatchSession(workflow, id);
        } catch {}
        
        // End response if still writable
        try {
          if (!res.writableEnded) {
            res.end();
          }
        } catch {}
      };
      
      // Update handler - checks cleanup state and writableEnded
      const onUpdate = (event: { workflowId: string; sessionId: string; session: any }) => {
        // Skip if cleaned up or not our session
        if (isCleanedUp || event.workflowId !== workflow || event.sessionId !== id) {
          return;
        }
        
        // Check if response is still writable
        if (res.writableEnded) {
          cleanup();
          return;
        }
        
        // Try to write, cleanup on error
        try {
          res.write(`data: ${JSON.stringify({ type: 'update', session: event.session })}\n\n`);
        } catch (error) {
          try { process.stderr.write(`[SSE] Write error for ${workflow}/${id}: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
          cleanup();
        }
      };

      // Safe write helper
      const safeWrite = (data: string): boolean => {
        if (isCleanedUp || res.writableEnded) {
          cleanup();
          return false;
        }
        try {
          res.write(data);
          return true;
        } catch (error) {
          try { process.stderr.write(`[SSE] Write error for ${workflow}/${id}: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
          cleanup();
          return false;
        }
      };

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      // Set max connection time (30 minutes) to prevent indefinite resource hold
      maxConnectionTimeout = setTimeout(() => {
        try { process.stderr.write(`[SSE] Max connection time reached for ${workflow}/${id}, closing\n`); } catch { /* ignore */ }
        cleanup();
      }, 30 * 60 * 1000);
      
      // Send initial connection message
      if (!safeWrite(`data: ${JSON.stringify({ type: 'connected', workflowId: workflow, sessionId: id })}\n\n`)) {
        return; // Connection failed immediately
      }
      
      // Send current session state immediately
      try {
        const session = await this.sessionManager.getSession(workflow, id);
        if (session && !isCleanedUp) {
          safeWrite(`data: ${JSON.stringify({ type: 'update', session })}\n\n`);
        }
      } catch (error) {
        // Session might not exist yet - continue anyway
      }
      
      // Attach update listener
      this.sessionManager.on('session:updated', onUpdate);
      
      // Start watching this session
      this.sessionManager.watchSession(workflow, id);
      
      // Send keepalive every 30 seconds
      keepaliveInterval = setInterval(() => {
        if (!safeWrite(`:keepalive\n\n`)) {
          // Write failed, cleanup already called
        }
      }, 30000);
      
      // Attach cleanup handlers for all disconnect scenarios
      req.on('close', cleanup);
      req.on('error', (error) => {
        try { process.stderr.write(`[SSE] Request error for ${workflow}/${id}: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
        cleanup();
      });
      res.on('error', (error) => {
        try { process.stderr.write(`[SSE] Response error for ${workflow}/${id}: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
        cleanup();
      });
      res.on('finish', cleanup);
    });
    
    // Delete a single session
    this.app.delete('/api/sessions/:workflow/:id', async (req: Request, res: Response) => {
      try {
        const { workflow, id } = req.params;
        
        const result = await this.sessionManager.deleteSession(workflow, id);
        
        if (result.isErr()) {
          const status = result.error.code === 'SESSION_NOT_FOUND' ? 404 : 500;
          res.status(status).json({ success: false, error: result.error.message });
          return;
        }
        
        res.json({
          success: true,
          message: `Session ${workflow}/${id} deleted successfully`
        });
      } catch (error: any) {
        try { process.stderr.write(`[HttpServer] Delete session error: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to delete session'
        });
      }
    });

    // Bulk delete sessions
    this.app.post('/api/sessions/bulk-delete', async (req: Request, res: Response) => {
      try {
        const { sessions } = req.body;

        if (!Array.isArray(sessions)) {
          return res.status(400).json({
            success: false,
            error: 'Body must contain "sessions" array'
          });
        }

        await this.sessionManager.deleteSessions(sessions);

        res.json({
          success: true,
          message: `Deleted ${sessions.length} session(s)`,
          count: sessions.length
        });
      } catch (error: any) {
        try { process.stderr.write(`[HttpServer] Bulk delete error: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to delete sessions'
        });
      }
    });
    
    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        success: true,
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        isPrimary: this.isPrimary,
        pid: process.pid,
        port: this.port,
        version: CURRENT_VERSION
      });
    });
    
    // NOTE: 404 handler is installed by finalize() after all mountRoutes() calls.
  }
  
  /**
   * Start the HTTP server
   * Uses unified dashboard pattern (primary/secondary) unless disabled
   */
  async start(): Promise<string | null> {
    // Reset the stop Promise so a future stop() call runs real teardown.
    // Restart-in-place is not a supported lifecycle, but this guard prevents
    // a silent no-op if stop() were ever called after a re-start.
    this._stopPromise = null;

    // Check dashboard mode (DI-provided, not env check)
    const mode = this.config.dashboardMode ?? this.dashboardMode;
    if (mode.kind === 'legacy') {
      try { process.stderr.write('[Dashboard] Unified dashboard disabled, using legacy mode\n'); } catch { /* ignore */ }
      return await this.startLegacyMode();
    }

    // Try to become primary
    if (await this.tryBecomePrimary()) {
      try {
        await this.startAsPrimary();
        return this.baseUrl;
      } catch (error: any) {
        if (error.code === 'EADDRINUSE') {
          // Port busy despite winning the lock -- the previous primary is still
          // bound to the port (e.g. version upgrade: old instance holds 3456,
          // new instance reclaimed the lock but can't bind yet). Fall back to
          // legacy mode so both instances can run concurrently. The old instance
          // will release the port when its IDE tab closes (stdin EOF).
          try { process.stderr.write(
            `[Dashboard] Port ${this.port} still held by previous instance -- ` +
            `running on next available port. Restart the old instance to move to ${this.port}.\n`
          ); } catch { /* ignore */ }
          await fs.unlink(this.lockFile).catch(() => {});
          return await this.startLegacyMode();
        }
        throw error;
      }
    } else {
      // Secondary mode - dashboard already running
      try { process.stderr.write(`[Dashboard] Unified dashboard at http://localhost:${this.port}\n`); } catch { /* ignore */ }
      return null;
    }
  }
  
  /**
   * Try to become the primary dashboard
   */
  private async tryBecomePrimary(): Promise<boolean> {
    try {
      // Ensure .workrail directory exists
      await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
      
      // Try to create lock file atomically
      const lockData: DashboardLock = {
        pid: process.pid,
        port: this.port,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        projectId: this.sessionManager.getProjectId(),
        projectPath: this.sessionManager.getProjectPath(),
        version: CURRENT_VERSION
      };

      await fs.writeFile(this.lockFile, JSON.stringify(lockData, null, 2), { flag: 'wx' });
      
      // Success! We are primary
      try { process.stderr.write('[Dashboard] Primary elected\n'); } catch { /* ignore */ }
      this.isPrimary = true;
      this.setupPrimaryCleanup();
      this.heartbeat.start();
      return true;

    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock exists, check if it's stale
        return await this.reclaimStaleLock();
      } else if (error.code === 'EACCES' || error.code === 'EPERM') {
        // Permission denied
        try { process.stderr.write('[Dashboard] Cannot write lock file (permission denied)\n'); } catch { /* ignore */ }
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Determine if a lock should be reclaimed based on its data.
   *
   * Pure function - no side effects, no I/O.
   *
   * Note: this function intentionally does NOT probe the HTTP health endpoint.
   * HTTP responsiveness is not a reliable liveness signal -- Node.js is
   * single-threaded, so a busy event loop (e.g. processing a tool call) will
   * fail a health check while the process is perfectly healthy. The three
   * checks below (structure, version, TTL, PID) are reliable and sufficient.
   * Adding an HTTP check here caused false-positive kills; see the fix in
   * reclaimStaleLock() for full rationale.
   */
  private shouldReclaimLock(lockData: DashboardLock): { reclaim: boolean; reason: string } {
    // Invalid structure
    if (!lockData.pid || !lockData.port || !lockData.startedAt) {
      return { reclaim: true, reason: 'invalid lock structure' };
    }

    // Cross-project guard: never reclaim from a live process that belongs to a
    // different project. Different IDEs, worktrees, and integrations (e.g. firebender)
    // may each spawn their own workrail instance with their own cwd/projectId. A
    // different-project instance must never kill the primary server — it should yield
    // regardless of version differences or port preferences.
    //
    // We only apply this check when the lock carries a projectId (written by
    // 3.22.0+). Locks without a projectId fall through to the original logic.
    if (lockData.projectId) {
      const currentProjectId = this.sessionManager.getProjectId();
      if (lockData.projectId !== currentProjectId) {
        try {
          process.kill(lockData.pid, 0); // signal 0 = existence check only
          // Different project AND process is alive: yield unconditionally.
          return { reclaim: false, reason: `different project, primary alive (lock=${lockData.projectId}, current=${currentProjectId})` };
        } catch {
          // Process is dead — reclaim regardless of project difference.
        }
      }
    }

    // Version mismatch: a different version holds the lock. We reclaim atomically
    // so the new version's lock metadata is current. If the old process still holds
    // the port, startAsPrimary() will EADDRINUSE and fall back to legacy mode --
    // the old instance keeps its port and sessions until it exits naturally.
    // undefined means the lock was written by a pre-version-field build -- treat
    // it the same as "wrong version" so the fix takes effect on first deployment.
    if (lockData.version !== CURRENT_VERSION) {
      return { reclaim: true, reason: `version mismatch (lock=${lockData.version}, current=${CURRENT_VERSION})` };
    }

    // Stale by TTL (no heartbeat for 2+ minutes)
    const lastHeartbeat = new Date(lockData.lastHeartbeat || lockData.startedAt);
    const ageMinutes = (Date.now() - lastHeartbeat.getTime()) / 60000;
    if (ageMinutes > 2) {
      return { reclaim: true, reason: `stale (${ageMinutes.toFixed(1)}min old)` };
    }
    
    // Process dead
    try {
      process.kill(lockData.pid, 0); // Signal 0 = check existence only
    } catch {
      return { reclaim: true, reason: `PID ${lockData.pid} dead` };
    }
    
    // Lock is valid
    return { reclaim: false, reason: 'valid' };
  }

  /**
   * Check if existing lock is stale and reclaim if possible
   * 
   * BUG FIX #4: Use atomic rename instead of delete-then-create
   * - Previous: unlink() then tryBecomePrimary() created race window
   * - Now: Write to temp file, atomic rename to lock file
   * - If rename fails, another process won the race (safe)
   * - Follows same atomic pattern as SessionManager.atomicWrite()
   */
  private async reclaimStaleLock(): Promise<boolean> {
    try {
      const lockContent = await fs.readFile(this.lockFile, 'utf-8');
      const lockData: DashboardLock = JSON.parse(lockContent);
      
      const { reclaim, reason } = this.shouldReclaimLock(lockData);
      
      if (!reclaim) {
        // shouldReclaimLock() already confirmed: version matches, heartbeat is fresh,
        // and the PID is alive. These three signals are reliable liveness proof.
        // HTTP responsiveness is NOT a reliable signal -- a busy event loop (e.g.
        // processing a tool call) will fail a 2s health check while the process is
        // perfectly healthy. Yield unconditionally to the existing primary.
        //
        // WHY process.stderr.write: reclaimStaleLock runs during startup. If the MCP
        // client disconnects immediately after spawning, stderr may be a broken pipe.
        // console.error() would throw EPIPE here (confirmed in crash.log). See printBanner().
        try { process.stderr.write(`[Dashboard] Secondary mode: primary lock valid (PID ${lockData.pid}), yielding\n`); } catch { /* ignore */ }
        return false;
      } else {
        // shouldReclaimLock() determined the lock should be reclaimed (version mismatch,
        // stale TTL, or dead PID). Proceed directly to atomic reclaim -- do not SIGTERM.
        //
        // Rationale: the old primary is either already dead (dead-PID case) or still
        // serving active MCP sessions that must not be interrupted. If it holds port
        // 3456, startAsPrimary() will throw EADDRINUSE and fall back to legacy mode on
        // port 3457+. That is the correct outcome -- the old instance keeps its port
        // and its sessions; the new instance starts on an available port.
        try { process.stderr.write(`[Dashboard] Lock reclaim needed: ${reason}\n`); } catch { /* ignore */ }
      }

      // ATOMIC RECLAIM: Write new lock to temp file, then rename
      // This prevents race where multiple processes try to reclaim simultaneously
      const tempPath = `${this.lockFile}.${process.pid}.${Date.now()}`;
      const newLockData: DashboardLock = {
        pid: process.pid,
        port: this.port,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        projectId: this.sessionManager.getProjectId(),
        projectPath: this.sessionManager.getProjectPath(),
        version: CURRENT_VERSION
      };
      
      try {
        // Write to temp file first
        await fs.writeFile(tempPath, JSON.stringify(newLockData, null, 2));
        
        // Rename (atomic on POSIX; best-effort on Windows with retry)
        let retries = 3;
        let renamed = false;
        while (retries > 0 && !renamed) {
          try {
            await fs.rename(tempPath, this.lockFile);
            renamed = true;
          } catch (err: any) {
            if (err.code === 'EPERM' && process.platform === 'win32' && retries > 1) {
              await new Promise(resolve => setTimeout(resolve, 10));
              retries--;
              continue;
            }
            throw err;
          }
        }
        
        // POST-RENAME PID VERIFICATION: Confirm we actually won the election.
        //
        // WHY: POSIX rename is unconditional -- it always succeeds, even when multiple
        // processes race to rename the same destination. The last rename wins; all
        // others also see success (no EEXIST on rename). Without this check, every
        // concurrent process that called rename would set isPrimary = true, resulting
        // in multiple primaries fighting over port 3456.
        //
        // By reading back the lock and checking that our PID is in it, we confirm we
        // were the last renamer (the winner). Any loser will see a different PID and
        // correctly yield with return false.
        //
        // Race: the tombstone/heartbeat could write between our rename and read-back,
        // but neither changes the PID field, so the check is still correct.
        try {
          const writtenContent = await fs.readFile(this.lockFile, 'utf-8');
          const writtenData: DashboardLock = JSON.parse(writtenContent);
          if (writtenData.pid !== process.pid) {
            // Another process renamed over us — they won the election.
            try { process.stderr.write(`[Dashboard] Lost lock election (winner PID ${writtenData.pid}), yielding\n`); } catch { /* ignore */ }
            return false;
          }
        } catch {
          // Read-back failed (ENOENT: file deleted by another process, or JSON parse error).
          // Safest action: yield and retry fresh rather than claiming primary status we may not hold.
          return await this.tryBecomePrimary();
        }

        try { process.stderr.write('[Dashboard] Lock reclaimed successfully\n'); } catch { /* ignore */ }
        this.isPrimary = true;
        this.setupPrimaryCleanup();
        this.heartbeat.start();
        return true;

      } catch (error: any) {
        // Clean up temp file on any error
        await fs.unlink(tempPath).catch(() => {});

        if (error.code === 'ENOENT') {
          // Lock file was deleted by another process - try fresh
          try { process.stderr.write('[Dashboard] Lock deleted during reclaim, trying fresh\n'); } catch { /* ignore */ }
          return await this.tryBecomePrimary();
        }

        // Other error (permission, disk full, etc.)
        try { process.stderr.write(`[Dashboard] Lock reclaim failed: ${(error as Error).message}\n`); } catch { /* ignore */ }
        return false;
      }

    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Lock file deleted - try to become primary fresh
        return await this.tryBecomePrimary();
      }

      // Corrupt JSON or other read error
      try { process.stderr.write('[Dashboard] Lock file corrupted, attempting fresh claim\n'); } catch { /* ignore */ }
      await fs.unlink(this.lockFile).catch(() => {});
      return await this.tryBecomePrimary();
    }
  }
  
  /**
   * Setup cleanup handlers for primary
   * 
   * BUG FIX #5: Separate sync and async cleanup handlers
   * - 'exit' event CANNOT wait for async operations (Node.js constraint)
   * - Signal handlers can run async cleanup; process termination is handled by the composition root
   * - Uses sync fs.unlinkSync for 'exit' handler
   * - Prevents double-cleanup with isCleaningUp flag
   */
  private setupPrimaryCleanup(): void {
    // Signal handlers are a process-level concern.
    // Whether we install them is an injected policy decision, not a hidden env-branch.
    if (this.processLifecyclePolicy.kind === 'no_signal_handlers') {
      return;
    }

    let isCleaningUp = false;
    
    // SYNC cleanup for 'exit' event - cannot be async per Node.js docs
    // "The 'exit' event listener functions must only perform synchronous operations"
    //
    // WHY process.stderr.write with try/catch instead of console.error:
    // This runs at process exit, when the MCP client pipe may already be broken.
    // console.error() on a broken pipe throws EPIPE with no handler, which crashes
    // the process via uncaughtException *during* cleanup. See printBanner() and
    // reclaimStaleLock() for the same pattern. See fatal-exit.ts for full rationale.
    const cleanupSync = () => {
      if (isCleaningUp || !this.isPrimary) return;
      isCleaningUp = true;

      try { process.stderr.write('[Dashboard] Primary shutting down (sync cleanup)\n'); } catch { /* ignore */ }

      // Stop heartbeat
      this.heartbeat.stop();

      // SYNC file delete only - async won't complete before process exits
      try {
        releaseLockFileSync(this.lockFile);
        try { process.stderr.write('[Dashboard] Lock file released\n'); } catch { /* ignore */ }
      } catch (error: any) {
        // Ignore ENOENT (file already deleted) but log others
        if (error.code !== 'ENOENT') {
          try { process.stderr.write(`[Dashboard] Failed to release lock file: ${(error as Error).message}\n`); } catch { /* ignore */ }
        }
      }

      this.isPrimary = false;
    };

    // Signal handler: stop the server and emit a typed shutdown request.
    // IMPORTANT: HttpServer does NOT terminate the process. The composition root decides.
    //
    // WHY process.stderr.write: see cleanupSync above for full rationale.
    const signalHandler = (signal: ProcessSignal) => {
      if (isCleaningUp) return;
      isCleaningUp = true;

      try { process.stderr.write(`[Dashboard] Received ${signal}\n`); } catch { /* ignore */ }
      this.stop()
        .catch(err => { try { process.stderr.write(`[Dashboard] Cleanup error: ${(err as Error).message}\n`); } catch { /* ignore */ } })
        .finally(() => {
          if (signal !== 'exit') {
            this.shutdownEvents.emit({ kind: 'shutdown_requested', signal });
          }
        });
    };
    
    // 'exit' uses sync cleanup (Node.js won't wait for async)
    this.processSignals.on('exit', cleanupSync);
    
    // Signals use async cleanup then explicitly exit
    this.processSignals.on('SIGINT', () => signalHandler('SIGINT'));
    this.processSignals.on('SIGTERM', () => signalHandler('SIGTERM'));
    this.processSignals.on('SIGHUP', () => signalHandler('SIGHUP'));
  }
  
  /**
   * Start as primary dashboard
   */
  private async startAsPrimary(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = createServer(this.app);
      
      this.server.on('error', (error: any) => {
        reject(error);
      });
      
      const listenPort = this.port;
      this.server.listen(listenPort, '127.0.0.1', () => {
        this.baseUrl = `http://localhost:${listenPort}`;
        this.printBanner();
        resolve();
      });
    });
  }
  
  /**
   * Legacy mode: auto-increment ports 3457-3499
   */
  private async startLegacyMode(): Promise<string> {
    this.port = 3457; // Start from 3457 in legacy mode
    
    while (this.port < 3500) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server = createServer(this.app);
          
          this.server.on('error', (error: any) => {
            if (error.code === 'EADDRINUSE') {
              reject(new Error('Port in use'));
            } else {
              reject(error);
            }
          });
          
          this.server.listen(this.port, '127.0.0.1', () => {
            resolve();
          });
        });
        
        this.baseUrl = `http://localhost:${this.port}`;
        try { process.stderr.write(`[Dashboard] Started in legacy mode on port ${this.port}\n`); } catch { /* ignore */ }
        this.printBanner();
        return this.baseUrl;
        
      } catch (error: any) {
        if (error.message === 'Port in use') {
          this.port++;
          continue;
        }
        throw error;
      }
    }
    
    // Clear the last failed server so it doesn't linger with a dangling
    // error listener. The server never started listening so no close() needed.
    this.server = null;
    throw new Error('No available ports in range 3457-3499');
  }
  
  /**
   * Print startup banner
   *
   * WHY process.stderr.write with try/catch instead of console.error:
   * This runs right after the HTTP server starts listening. If the MCP client
   * disconnects almost immediately (fast restart, test reconnect), both stdout
   * and stderr pipes may already be broken. console.error() writes through
   * Node's console.value() which does a synchronous socket write -- on a broken
   * pipe it throws EPIPE with no handler, crashing the process. Confirmed in
   * crash.log. See shutdown-hooks.ts for the full pattern explanation.
   */
  private printBanner(): void {
    const line = '═'.repeat(60);
    try { process.stderr.write(`\n${line}\n`); } catch { /* ignore */ }
    try { process.stderr.write(`🔧 Workrail MCP Server Started\n`); } catch { /* ignore */ }
    try { process.stderr.write(`${line}\n`); } catch { /* ignore */ }
    try { process.stderr.write(`📊 Dashboard: ${this.baseUrl} ${this.isPrimary ? '(PRIMARY - All Projects)' : '(Legacy Mode)'}\n`); } catch { /* ignore */ }
    try { process.stderr.write(`💾 Sessions:  ${this.sessionManager.getSessionsRoot()}\n`); } catch { /* ignore */ }
    try { process.stderr.write(`🏗️  Project:   ${this.sessionManager.getProjectId()}\n`); } catch { /* ignore */ }
    try { process.stderr.write(`${line}\n\n`); } catch { /* ignore */ }
  }
  
  /**
   * Open dashboard in browser
   */
  async openDashboard(sessionId?: string): Promise<string> {
    if (!this.baseUrl) {
      throw new Error(
        'Dashboard is unavailable -- the HTTP server did not start successfully ' +
        '(likely due to port exhaustion). MCP tools still work normally.',
      );
    }

    let url = this.baseUrl;

    if (sessionId) {
      url += `?session=${sessionId}`;
    }

    const behavior = this.config.browserBehavior ?? this.browserBehavior;
    if (behavior.kind === 'auto_open') {
      try {
        await open(url);
        try { process.stderr.write(`Opened dashboard: ${url}\n`); } catch { /* ignore */ }
      } catch (error) {
        try { process.stderr.write(`Dashboard URL: ${url} (auto-open failed, please open manually)\n`); } catch { /* ignore */ }
      }
    }
    
    return url;
  }
  
  /**
   * Stop the HTTP server.
   *
   * Idempotent: calling stop() more than once (e.g. from concurrent SIGTERM
   * handlers) joins the same in-flight teardown rather than starting a second
   * one. See _stopPromise for the lifecycle invariant.
   */
  async stop(): Promise<void> {
    // Return cached Promise if teardown is already in flight or complete.
    if (this._stopPromise !== null) return this._stopPromise;

    // Pre-start no-op: server was never started. Return resolved Promise
    // without caching so a later start() + stop() runs real teardown.
    if (this.server === null) return Promise.resolve();

    // Real teardown path -- cache the Promise so concurrent callers join it.
    this._stopPromise = this._runStop();
    return this._stopPromise;
  }

  private async _runStop(): Promise<void> {
    // 1. FIRST: Stop heartbeat to prevent further lock file writes
    this.heartbeat.stop();
    
    // 2. Stop all file watchers (session manager + any route-level disposers, e.g. console SSE watcher)
    this.sessionManager.unwatchAll();
    for (const dispose of this._routeDisposers) {
      try { dispose(); } catch { /* ignore errors during shutdown */ }
    }
    this._routeDisposers.length = 0;
    
    // 3. Close server with timeout protection
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();

      // Timeout to prevent hanging if server.close() never completes
      const closeTimeout = setTimeout(() => {
        try { process.stderr.write('[Dashboard] Server close timeout after 5s, forcing shutdown\n'); } catch { /* ignore */ }
        resolve();
      }, 5000);

      this.server.close(() => {
        clearTimeout(closeTimeout);
        try { process.stderr.write('HTTP server stopped\n'); } catch { /* ignore */ }
        resolve();
      });
    });

    // 4. Release lock file when we were primary (so tests/CLI can stop cleanly)
    if (this.isPrimary) {
      await releaseLockFile(this.lockFile).catch(() => {});
      this.isPrimary = false;
    }
  }
  
  /**
   * Get the base URL
   */
  /**
   * Mount additional routes on the Express app.
   * Used by Console and other extensions that need to add routes
   * without coupling to the HttpServer class.
   *
   * The installer may return a disposer (() => void) that will be called
   * during stop() to clean up resources (e.g. FSWatcher instances).
   * This keeps resource lifecycle tied to the server lifecycle rather than
   * relying on process exit hooks, which accumulate across multiple mount calls.
   *
   * Must be called before finalize().
   */
  mountRoutes(installer: (app: Application) => (() => void) | void): void {
    const disposer = installer(this.app);
    if (disposer != null) {
      this._routeDisposers.push(disposer);
    }
  }

  private readonly _routeDisposers: Array<() => void> = [];

  /**
   * Install the 404 catch-all handler.
   * Must be called AFTER all mountRoutes() calls so that
   * dynamically added middleware (e.g. express.static for Console)
   * is evaluated before the 404 handler.
   */
  finalize(): void {
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: 'Not found',
        path: req.path,
      });
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
  
  /**
   * Get the current port
   */
  getPort(): number {
    return this.port;
  }
  
  /**
   * Start heartbeat to keep lock file fresh
   * Updates lastHeartbeat every 30 seconds
   * 
   * BUG FIX #3: Use .unref() so heartbeat doesn't keep process alive
   * - Previously, process couldn't exit cleanly because interval kept event loop alive
   * - Now uses .unref() to allow process exit even with active heartbeat
   * - Clears any existing interval before starting new one
   */
  // Heartbeat behavior is delegated to DashboardHeartbeat.
  
  /**
   * Manual cleanup utility - can be called externally via the CLI cleanup command.
   * Kills ALL workrail processes found on ports 3456-3499 (except the current one).
   */
  async fullCleanup(): Promise<number> {
    try {
      const busyPorts = await this.getWorkrailPorts();

      if (busyPorts.length === 0) {
        try { process.stderr.write('[Cleanup] No workrail processes found\n'); } catch { /* ignore */ }
        return 0;
      }

      try { process.stderr.write(`[Cleanup] Found ${busyPorts.length} workrail process(es), removing all...\n`); } catch { /* ignore */ }

      let cleanedCount = 0;

      for (const { port, pid } of busyPorts) {
        // Don't kill ourselves
        if (pid === process.pid) {
          try { process.stderr.write(`[Cleanup] Skipping current process ${pid}\n`); } catch { /* ignore */ }
          continue;
        }

        try { process.stderr.write(`[Cleanup] Killing process ${pid} on port ${port}\n`); } catch { /* ignore */ }
        try {
          // Try graceful shutdown first
          process.kill(pid, 'SIGTERM');
          await new Promise(r => setTimeout(r, 1000));

          // Check if still alive
          try {
            process.kill(pid, 0);
            // Still alive, force kill
            process.kill(pid, 'SIGKILL');
            try { process.stderr.write(`[Cleanup] Force killed process ${pid}\n`); } catch { /* ignore */ }
          } catch {
            // Already dead
            try { process.stderr.write(`[Cleanup] Process ${pid} terminated gracefully\n`); } catch { /* ignore */ }
          }

          cleanedCount++;
        } catch (error) {
          try { process.stderr.write(`[Cleanup] Failed to kill process ${pid}: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
        }
      }

      try { process.stderr.write(`[Cleanup] Cleaned up ${cleanedCount} process(es)\n`); } catch { /* ignore */ }

      // Also remove lock file
      try {
        await fs.unlink(this.lockFile);
        try { process.stderr.write('[Cleanup] Removed lock file\n'); } catch { /* ignore */ }
      } catch {
        // Lock file might not exist
      }

      return cleanedCount;
    } catch (error) {
      try { process.stderr.write(`[Cleanup] Full cleanup failed: ${(error as Error)?.message ?? String(error)}\n`); } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Get list of workrail processes and their ports in range 3456-3499.
   * Used only by fullCleanup() (an explicit user-triggered CLI command).
   * Platform-specific implementation using lsof (Unix) or netstat (Windows).
   */
  private async getWorkrailPorts(): Promise<Array<{port: number, pid: number}>> {
    try {
      const platform = os.platform();

      if (platform === 'darwin' || platform === 'linux') {
        // Use lsof on Unix-like systems
        const output = execSync(
          'lsof -i :3456-3499 -Pn 2>/dev/null | grep node || true',
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();

        if (!output) return [];

        // Parse lsof output format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        // Example: node    79144 etienneb   14u  IPv6 0xc2ceb87d07ed2009      0t0  TCP *:3456 (LISTEN)
        return output.split('\n').filter(Boolean).map(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1]);
          const nameField = parts[8]; // NAME field contains *:PORT or *:service_name
          const portMatch = nameField.match(/:(\d+)$/);
          const port = portMatch ? parseInt(portMatch[1]) : 0;
          return { port, pid };
        }).filter(item => item.port >= 3456 && item.port < 3500 && !isNaN(item.pid));

      } else if (platform === 'win32') {
        // Use netstat on Windows
        const output = execSync(
          'netstat -ano | findstr "3456" || echo',
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();

        if (!output) return [];

        return output.split('\n').filter(Boolean).map(line => {
          const parts = line.trim().split(/\s+/);
          // Only consider listening sockets; other states can have pid=0 which is unsafe to kill.
          const state = parts[3] || '';
          const address = parts[1] || '';
          const pid = parseInt(parts[4]);
          const portMatch = address.match(/:(\d+)$/);
          const port = portMatch ? parseInt(portMatch[1]) : 0;
          return { port, pid, state };
        }).filter(item =>
          item.state === 'LISTENING' &&
          item.port >= 3456 &&
          item.port < 3500 &&
          !isNaN(item.pid) &&
          item.pid > 0
        ).map(({ port, pid }) => ({ port, pid }));
      }

      return [];
    } catch {
      // Command failed, return empty array
      return [];
    }
  }
}

