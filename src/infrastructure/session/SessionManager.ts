import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import os from 'os';
import { EventEmitter } from 'events';
import { singleton, inject } from 'tsyringe';
import { DI } from '../../di/tokens.js';
import { SessionDataNormalizer } from './SessionDataNormalizer';
import { SessionDataValidator, ValidationResult } from './SessionDataValidator';

export interface Session {
  id: string;
  workflowId: string;
  projectId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
}

export interface ProjectMetadata {
  id: string;
  path: string;
  updatedAt: string;
  sessionCount: number;
  workflows: string[];
}

/**
 * SessionManager handles all session storage operations.
 * 
 * Sessions are stored in ~/.workrail/sessions/{projectId}/{workflowId}/{sessionId}.json
 * 
 * Key features:
 * - Atomic writes (temp file + rename)
 * - Deep merge updates
 * - JSONPath-like queries for targeted reads
 * - Project-based organization
 * - Git worktree support (shares sessions across worktrees)
 */
@singleton()
export class SessionManager extends EventEmitter {
  private sessionsRoot: string;
  private projectId: string;
  private projectPath: string;
  private watchers: Map<string, fsSync.FSWatcher> = new Map();
  
  constructor(
    @inject(SessionDataNormalizer) private normalizer: SessionDataNormalizer,
    @inject(SessionDataValidator) private validator: SessionDataValidator,
    @inject(DI.Config.ProjectPath) projectPath: string
  ) {
    super();
    this.sessionsRoot = path.join(os.homedir(), '.workrail', 'sessions');
    
    // Resolve to Git repository root if in a Git repo
    // This ensures worktrees share the same project ID
    const resolvedPath = this.resolveProjectPath(projectPath);
    this.projectPath = resolvedPath;
    this.projectId = this.hashProjectPath(resolvedPath);
  }
  
  /**
   * Generate a deterministic project ID from the project path
   */
  private hashProjectPath(projectPath: string): string {
    return createHash('sha256')
      .update(path.resolve(projectPath))
      .digest('hex')
      .substring(0, 12);
  }
  
  /**
   * Resolve project path to Git repository root if in a Git repo.
   * This ensures Git worktrees share the same project ID.
   * Falls back to the original path if not in Git or Git unavailable.
   */
  private resolveProjectPath(startPath: string): string {
    // Try to find Git repo root
    const gitRoot = this.findGitRepoRoot(startPath);
    
    if (gitRoot) {
      console.error(`[SessionManager] Git repository detected: ${gitRoot}`);
      if (gitRoot !== path.resolve(startPath)) {
        console.error(`[SessionManager] Resolved worktree ${startPath} to main repo ${gitRoot}`);
      }
      return gitRoot;
    }
    
    // Not in Git or Git unavailable, use the path as-is
    return path.resolve(startPath);
  }
  
  /**
   * Find the Git repository root using git rev-parse.
   * This works correctly for regular repos, worktrees, and submodules.
   * Returns null if not in a Git repository or Git is unavailable.
   */
  private findGitRepoRoot(startPath: string): string | null {
    try {
      const result = execSync('git rev-parse --show-toplevel', {
        cwd: startPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'] // Suppress stderr
      }).trim();
      
      return result;
    } catch {
      // Not a git repository, git not installed, or other error
      return null;
    }
  }
  
  /**
   * Get the root directory for this project's sessions
   */
  private getProjectRoot(): string {
    return path.join(this.sessionsRoot, this.projectId);
  }
  
  /**
   * Get the full path to a session file
   */
  getSessionPath(workflowId: string, sessionId: string): string {
    return path.join(
      this.getProjectRoot(),
      workflowId,
      `${sessionId}.json`
    );
  }
  
  /**
   * Create a new session
   */
  async createSession(
    workflowId: string,
    sessionId: string,
    initialData: Record<string, any> = {}
  ): Promise<Session> {
    const sessionPath = this.getSessionPath(workflowId, sessionId);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    
    const session: Session = {
      id: sessionId,
      workflowId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: initialData
    };
    
    // Atomic write
    await this.atomicWrite(sessionPath, session);
    
    // Update project metadata
    await this.updateProjectMetadata();
    
    return session;
  }
  
