// Hybrid Context Storage Implementation
// Composes SQLite metadata storage and filesystem blob storage into unified interface

import crypto from 'crypto';
import {
  IContextStorage,
  IMetadataStorage,
  IBlobStorage,
  ContextStorageConfig,
  StorageStats,
  ValidationResult,
  ValidationError,
  ValidationWarning
} from './context-storage';
import {
  CheckpointMetadata,
  SessionInfo,
  CheckpointData,
  CompressedBlob,
  RawContext
} from '../../types/context-types';

// =============================================================================
// HYBRID CONTEXT STORAGE IMPLEMENTATION
// =============================================================================

export class HybridContextStorage implements IContextStorage {
  private metadataStorage: IMetadataStorage;
  private blobStorage: IBlobStorage;
  private config: ContextStorageConfig;
  private isInitialized = false;

  constructor(
    metadataStorage: IMetadataStorage,
    blobStorage: IBlobStorage,
    config: ContextStorageConfig
  ) {
    this.metadataStorage = metadataStorage;
    this.blobStorage = blobStorage;
    this.config = config;
  }

  /**
   * Initialize both metadata and blob storage
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize both storage layers
      await Promise.all([
        this.metadataStorage.initialize(),
        this.blobStorage.initialize()
      ]);

      this.isInitialized = true;
      console.log('✅ Hybrid context storage initialized');

    } catch (error) {
      throw new Error(`Failed to initialize hybrid context storage: ${error}`);
    }
  }

  /**
   * Save checkpoint with coordinated metadata and blob operations
   */
  public async saveCheckpoint(metadata: CheckpointMetadata, blob: CompressedBlob): Promise<void> {
    this.ensureInitialized();

    let operationId: string | null = null;

    try {
      // Acquire session lock for atomic operation
      operationId = await this.metadataStorage.acquireSessionLock(
        metadata.sessionId,
        'save',
        this.config.concurrency.operationTimeoutMs
      );

      // Save blob first (can be retried safely)
      const blobMetadata = await this.blobStorage.saveBlob(
        metadata.sessionId,
        metadata.id,
        blob
      );

      // Update metadata with blob path
      const enhancedMetadata: CheckpointMetadata = {
        ...metadata,
        blobPath: blobMetadata.path,
        contextHash: blobMetadata.hash,
        contextSizeBytes: blobMetadata.sizeBytes,
        created_by_operation: operationId
      };

      // Save metadata (this makes the checkpoint visible)
      await this.metadataStorage.saveCheckpointMetadata(enhancedMetadata);

      // Update session last accessed time
      await this.updateSessionAccess(metadata.sessionId);

      console.log(`✅ Saved checkpoint: ${metadata.id} (${blobMetadata.sizeBytes} bytes)`);

    } catch (error) {
      // On failure, attempt to clean up blob if it was saved
      try {
        if (operationId) {
          // The blob might have been saved, but we can't easily clean it up
          // without the exact blob metadata. This is handled by orphan cleanup.
          console.warn(`Warning: Checkpoint save failed, blob may be orphaned: ${metadata.id}`);
        }
      } catch (cleanupError) {
        console.warn('Failed to cleanup after save failure:', cleanupError);
      }

      throw new Error(`Failed to save checkpoint: ${error}`);

    } finally {
      // Always release the session lock
      if (operationId) {
        try {
          await this.metadataStorage.releaseSessionLock(operationId);
        } catch (lockError) {
          console.warn('Failed to release session lock:', lockError);
        }
      }
    }
  }

