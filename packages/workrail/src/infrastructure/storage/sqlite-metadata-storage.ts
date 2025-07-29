// SQLite Metadata Storage Implementation
// High-performance metadata storage with enhanced concurrency safety

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { SqliteMigrator } from './sqlite-migrator';
import {
  IMetadataStorage,
  ContextStorageConfig,
  MetadataStats
} from './context-storage';
import {
  CheckpointMetadata,
  SessionInfo
} from '../../types/context-types';

// =============================================================================
// SQLITE METADATA STORAGE IMPLEMENTATION
// =============================================================================

export class SqliteMetadataStorage implements IMetadataStorage {
  private db: Database.Database | null = null;
  private migrator: SqliteMigrator | null = null;
  private config: ContextStorageConfig;
  private isInitialized = false;
  private heartbeatIntervals = new Map<string, NodeJS.Timeout>();

  // Prepared statements for performance
  private statements: {
    insertCheckpoint?: Database.Statement;
    selectCheckpoint?: Database.Statement;
    selectCheckpointsBySession?: Database.Statement;
    deleteCheckpoint?: Database.Statement;
    upsertSession?: Database.Statement;
    selectSession?: Database.Statement;
    deleteSession?: Database.Statement;
    insertActiveOperation?: Database.Statement;
    deleteActiveOperation?: Database.Statement;
    updateHeartbeat?: Database.Statement;
    cleanupStaleOperations?: Database.Statement;
    acquireSessionLock?: Database.Statement;
    releaseSessionLock?: Database.Statement;
    checkSessionLock?: Database.Statement;
  } = {};

  constructor(config: ContextStorageConfig) {
    this.config = config;
  }

  /**
   * Initialize SQLite database with migrations and concurrency safety
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Ensure data directory exists
      await this.ensureDataDirectory();

      // Initialize database connection
      const dbPath = path.join(this.config.dataDirectory, this.config.database.path);
      this.db = new Database(dbPath, {
        timeout: this.config.database.timeout,
        verbose: undefined // Disable verbose logging
      });

      // Configure SQLite for optimal performance and concurrency
      if (this.config.database.walMode) {
        this.db.pragma('journal_mode = WAL');
      }
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 1000');
      this.db.pragma('temp_store = memory');
      this.db.pragma('foreign_keys = ON');

      // Initialize migration system
      this.migrator = new SqliteMigrator(dbPath);
      await this.migrator.initialize();

      // Run migrations
      const migrationResults = await this.migrator.migrate();
      if (migrationResults.some(result => !result.success)) {
        throw new Error('Database migration failed');
      }

      // Validate database integrity
      const isValid = await this.migrator.validateIntegrity();
      if (!isValid) {
        throw new Error('Database integrity validation failed');
      }

      // Prepare statements for optimal performance
      await this.prepareStatements();

      // Cleanup interrupted operations from previous sessions
      await this.cleanupInterruptedOperations();

      // Setup automatic cleanup interval
      this.setupAutomaticCleanup();

      this.isInitialized = true;
      console.log('✅ SQLite metadata storage initialized');

    } catch (error) {
      await this.cleanup();
      throw new Error(`Failed to initialize SQLite metadata storage: ${error}`);
    }
  }

  /**
   * Save checkpoint metadata with operation tracking
   */
  public async saveCheckpointMetadata(metadata: CheckpointMetadata): Promise<void> {
    this.ensureInitialized();
    
    try {
      this.statements.insertCheckpoint!.run(
        metadata.id,
        metadata.sessionId,
        metadata.name || null,
        metadata.agentId || null,
        metadata.createdAt,
        metadata.tags ? JSON.stringify(metadata.tags) : null,
        metadata.contextSizeBytes,
        metadata.contextHash,
        metadata.blobPath,
        metadata.status,
        metadata.created_by_operation || null,
        metadata.compression_ratio || 1.0,
        metadata.classification_info ? JSON.stringify(metadata.classification_info) : null
      );

      console.log(`📦 Saved checkpoint metadata: ${metadata.id}`);
    } catch (error) {
      throw new Error(`Failed to save checkpoint metadata: ${error}`);
    }
  }