  /**
   * Update an existing session with deep merge
   */
  async updateSession(
    workflowId: string,
    sessionId: string,
    updates: Record<string, any>
  ): Promise<Session> {
    const sessionPath = this.getSessionPath(workflowId, sessionId);
    
    // Read existing session
    const session = await this.getSession(workflowId, sessionId);
    
    if (!session) {
      throw new Error(`Session not found: ${workflowId}/${sessionId}`);
    }
    
    // Deep merge updates
    const mergedData = this.deepMerge(session.data, updates);
    
    // NORMALIZE: Handle field variations and type conversions
    const normalizedData = this.normalizer.normalize(workflowId, mergedData);
    
    // VALIDATE: Check critical invariants (non-blocking)
    const validation = this.validator.validate(workflowId, normalizedData, sessionId);
    
    // Log validation warnings
    if (validation.warnings.length > 0) {
      await this.logValidationWarnings(workflowId, sessionId, validation);
    }
    
    // Update session with normalized data
    session.data = normalizedData;
    session.updatedAt = new Date().toISOString();
    
    // Atomic write
    await this.atomicWrite(sessionPath, session);
    
    return session;
  }
  
  /**
   * Read session data, optionally with a path query
   */
  async readSession(
    workflowId: string,
    sessionId: string,
    queryPath?: string
  ): Promise<any> {
    const session = await this.getSession(workflowId, sessionId);
    
    if (!session) {
      throw new Error(`Session not found: ${workflowId}/${sessionId}`);
    }
    
    if (!queryPath) {
      return session.data;
    }
    
    // Support JSONPath-like queries
    return this.getPath(session.data, queryPath);
  }
  
  /**
   * Delete a session
   */
  async deleteSession(
    workflowId: string,
    sessionId: string
  ): Promise<void> {
    const sessionPath = this.getSessionPath(workflowId, sessionId);
    
    // Check if session exists
    const exists = await fs.access(sessionPath).then(() => true).catch(() => false);
    
    if (!exists) {
      throw new Error(`Session not found: ${workflowId}/${sessionId}`);
    }
    
    // Stop watching if active
    this.unwatchSession(workflowId, sessionId);
    
    // Delete the session file
    await fs.unlink(sessionPath);
    
    // Update project metadata
    await this.updateProjectMetadata();
  }
  
  /**
   * Delete multiple sessions (bulk delete)
   */
  async deleteSessions(sessions: Array<{workflowId: string; sessionId: string}>): Promise<void> {
    for (const { workflowId, sessionId } of sessions) {
      try {
        await this.deleteSession(workflowId, sessionId);
      } catch (error) {
        // Continue deleting others even if one fails
        console.error(`Failed to delete ${workflowId}/${sessionId}:`, error);
      }
    }
  }
  
  /**
   * Get a complete session object
   */
  async getSession(
    workflowId: string,
    sessionId: string
  ): Promise<Session | null> {
    try {
      const sessionPath = this.getSessionPath(workflowId, sessionId);
      const content = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  
  /**
   * List all sessions for the current project
   */
  async listAllSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    const projectRoot = this.getProjectRoot();
    
    try {
      const workflows = await fs.readdir(projectRoot);
      
      for (const workflow of workflows) {
        if (workflow === 'project.json') continue;
        
        const workflowPath = path.join(projectRoot, workflow);
        const stat = await fs.stat(workflowPath);
        
        if (!stat.isDirectory()) continue;
        
        const files = await fs.readdir(workflowPath);
        
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          
          const sessionPath = path.join(workflowPath, file);
          const content = await fs.readFile(sessionPath, 'utf-8');
          sessions.push(JSON.parse(content));
        }
      }
    } catch (error: any) {
      // Project directory doesn't exist yet
      if (error.code !== 'ENOENT') throw error;
    }
    
    return sessions.sort((a, b) => 
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }
  
  /**
   * Get current project metadata
   */
  async getCurrentProject(): Promise<ProjectMetadata> {
    const projectPath = path.join(this.getProjectRoot(), 'project.json');
    
    try {
      const content = await fs.readFile(projectPath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          id: this.projectId,
          path: this.projectPath,
          updatedAt: new Date().toISOString(),
          sessionCount: 0,
          workflows: []
        };
      }
      throw error;
    }
  }
  
  /**
   * List all projects that have sessions
   */
  async listProjects(): Promise<ProjectMetadata[]> {
    const projects: ProjectMetadata[] = [];
    
    try {
      const projectDirs = await fs.readdir(this.sessionsRoot);
      
      for (const projectId of projectDirs) {
        const projectPath = path.join(
          this.sessionsRoot,
          projectId,
          'project.json'
        );
        
        try {
          const content = await fs.readFile(projectPath, 'utf-8');
          projects.push(JSON.parse(content));
        } catch (error) {
          // Skip if no project.json
        }
      }
    } catch (error: any) {
      // Sessions root doesn't exist yet
      if (error.code !== 'ENOENT') throw error;
    }
    
    return projects;
  }
  
  /**
   * Get the sessions root directory
   */
  getSessionsRoot(): string {
    return this.sessionsRoot;
  }
  