  /**
   * Load checkpoint with coordinated metadata and blob retrieval
   */
  public async loadCheckpoint(checkpointId: string): Promise<CheckpointData> {
    this.ensureInitialized();

    try {
      // Load metadata first
      const metadata = await this.metadataStorage.getCheckpointMetadata(checkpointId);
      if (!metadata) {
        throw new Error(`Checkpoint not found: ${checkpointId}`);
      }

      // Load blob data
      const blobMetadata = {
        checkpointId: metadata.id,
        sessionId: metadata.sessionId,
        path: metadata.blobPath,
        sizeBytes: metadata.contextSizeBytes,
        hash: metadata.contextHash,
        encrypted: false // TODO: Add encryption support
      };

      const compressedBlob = await this.blobStorage.loadBlob(blobMetadata);

      // Update session access time
      await this.updateSessionAccess(metadata.sessionId);

      console.log(`📖 Loaded checkpoint: ${checkpointId}`);

      // Return the data (decompression will be handled by upper layers)
      return {
        metadata,
        context: compressedBlob as any // Will be decompressed by compression service
      };

    } catch (error) {
      throw new Error(`Failed to load checkpoint: ${error}`);
    }
  }

  /**
   * List checkpoints for a session
   */
  public async listCheckpoints(
    sessionId: string, 
    limit = 20, 
    offset = 0
  ): Promise<CheckpointMetadata[]> {
    this.ensureInitialized();

    try {
      const checkpoints = await this.metadataStorage.listCheckpointMetadata(
        sessionId, 
        limit, 
        offset
      );

      // Update session access time
      if (checkpoints.length > 0) {
        await this.updateSessionAccess(sessionId);
      }

      return checkpoints;

    } catch (error) {
      throw new Error(`Failed to list checkpoints: ${error}`);
    }
  }

  /**
   * Delete checkpoint with coordinated cleanup
   */
  public async deleteCheckpoint(checkpointId: string): Promise<void> {
    this.ensureInitialized();

    let operationId: string | null = null;

    try {
      // Get metadata first to find blob path
      const metadata = await this.metadataStorage.getCheckpointMetadata(checkpointId);
      if (!metadata) {
        throw new Error(`Checkpoint not found: ${checkpointId}`);
      }

      // Acquire session lock
      operationId = await this.metadataStorage.acquireSessionLock(
        metadata.sessionId,
        'delete',
        this.config.concurrency.operationTimeoutMs
      );

      // Delete metadata first (makes checkpoint invisible)
      await this.metadataStorage.deleteCheckpointMetadata(checkpointId);

      // Delete blob file
      const blobMetadata = {
        checkpointId: metadata.id,
        sessionId: metadata.sessionId,
        path: metadata.blobPath,
        sizeBytes: metadata.contextSizeBytes,
        hash: metadata.contextHash,
        encrypted: false
      };

      await this.blobStorage.deleteBlob(blobMetadata);

      console.log(`🗑️ Deleted checkpoint: ${checkpointId}`);

    } catch (error) {
      throw new Error(`Failed to delete checkpoint: ${error}`);

    } finally {
      if (operationId) {
        try {
          await this.metadataStorage.releaseSessionLock(operationId);
        } catch (lockError) {
          console.warn('Failed to release session lock:', lockError);
        }
      }
    }
  }

  /**
   * Get session information
   */
  public async getSession(sessionId: string): Promise<SessionInfo | null> {
    this.ensureInitialized();

    try {
      return await this.metadataStorage.getSessionInfo(sessionId);
    } catch (error) {
      throw new Error(`Failed to get session: ${error}`);
    }
  }

  /**
   * Create or update session information
   */
  public async upsertSession(session: SessionInfo): Promise<void> {
    this.ensureInitialized();

    try {
      await this.metadataStorage.upsertSessionInfo(session);
      console.log(`📋 Upserted session: ${session.id}`);
    } catch (error) {
      throw new Error(`Failed to upsert session: ${error}`);
    }
  }