  /**
   * Get checkpoint metadata by ID
   */
  public async getCheckpointMetadata(checkpointId: string): Promise<CheckpointMetadata | null> {
    this.ensureInitialized();

    try {
      const row = this.statements.selectCheckpoint!.get(checkpointId) as any;
      if (!row) {
        return null;
      }

      return this.mapRowToCheckpointMetadata(row);
    } catch (error) {
      throw new Error(`Failed to get checkpoint metadata: ${error}`);
    }
  }

  /**
   * List checkpoint metadata for a session with pagination
   */
  public async listCheckpointMetadata(
    sessionId: string, 
    limit = 20, 
    offset = 0
  ): Promise<CheckpointMetadata[]> {
    this.ensureInitialized();

    try {
      const rows = this.statements.selectCheckpointsBySession!.all(
        sessionId, 
        limit, 
        offset
      ) as any[];

      return rows.map(row => this.mapRowToCheckpointMetadata(row));
    } catch (error) {
      throw new Error(`Failed to list checkpoint metadata: ${error}`);
    }
  }

  /**
   * Delete checkpoint metadata
   */
  public async deleteCheckpointMetadata(checkpointId: string): Promise<void> {
    this.ensureInitialized();

    try {
      const result = this.statements.deleteCheckpoint!.run(checkpointId);
      if (result.changes === 0) {
        throw new Error(`Checkpoint ${checkpointId} not found`);
      }

      console.log(`🗑️ Deleted checkpoint metadata: ${checkpointId}`);
    } catch (error) {
      throw new Error(`Failed to delete checkpoint metadata: ${error}`);
    }
  }

  /**
   * Save or update session information
   */
  public async upsertSessionInfo(session: SessionInfo): Promise<void> {
    this.ensureInitialized();

    try {
      this.statements.upsertSession!.run(
        session.id,
        session.createdAt,
        session.lastAccessedAt,
        session.tags ? JSON.stringify(session.tags) : null,
        session.totalSizeBytes
      );

      console.log(`📋 Upserted session: ${session.id}`);
    } catch (error) {
      throw new Error(`Failed to upsert session: ${error}`);
    }
  }

  /**
   * Get session information
   */
  public async getSessionInfo(sessionId: string): Promise<SessionInfo | null> {
    this.ensureInitialized();

    try {
      const row = this.statements.selectSession!.get(sessionId) as any;
      if (!row) {
        return null;
      }

      return {
        id: row.id,
        createdAt: row.created_at,
        lastAccessedAt: row.last_accessed_at,
        tags: row.tags ? JSON.parse(row.tags) : undefined,
        totalSizeBytes: row.total_size_bytes
      };
    } catch (error) {
      throw new Error(`Failed to get session info: ${error}`);
    }
  }

  /**
   * Delete session and cascade to checkpoints
   */
  public async deleteSessionInfo(sessionId: string): Promise<void> {
    this.ensureInitialized();

    try {
      const result = this.statements.deleteSession!.run(sessionId);
      if (result.changes === 0) {
        throw new Error(`Session ${sessionId} not found`);
      }

      console.log(`🗑️ Deleted session: ${sessionId}`);
    } catch (error) {
      throw new Error(`Failed to delete session: ${error}`);
    }
  }

  /**
   * Acquire exclusive lock for session operations with timeout
   */
  public async acquireSessionLock(
    sessionId: string, 
    operationType: string, 
    timeoutMs?: number
  ): Promise<string> {
    this.ensureInitialized();

    const operationId = crypto.randomUUID();
    const timeout = timeoutMs || this.config.concurrency.operationTimeoutMs;
    const expiresAt = new Date(Date.now() + timeout).toISOString();
    const maxRetries = this.config.concurrency.maxRetries;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Clean up stale operations first
        await this.cleanupStaleOperations();

        // Try to acquire lock by inserting active operation
        this.statements.insertActiveOperation!.run(
          operationId,
          sessionId,
          operationType,
          new Date().toISOString(),
          new Date().toISOString(),
          timeout,
          JSON.stringify({ attempt, maxRetries })
        );

        // Try to acquire session lock
        this.statements.acquireSessionLock!.run(
          sessionId,
          operationId,
          new Date().toISOString(),
          expiresAt
        );

        // Start heartbeat for long operations
        this.startHeartbeat(operationId);

        console.log(`🔒 Acquired lock for session ${sessionId}, operation: ${operationId}`);
        return operationId;

      } catch (error) {
        // If this is the last attempt, throw the error
        if (attempt === maxRetries) {
          throw new Error(
            `Failed to acquire session lock for ${sessionId} after ${maxRetries} attempts: ${error}`
          );
        }

        // Wait before retrying with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error(`Unable to acquire session lock for ${sessionId}`);
  }