  /**
   * Get the current project ID
   */
  getProjectId(): string {
    return this.projectId;
  }
  
  /**
   * Get the current project path
   */
  getProjectPath(): string {
    return this.projectPath;
  }
  
  /**
   * List all sessions from all projects (for unified dashboard)
   */
  async listAllProjectsSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    
    try {
      const projectDirs = await fs.readdir(this.sessionsRoot);
      
      for (const projectId of projectDirs) {
        const projectRoot = path.join(this.sessionsRoot, projectId);
        
        // Check if it's a directory
        const stat = await fs.stat(projectRoot);
        if (!stat.isDirectory()) continue;
        
        // Read sessions from this project
        const projectSessions = await this.listSessionsForProject(projectId);
        sessions.push(...projectSessions);
      }
    } catch (error: any) {
      // Sessions root doesn't exist yet
      if (error.code !== 'ENOENT') throw error;
    }
    
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  
  /**
   * List sessions for a specific project
   * @private
   */
  private async listSessionsForProject(projectId: string): Promise<Session[]> {
    const sessions: Session[] = [];
    const projectRoot = path.join(this.sessionsRoot, projectId);
    
    try {
      const workflows = await fs.readdir(projectRoot);
      
      for (const workflow of workflows) {
        if (workflow === 'project.json') continue;
        
        const workflowPath = path.join(projectRoot, workflow);
        const stat = await fs.stat(workflowPath);
        
        if (!stat.isDirectory()) continue;
        
        const files = await fs.readdir(workflowPath);
        
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          
          const sessionPath = path.join(workflowPath, file);
          try {
            const content = await fs.readFile(sessionPath, 'utf-8');
            sessions.push(JSON.parse(content));
          } catch (error) {
            // Skip corrupted session files
            console.error(`Failed to read session ${sessionPath}:`, error);
          }
        }
      }
    } catch (error: any) {
      // Project directory doesn't exist yet
      if (error.code !== 'ENOENT') throw error;
    }
    