  /**
   * Delete session and all its checkpoints
   */
  public async deleteSession(sessionId: string): Promise<void> {
    this.ensureInitialized();

    let operationId: string | null = null;

    try {
      // Acquire session lock
      operationId = await this.metadataStorage.acquireSessionLock(
        sessionId,
        'delete',
        this.config.concurrency.operationTimeoutMs
      );

      // Get all checkpoints for the session
      const checkpoints = await this.metadataStorage.listCheckpointMetadata(sessionId, 1000, 0);

      // Delete all checkpoint blobs
      for (const checkpoint of checkpoints) {
        try {
          const blobMetadata = {
            checkpointId: checkpoint.id,
            sessionId: checkpoint.sessionId,
            path: checkpoint.blobPath,
            sizeBytes: checkpoint.contextSizeBytes,
            hash: checkpoint.contextHash,
            encrypted: false
          };

          await this.blobStorage.deleteBlob(blobMetadata);
        } catch (blobError) {
          console.warn(`Warning: Failed to delete blob for checkpoint ${checkpoint.id}:`, blobError);
        }
      }

      // Delete session (cascades to checkpoints)
      await this.metadataStorage.deleteSessionInfo(sessionId);

      console.log(`🗑️ Deleted session: ${sessionId} (${checkpoints.length} checkpoints)`);

    } catch (error) {
      throw new Error(`Failed to delete session: ${error}`);

    } finally {
      if (operationId) {
        try {
          await this.metadataStorage.releaseSessionLock(operationId);
        } catch (lockError) {
          console.warn('Failed to release session lock:', lockError);
        }
      }
    }
  }

  /**
   * Get comprehensive storage statistics
   */
  public async getStorageStats(): Promise<StorageStats> {
    this.ensureInitialized();

    try {
      const [metadataStats, blobStats] = await Promise.all([
        this.metadataStorage.getMetadataStats(),
        this.blobStorage.getBlobStats()
      ]);

      // Calculate storage utilization based on configuration
      const totalSizeBytes = blobStats.totalSizeBytes;
      const maxTotalSize = this.config.quotas.maxTotalSize;
      const storageUtilization = maxTotalSize > 0 ? totalSizeBytes / maxTotalSize : 0;

      return {
        totalSessions: metadataStats.totalSessions,
        totalCheckpoints: metadataStats.totalCheckpoints,
        totalSizeBytes: blobStats.totalSizeBytes,
        averageCheckpointSize: metadataStats.averageCheckpointSize,
        oldestCheckpoint: undefined, // TODO: Calculate from metadata
        newestCheckpoint: undefined, // TODO: Calculate from metadata
        storageUtilization
      };

    } catch (error) {
      throw new Error(`Failed to get storage stats: ${error}`);
    }
  }

  /**
   * Validate storage integrity across both layers
   */
  public async validateIntegrity(): Promise<ValidationResult> {
    this.ensureInitialized();

    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      repairSuggestions: []
    };

