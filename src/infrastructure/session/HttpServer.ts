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
        console.error(`[HTTP] ${req.method} ${req.path} ${res.statusCode} (${duration}ms)`);
      });
      next();
    });
  }
  
  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Serve static dashboard UI from web directory
    const webDir = path.join(__dirname, '../../../web');
    
    // Serve all static files from web root
    this.app.use(express.static(webDir));
    
    // Dashboard home page
    this.app.get('/', async (req: Request, res: Response) => {
      try {
        const indexPath = path.join(webDir, 'index.html');
        res.sendFile(indexPath);
      } catch (error) {
        res.status(500).json({
          error: 'Dashboard UI not found',
          message: 'The dashboard web files are not yet built. This is expected during development.',
          details: 'Web files will be available in a future step.'
        });
      }
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
          console.error(`[SSE] Write error for ${workflow}/${id}:`, error);
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
          console.error(`[SSE] Write error for ${workflow}/${id}:`, error);
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
        console.error(`[SSE] Max connection time reached for ${workflow}/${id}, closing`);
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
        console.error(`[SSE] Request error for ${workflow}/${id}:`, error);
        cleanup();
      });
      res.on('error', (error) => {
        console.error(`[SSE] Response error for ${workflow}/${id}:`, error);
        cleanup();
      });
      res.on('finish', cleanup);
    });
    
    // Delete a single session
    this.app.delete('/api/sessions/:workflow/:id', async (req: Request, res: Response) => {
      try {
        const { workflow, id } = req.params;
        
        await this.sessionManager.deleteSession(workflow, id);
        
        res.json({
          success: true,
          message: `Session ${workflow}/${id} deleted successfully`
        });
      } catch (error: any) {
        console.error('[HttpServer] Delete session error:', error);
        res.status(error.message?.includes('not found') ? 404 : 500).json({
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
        console.error('[HttpServer] Bulk delete error:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to delete sessions'
        });
      }
    });
    
    // Health check
    this.app.get('/api/health', (req: Request, res: Response) => {
      res.json({
        success: true,
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        isPrimary: this.isPrimary,
        pid: process.pid,
        port: this.port
      });
    });
    
    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: 'Not found',
        path: req.path
      });
    });
  }
  
  /**
   * Start the HTTP server
   * Uses unified dashboard pattern (primary/secondary) unless disabled
   */
  async start(): Promise<string | null> {
    // STEP 1: Quick cleanup of orphaned processes
    await this.quickCleanup();
    
    // Check dashboard mode (DI-provided, not env check)
    const mode = this.config.dashboardMode ?? this.dashboardMode;
    if (mode.kind === 'legacy') {
      console.error('[Dashboard] Unified dashboard disabled, using legacy mode');
      return await this.startLegacyMode();
    }
    
    // Try to become primary
    if (await this.tryBecomePrimary()) {
      try {
        await this.startAsPrimary();
        return this.baseUrl;
      } catch (error: any) {
        if (error.code === 'EADDRINUSE') {
          // Port busy even though we have lock - cleanup and fall back
          console.error(`[Dashboard] Port ${this.port} busy despite lock, falling back to legacy mode`);
          await fs.unlink(this.lockFile).catch(() => {});
          return await this.startLegacyMode();
        }
        throw error;
      }
    } else {
      // Secondary mode - dashboard already running
      console.error(`[Dashboard] ✅ Unified dashboard at http://localhost:${this.port}`);
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
        projectPath: this.sessionManager.getProjectPath()
      };
      
      await fs.writeFile(this.lockFile, JSON.stringify(lockData, null, 2), { flag: 'wx' });
      
      // Success! We are primary
      console.error('[Dashboard] Primary elected');
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
        console.error('[Dashboard] Cannot write lock file (permission denied)');
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Determine if a lock should be reclaimed based on its data
   * Pure function - no side effects
   */
  private shouldReclaimLock(lockData: DashboardLock): { reclaim: boolean; reason: string } {
    // Invalid structure
    if (!lockData.pid || !lockData.port || !lockData.startedAt) {
      return { reclaim: true, reason: 'invalid lock structure' };
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
        // Check if primary is healthy even though lock seems valid
        const isHealthy = await this.checkHealth(lockData.port);
        if (isHealthy) {
          return false; // Valid primary exists
        }
        
        // Process exists but not responding - try to kill it first
        console.error(`[Dashboard] Primary (PID ${lockData.pid}) not responding, attempting graceful shutdown`);
        try {
          process.kill(lockData.pid, 'SIGTERM');
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s
        } catch {}
        
        // Re-check if it's now healthy or dead
        const stillHealthy = await this.checkHealth(lockData.port);
        if (stillHealthy) {
          return false; // It recovered
        }
      } else {
        console.error(`[Dashboard] Lock reclaim needed: ${reason}`);
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
        projectPath: this.sessionManager.getProjectPath()
      };
      
      try {
        // Write to temp file first
        await fs.writeFile(tempPath, JSON.stringify(newLockData, null, 2));
        
        // Atomic rename (POSIX guarantees atomicity)
        await fs.rename(tempPath, this.lockFile);
        
        console.error('[Dashboard] Lock reclaimed successfully');
        this.isPrimary = true;
        this.setupPrimaryCleanup();
        this.heartbeat.start();
        return true;
        
      } catch (error: any) {
        // Clean up temp file on any error
        await fs.unlink(tempPath).catch(() => {});
        
        if (error.code === 'ENOENT') {
          // Lock file was deleted by another process - try fresh
          console.error('[Dashboard] Lock deleted during reclaim, trying fresh');
          return await this.tryBecomePrimary();
        }
        
        // Other error (permission, disk full, etc.)
        console.error('[Dashboard] Lock reclaim failed:', error.message);
        return false;
      }
      
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Lock file deleted - try to become primary fresh
        return await this.tryBecomePrimary();
      }
      
      // Corrupt JSON or other read error
      console.error('[Dashboard] Lock file corrupted, attempting fresh claim');
      await fs.unlink(this.lockFile).catch(() => {});
      return await this.tryBecomePrimary();
    }
  }
  
  /**
   * Check if a server is healthy on given port
   */
  private async checkHealth(port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000); // 2s timeout
      
      const response = await fetch(`http://localhost:${port}/api/health`, {
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) return false;
      
      const data = await response.json();
      return data.status === 'healthy' && data.isPrimary !== undefined;
      
    } catch {
      return false;
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
    const cleanupSync = () => {
      if (isCleaningUp || !this.isPrimary) return;
      isCleaningUp = true;
      
      console.error('[Dashboard] Primary shutting down (sync cleanup)');
      
      // Stop heartbeat
      this.heartbeat.stop();
      
      // SYNC file delete only - async won't complete before process exits
      try {
        releaseLockFileSync(this.lockFile);
        console.error('[Dashboard] Lock file released');
      } catch (error: any) {
        // Ignore ENOENT (file already deleted) but log others
        if (error.code !== 'ENOENT') {
          console.error('[Dashboard] Failed to release lock file:', error.message);
        }
      }
      
      this.isPrimary = false;
    };
    
    // Signal handler: stop the server and emit a typed shutdown request.
    // IMPORTANT: HttpServer does NOT terminate the process. The composition root decides.
    const signalHandler = (signal: ProcessSignal) => {
      if (isCleaningUp) return;
      isCleaningUp = true;

      console.error(`[Dashboard] Received ${signal}`);
      this.stop()
        .catch(err => console.error('[Dashboard] Cleanup error:', err))
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
      this.server.listen(listenPort, () => {
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
          
          this.server.listen(this.port, () => {
            resolve();
          });
        });
        
        this.baseUrl = `http://localhost:${this.port}`;
        console.error(`[Dashboard] Started in legacy mode on port ${this.port}`);
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
    
    throw new Error('No available ports in range 3457-3499');
  }
  
  /**
   * Print startup banner
   */
  private printBanner(): void {
    const line = '═'.repeat(60);
    console.error(`\n${line}`);
    console.error(`🔧 Workrail MCP Server Started`);
    console.error(line);
    console.error(`📊 Dashboard: ${this.baseUrl} ${this.isPrimary ? '(PRIMARY - All Projects)' : '(Legacy Mode)'}`);
    console.error(`💾 Sessions:  ${this.sessionManager.getSessionsRoot()}`);
    console.error(`🏗️  Project:   ${this.sessionManager.getProjectId()}`);
    console.error(line);
    console.error();
  }
  
  /**
   * Open dashboard in browser
   */
  async openDashboard(sessionId?: string): Promise<string> {
    let url = this.baseUrl;
    
    if (sessionId) {
      url += `?session=${sessionId}`;
    }
    
    const behavior = this.config.browserBehavior ?? this.browserBehavior;
    if (behavior.kind === 'auto_open') {
      try {
        await open(url);
        console.error(`🌐 Opened dashboard: ${url}`);
      } catch (error) {
        console.error(`🌐 Dashboard URL: ${url} (auto-open failed, please open manually)`);
      }
    }
    
    return url;
  }
  
  /**
   * Stop the HTTP server
   * 
   * BUG FIX #3: Fixed cleanup order - heartbeat MUST be stopped first
   * - Heartbeat interval was keeping process alive
   * - Now clears heartbeat before other cleanup
   * - Added timeout protection for server close
   */
  async stop(): Promise<void> {
    // 1. FIRST: Stop heartbeat to prevent further lock file writes
    this.heartbeat.stop();
    
    // 2. Stop all file watchers
    this.sessionManager.unwatchAll();
    
    // 3. Close server with timeout protection
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();

      // Timeout to prevent hanging if server.close() never completes
      const closeTimeout = setTimeout(() => {
        console.error('[Dashboard] Server close timeout after 5s, forcing shutdown');
        resolve();
      }, 5000);

      this.server.close(() => {
        clearTimeout(closeTimeout);
        console.error('HTTP server stopped');
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
   * Quick cleanup of orphaned workrail processes
   * Only removes processes that are unresponsive on ports 3456-3499
   */
  private async quickCleanup(): Promise<void> {
    try {
      const busyPorts = await this.getWorkrailPorts();
      
      if (busyPorts.length === 0) {
        return; // Nothing to clean up
      }
      
      console.error(`[Cleanup] Found ${busyPorts.length} workrail process(es), checking health...`);
      
      let cleanedCount = 0;
      
      for (const { port, pid } of busyPorts) {
        // Don't check ourselves
        if (pid === process.pid) continue;
        
        const isHealthy = await this.checkHealth(port);
        
        if (!isHealthy) {
          console.error(`[Cleanup] Removing unresponsive process ${pid} on port ${port}`);
          try {
            // Try graceful shutdown first
            process.kill(pid, 'SIGTERM');
            await new Promise(r => setTimeout(r, 1000));
            
            // Check if still alive
            try {
              process.kill(pid, 0);
              // Still alive, force kill
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already dead, good
            }
            
            cleanedCount++;
          } catch (error) {
            // Process might have already exited
          }
        }
      }
      
      if (cleanedCount > 0) {
        console.error(`[Cleanup] Cleaned up ${cleanedCount} orphaned process(es)`);
        // Wait a bit for ports to be released
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {
      // Cleanup failures shouldn't block startup
      console.error('[Cleanup] Failed, continuing anyway:', error);
    }
  }
  
  /**
   * Get list of workrail processes and their ports in range 3456-3499
   * Platform-specific implementation
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
    } catch (error) {
      // Command failed, return empty array
      return [];
    }
  }
  
  /**
   * Manual cleanup utility - can be called externally
   * More aggressive than quickCleanup - removes ALL workrail processes on our ports
   */
  async fullCleanup(): Promise<number> {
    try {
      const busyPorts = await this.getWorkrailPorts();
      
      if (busyPorts.length === 0) {
        console.error('[Cleanup] No workrail processes found');
        return 0;
      }
      
      console.error(`[Cleanup] Found ${busyPorts.length} workrail process(es), removing all...`);
      
      let cleanedCount = 0;
      
      for (const { port, pid } of busyPorts) {
        // Don't kill ourselves
        if (pid === process.pid) {
          console.error(`[Cleanup] Skipping current process ${pid}`);
          continue;
        }
        
        console.error(`[Cleanup] Killing process ${pid} on port ${port}`);
        try {
          // Try graceful shutdown first
          process.kill(pid, 'SIGTERM');
          await new Promise(r => setTimeout(r, 1000));
          
          // Check if still alive
          try {
            process.kill(pid, 0);
            // Still alive, force kill
            process.kill(pid, 'SIGKILL');
            console.error(`[Cleanup] Force killed process ${pid}`);
          } catch {
            // Already dead
            console.error(`[Cleanup] Process ${pid} terminated gracefully`);
          }
          
          cleanedCount++;
        } catch (error) {
          console.error(`[Cleanup] Failed to kill process ${pid}:`, error);
        }
      }
      
      console.error(`[Cleanup] Cleaned up ${cleanedCount} process(es)`);
      
      // Also remove lock file
      try {
        await fs.unlink(this.lockFile);
        console.error('[Cleanup] Removed lock file');
      } catch {
        // Lock file might not exist
      }
      
      return cleanedCount;
    } catch (error) {
      console.error('[Cleanup] Full cleanup failed:', error);
      throw error;
    }
  }
}