    return sessions;
  }
  
  /**
   * Update project metadata file
   */
  private async updateProjectMetadata(): Promise<void> {
    const projectPath = path.join(this.getProjectRoot(), 'project.json');
    
    const sessions = await this.listAllSessions();
    
    const metadata: ProjectMetadata = {
      id: this.projectId,
      path: this.projectPath,
      updatedAt: new Date().toISOString(),
      sessionCount: sessions.length,
      workflows: [...new Set(sessions.map(s => s.workflowId))]
    };
    
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(projectPath, JSON.stringify(metadata, null, 2));
  }
  
  /**
   * Deep merge two objects (arrays are replaced, not merged)
   */
  private deepMerge(target: any, source: any): any {
    // Handle null/undefined
    if (!source) return target;
    if (!target) return source;
    
    // Arrays are replaced, not merged
    if (Array.isArray(source)) {
      return source;
    }
    
    // Non-objects are replaced
    if (typeof source !== 'object') {
      return source;
    }
    
    const output = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    
    return output;
  }
  
  /**
   * Get a value from an object using a dot-notation path
   * Supports simple array filtering: hypotheses[?status=='active']
   */
  private getPath(obj: any, queryPath: string): any {
    const parts = queryPath.split('.');
    let current = obj;
    
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      
      // Handle array queries: hypotheses[?status=='active']
      const arrayMatch = part.match(/^(\w+)\[(.+)\]$/);
      if (arrayMatch) {
        const [, key, query] = arrayMatch;
        current = current[key];
        
        if (!current) return undefined;
        
        if (Array.isArray(current) && query.startsWith('?')) {
          // Simple filter query: ?field=='value' or ?field==value
          const filterMatch = query.match(/\?(\w+)==[']?([^']+)[']?/);
          if (filterMatch) {
            const [, field, value] = filterMatch;
            current = current.filter(item => String(item[field]) === value);
          }
        } else if (query.match(/^\d+$/)) {
          // Array index: hypotheses[0]
          current = current[parseInt(query)];
        }
      } else {
        current = current[part];
      }
    }
    
    return current;
  }
  
  /**
   * Atomic write: write to temp file, then rename
   * This ensures no partial writes are visible to readers
   */
  private async atomicWrite(filePath: string, data: any): Promise<void> {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    
    try {
      // Write to temp file
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      
      // Rename (atomic on POSIX; best-effort on Windows with retry)
      let retries = 3;
      while (retries > 0) {
        try {
          await fs.rename(tempPath, filePath);
          return;
        } catch (error: any) {
          if (error.code === 'EPERM' && process.platform === 'win32' && retries > 1) {
            // Windows: file may be transiently locked; retry after brief delay
            await new Promise(resolve => setTimeout(resolve, 10));
            retries--;
            continue;
          }
          // Clean up temp file on terminal error
          try {
            await fs.unlink(tempPath);
          } catch {}
          throw error;
        }
      }
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw error;
    }
}
  
  /**
   * Watch a session file for changes
   * Emits 'session:updated' event when the file changes
   * 
   * BUG FIX #6: Added proper error handling for file watcher
   * - Tracks consecutive error count
   * - Closes watcher after MAX_ERRORS to prevent resource leak
   * - Logs errors for visibility (except EBUSY which is expected)
   * - Adds watcher.on('error') handler
   */
  watchSession(workflowId: string, sessionId: string): void {
    const sessionPath = this.getSessionPath(workflowId, sessionId);
    const watchKey = `${workflowId}/${sessionId}`;
    
    // Don't watch if already watching
    if (this.watchers.has(watchKey)) {
      return;
    }
    
    const MAX_CONSECUTIVE_ERRORS = 5;
    let consecutiveErrorCount = 0;
    let debounceTimer: NodeJS.Timeout | null = null;
    
    try {
      const watcher = fsSync.watch(sessionPath, (eventType) => {
        if (eventType === 'change') {
          // Debounce: file might be written in chunks
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          
          debounceTimer = setTimeout(async () => {
            debounceTimer = null;
            try {
              const session = await this.getSession(workflowId, sessionId);
              if (session) {
                this.emit('session:updated', {
                  workflowId,
                  sessionId,
                  session
                });
              }
              // Reset error count on success
              consecutiveErrorCount = 0;
            } catch (error: any) {
              // Only ignore EBUSY (file being written) - this is expected
              if (error.code === 'EBUSY') {
                return;
              }
              
              consecutiveErrorCount++;
              console.error(
                `[SessionManager] Watch error for ${watchKey} (${consecutiveErrorCount}/${MAX_CONSECUTIVE_ERRORS}):`,
                error.message || error
              );
              
              // Close watcher after too many consecutive errors to prevent resource leak
              if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
                console.error(`[SessionManager] Too many errors, closing watcher for ${watchKey}`);
                this.unwatchSession(workflowId, sessionId);
              }
            }
          }, 100);
        }
      });
      
      // Handle watcher-level errors (e.g., file deleted, permissions changed)
      watcher.on('error', (error) => {
        console.error(`[SessionManager] Watcher error for ${watchKey}:`, error);
        this.unwatchSession(workflowId, sessionId);
      });
      
      this.watchers.set(watchKey, watcher);
    } catch (error: any) {
      // Only log if not ENOENT (file doesn't exist yet is expected)
      if (error.code !== 'ENOENT') {
        console.error(`[SessionManager] Failed to start watcher for ${watchKey}:`, error.message || error);
      }
    }
  }
  
  /**
   * Stop watching a session file
   */
  unwatchSession(workflowId: string, sessionId: string): void {
    const watchKey = `${workflowId}/${sessionId}`;
    const watcher = this.watchers.get(watchKey);
    
    if (watcher) {
      watcher.close();
      this.watchers.delete(watchKey);
    }
  }
  
  /**
   * Stop all watchers (cleanup)
   */
  unwatchAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
  
  /**
   * Log validation warnings to a file for debugging and monitoring
   */
  private async logValidationWarnings(
    workflowId: string,
    sessionId: string,
    validation: ValidationResult
  ): Promise<void> {
    try {
      const logsDir = path.join(this.getProjectRoot(), 'validation-logs');
      await fs.mkdir(logsDir, { recursive: true });
      
      const logFile = path.join(
        logsDir,
        `${workflowId}-${sessionId}-validation.log`
      );
      
      const logEntry = {
        timestamp: new Date().toISOString(),
        workflowId,
        sessionId,
        valid: validation.valid,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
        warnings: validation.warnings
      };
      
      // Append to log file
      const logLine = JSON.stringify(logEntry) + '\n';
      await fs.appendFile(logFile, logLine);
      
      // Also log to console for visibility
      if (validation.errors.length > 0) {
        console.warn(
          `[SessionManager] ⚠️  Validation errors in ${workflowId}/${sessionId}:`,
          validation.errors.map(e => e.message).join(', ')
        );
      } else if (validation.warnings.some(w => w.severity === 'warning')) {
        console.info(
          `[SessionManager] ℹ️  Validation warnings in ${workflowId}/${sessionId}:`,
          validation.warnings
            .filter(w => w.severity === 'warning')
            .map(w => w.message)
            .join(', ')
        );
      }
    } catch (error) {
      // Don't fail the update if logging fails
      console.error('[SessionManager] Failed to log validation warnings:', error);
    }
  }
}