    try {
      // Validate blob integrity
      const blobValidation = await this.blobStorage.validateBlobIntegrity();
      
      if (!blobValidation.isValid) {
        result.isValid = false;
        
        // Convert blob validation issues to validation errors
        if (blobValidation.corruptedFiles.length > 0) {
          result.errors.push({
            type: 'CORRUPTION',
            description: `Found ${blobValidation.corruptedFiles.length} corrupted blob files`,
            affectedItems: blobValidation.corruptedFiles,
            severity: 'HIGH'
          });
        }

        if (blobValidation.missingFiles.length > 0) {
          result.errors.push({
            type: 'MISSING_DATA',
            description: `Found ${blobValidation.missingFiles.length} missing blob files`,
            affectedItems: blobValidation.missingFiles,
            severity: 'CRITICAL'
          });
        }

        if (blobValidation.orphanedFiles.length > 0) {
          result.warnings.push({
            type: 'CLEANUP_NEEDED',
            description: `Found ${blobValidation.orphanedFiles.length} orphaned blob files`,
            suggestion: 'Run orphaned file cleanup to reclaim disk space'
          });
        }
      }

      // Check storage quota usage
      const stats = await this.getStorageStats();
      if (stats.storageUtilization > this.config.quotas.warningThreshold) {
        const severity = stats.storageUtilization > this.config.quotas.cleanupThreshold ? 'HIGH' : 'MEDIUM';
        
        result.warnings.push({
          type: 'QUOTA_WARNING',
          description: `Storage usage at ${(stats.storageUtilization * 100).toFixed(1)}% of quota`,
          suggestion: severity === 'HIGH' ? 'Immediate cleanup recommended' : 'Consider cleanup soon'
        });
      }

      // Add repair suggestions
      if (result.errors.length > 0) {
        result.repairSuggestions.push('Run storage repair to fix corrupted or missing data');
      }
      if (result.warnings.some(w => w.type === 'CLEANUP_NEEDED')) {
        result.repairSuggestions.push('Run orphaned file cleanup to reclaim disk space');
      }

      return result;

    } catch (error) {
      result.isValid = false;
      result.errors.push({
        type: 'CORRUPTION',
        description: `Storage validation failed: ${error}`,
        affectedItems: ['storage-system'],
        severity: 'CRITICAL'
      });

      return result;
    }
  }

  /**
   * Close both storage layers
   */
  public async close(): Promise<void> {
    try {
      await Promise.all([
        this.metadataStorage.close(),
        this.blobStorage.close()
      ]);

      this.isInitialized = false;
      console.log('🔒 Hybrid context storage closed');

    } catch (error) {
      console.warn('Warning during hybrid storage close:', error);
    }
  }

  // =============================================================================
  // CONVENIENCE METHODS
  // =============================================================================

  /**
   * Clean up orphaned blobs that have no metadata references
   */
  public async cleanupOrphanedBlobs(): Promise<number> {
    this.ensureInitialized();

    try {
      // Get all referenced blob paths from metadata
      const allCheckpoints = await this.metadataStorage.listCheckpointMetadata('', 10000, 0);
      const referencedPaths = allCheckpoints.map(checkpoint => checkpoint.blobPath);

      // Clean up orphaned blobs
      const cleanedCount = await this.blobStorage.cleanupOrphanedBlobs(referencedPaths);

      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} orphaned blobs`);
      }

      return cleanedCount;

    } catch (error) {
      throw new Error(`Failed to cleanup orphaned blobs: ${error}`);
    }
  }

  /**
   * Update session last accessed time
   */
  private async updateSessionAccess(sessionId: string): Promise<void> {
    try {
      const session = await this.metadataStorage.getSessionInfo(sessionId);
      if (session) {
        const updatedSession: SessionInfo = {
          ...session,
          lastAccessedAt: new Date().toISOString()
        };
        await this.metadataStorage.upsertSessionInfo(updatedSession);
      }
    } catch (error) {
      // Don't fail the main operation if session update fails
      console.warn(`Warning: Failed to update session access time for ${sessionId}:`, error);
    }
  }

  // =============================================================================
  // PRIVATE HELPER METHODS
  // =============================================================================

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('HybridContextStorage not initialized');
    }
  }
}

// =============================================================================
// STORAGE FACTORY FUNCTIONS
// =============================================================================

/**
 * Create default hybrid context storage with SQLite and filesystem
 */
export async function createDefaultHybridContextStorage(
  config?: Partial<ContextStorageConfig>
): Promise<HybridContextStorage> {
  const { createDefaultContextStorageConfig } = await import('./context-storage');
  const { SqliteMetadataStorage } = await import('./sqlite-metadata-storage');
  const { FileSystemBlobStorage } = await import('./filesystem-blob-storage');

  const fullConfig = config ? { ...createDefaultContextStorageConfig(), ...config } : createDefaultContextStorageConfig();

  const metadataStorage = new SqliteMetadataStorage(fullConfig);
  const blobStorage = new FileSystemBlobStorage(fullConfig);

  const hybridStorage = new HybridContextStorage(metadataStorage, blobStorage, fullConfig);
  await hybridStorage.initialize();

  return hybridStorage;
}

/**
 * Create hybrid context storage with custom implementations
 */
export async function createCustomHybridContextStorage(
  metadataStorage: IMetadataStorage,
  blobStorage: IBlobStorage,
  config: ContextStorageConfig
): Promise<HybridContextStorage> {
  const hybridStorage = new HybridContextStorage(metadataStorage, blobStorage, config);
  await hybridStorage.initialize();

  return hybridStorage;
} 