  /**
   * Release session lock
   */
  public async releaseSessionLock(operationId: string): Promise<void> {
    this.ensureInitialized();

    try {
      // Stop heartbeat
      this.stopHeartbeat(operationId);

      // Release session lock
      this.statements.releaseSessionLock!.run(operationId);

      // Remove active operation
      this.statements.deleteActiveOperation!.run(operationId);

      console.log(`🔓 Released lock for operation: ${operationId}`);
    } catch (error) {
      console.warn(`Warning: Failed to release session lock ${operationId}:`, error);
    }
  }

  /**
   * Update operation heartbeat for long-running operations
   */
  public async updateOperationHeartbeat(operationId: string): Promise<void> {
    this.ensureInitialized();

    try {
      this.statements.updateHeartbeat!.run(
        new Date().toISOString(),
        operationId
      );
    } catch (error) {
      console.warn(`Warning: Failed to update heartbeat for ${operationId}:`, error);
    }
  }

  /**
   * Cleanup stale operations and expired locks
   */
  public async cleanupStaleOperations(): Promise<number> {
    this.ensureInitialized();

    try {
      const result = this.statements.cleanupStaleOperations!.run();
      
      if (result.changes > 0) {
        console.log(`🧹 Cleaned up ${result.changes} stale operations`);
      }

      return result.changes;
    } catch (error) {
      console.warn('Warning: Failed to cleanup stale operations:', error);
      return 0;
    }
  }

  /**
   * Get aggregated storage statistics
   */
  public async getMetadataStats(): Promise<MetadataStats> {
    this.ensureInitialized();

    try {
      // Get basic counts
      const countsQuery = `
        SELECT 
          (SELECT COUNT(*) FROM sessions) as sessions,
          (SELECT COUNT(*) FROM checkpoint_metadata) as checkpoints,
          (SELECT COUNT(*) FROM active_operations) as active_ops,
          (SELECT AVG(context_size_bytes) FROM checkpoint_metadata) as avg_size
      `;
      const counts = this.db!.prepare(countsQuery).get() as any;

      // Get database file size
      const dbPath = path.join(this.config.dataDirectory, this.config.database.path);
      const dbStats = fs.statSync(dbPath);

      return {
        databaseSizeBytes: dbStats.size,
        totalSessions: counts.sessions || 0,
        totalCheckpoints: counts.checkpoints || 0,
        activeOperations: counts.active_ops || 0,
        averageCheckpointSize: counts.avg_size || 0,
        indexEfficiency: 1.0 // TODO: Implement actual index efficiency calculation
      };
    } catch (error) {
      throw new Error(`Failed to get metadata stats: ${error}`);
    }
  }

  /**
   * Close metadata storage connection
   */
  public async close(): Promise<void> {
    await this.cleanup();
  }

  // =============================================================================
  // PRIVATE HELPER METHODS
  // =============================================================================

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.db) {
      throw new Error('SqliteMetadataStorage not initialized');
    }
  }

  private async ensureDataDirectory(): Promise<void> {
    try {
      await fs.promises.mkdir(this.config.dataDirectory, { 
        recursive: true, 
        mode: this.config.blobs.directoryPermissions 
      });
    } catch (error) {
      throw new Error(`Failed to create data directory: ${error}`);
    }
  }

  private async prepareStatements(): Promise<void> {
    if (!this.db) return;

    this.statements = {
      insertCheckpoint: this.db.prepare(`
        INSERT OR REPLACE INTO checkpoint_metadata (
          id, session_id, name, agent_id, created_at, tags, 
          context_size_bytes, context_hash, blob_path, status,
          created_by_operation, compression_ratio, classification_info
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      selectCheckpoint: this.db.prepare(`
        SELECT * FROM checkpoint_metadata WHERE id = ?
      `),

      selectCheckpointsBySession: this.db.prepare(`
        SELECT * FROM checkpoint_metadata 
        WHERE session_id = ? 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
      `),

      deleteCheckpoint: this.db.prepare(`
        DELETE FROM checkpoint_metadata WHERE id = ?
      `),

      upsertSession: this.db.prepare(`
        INSERT OR REPLACE INTO sessions (
          id, created_at, last_accessed_at, tags, total_size_bytes
        ) VALUES (?, ?, ?, ?, ?)
      `),

      selectSession: this.db.prepare(`
        SELECT * FROM sessions WHERE id = ?
      `),

      deleteSession: this.db.prepare(`
        DELETE FROM sessions WHERE id = ?
      `),

      insertActiveOperation: this.db.prepare(`
        INSERT INTO active_operations (
          id, session_id, operation_type, started_at, heartbeat_at, timeout_ms, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      deleteActiveOperation: this.db.prepare(`
        DELETE FROM active_operations WHERE id = ?
      `),

      updateHeartbeat: this.db.prepare(`
        UPDATE active_operations SET heartbeat_at = ? WHERE id = ?
      `),

      cleanupStaleOperations: this.db.prepare(`
        DELETE FROM active_operations 
        WHERE heartbeat_at < datetime('now', '-5 minutes') 
           OR started_at < datetime('now', '-10 minutes')
      `),

      acquireSessionLock: this.db.prepare(`
        UPDATE sessions 
        SET locked_at = ?, locked_by = ?, lock_timeout_at = ?
        WHERE id = ? AND (locked_at IS NULL OR lock_timeout_at < CURRENT_TIMESTAMP)
      `),

      releaseSessionLock: this.db.prepare(`
        UPDATE sessions 
        SET locked_at = NULL, locked_by = NULL, lock_timeout_at = NULL
        WHERE locked_by = ?
      `),

      checkSessionLock: this.db.prepare(`
        SELECT locked_by, lock_timeout_at FROM sessions 
        WHERE id = ? AND locked_at IS NOT NULL
      `)
    };
  }

  private mapRowToCheckpointMetadata(row: any): CheckpointMetadata {
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name || undefined,
      agentId: row.agent_id || undefined,
      createdAt: row.created_at,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      contextSizeBytes: row.context_size_bytes,
      contextHash: row.context_hash,
      blobPath: row.blob_path,
      status: row.status,
      created_by_operation: row.created_by_operation || undefined,
      compression_ratio: row.compression_ratio || 1.0,
      classification_info: row.classification_info ? JSON.parse(row.classification_info) : undefined
    };
  }

  private async cleanupInterruptedOperations(): Promise<void> {
    try {
      // Clean up any operations that were running when the process was killed
      const cleanupCount = await this.cleanupStaleOperations();
      
      if (cleanupCount > 0) {
        console.log(`🔄 Cleaned up ${cleanupCount} interrupted operations from previous session`);
      }

      // Release any expired session locks
      this.db!.prepare(`
        UPDATE sessions 
        SET locked_at = NULL, locked_by = NULL, lock_timeout_at = NULL
        WHERE lock_timeout_at < CURRENT_TIMESTAMP
      `).run();

    } catch (error) {
      console.warn('Warning: Failed to cleanup interrupted operations:', error);
    }
  }

  private startHeartbeat(operationId: string): void {
    const interval = setInterval(async () => {
      try {
        await this.updateOperationHeartbeat(operationId);
      } catch (error) {
        console.warn(`Heartbeat failed for operation ${operationId}:`, error);
        this.stopHeartbeat(operationId);
      }
    }, this.config.concurrency.heartbeatIntervalMs);

    this.heartbeatIntervals.set(operationId, interval);
  }

  private stopHeartbeat(operationId: string): void {
    const interval = this.heartbeatIntervals.get(operationId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(operationId);
    }
  }

  private setupAutomaticCleanup(): void {
    const cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupStaleOperations();
      } catch (error) {
        console.warn('Automatic cleanup failed:', error);
      }
    }, this.config.concurrency.cleanupIntervalMs);

    // Store interval for cleanup
    process.on('exit', () => {
      clearInterval(cleanupInterval);
    });
  }

  private async cleanup(): Promise<void> {
    try {
      // Stop all heartbeats
      for (const interval of this.heartbeatIntervals.values()) {
        clearInterval(interval);
      }
      this.heartbeatIntervals.clear();

      // Close migrator
      if (this.migrator) {
        this.migrator.close();
        this.migrator = null;
      }

      // Close database
      if (this.db) {
        this.db.close();
        this.db = null;
      }

      this.isInitialized = false;
    } catch (error) {
      console.warn('Warning during SQLite metadata storage cleanup:', error);
    }
  }
} 