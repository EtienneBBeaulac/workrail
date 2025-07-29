// Context Storage Interfaces
// Core storage contracts for context management system with decorator pattern support

import {
  CheckpointMetadata,
  SessionInfo,
  CheckpointData,
  CompressedBlob,
  BlobMetadata,
  RawContext
} from '../../types/context-types';

// =============================================================================
// CORE STORAGE INTERFACES
// =============================================================================

/**
 * Primary interface for context storage operations
 * Follows the same decorator pattern as IWorkflowStorage
 */
export interface IContextStorage {
  /**
   * Save a complete checkpoint with metadata and blob data
   * Atomically stores both metadata and context blob
   */
  saveCheckpoint(metadata: CheckpointMetadata, blob: CompressedBlob): Promise<void>;

  /**
   * Load a complete checkpoint by ID
   * Returns both metadata and decompressed context
   */
  loadCheckpoint(checkpointId: string): Promise<CheckpointData>;

  /**
   * List checkpoints for a session with pagination
   * Returns metadata only for efficient listing
   */
  listCheckpoints(sessionId: string, limit?: number, offset?: number): Promise<CheckpointMetadata[]>;

  /**
   * Delete a checkpoint and its associated blob
   * Atomically removes both metadata and blob data
   */
  deleteCheckpoint(checkpointId: string): Promise<void>;

  /**
   * Get session information by ID
   * Returns null if session doesn't exist
   */
  getSession(sessionId: string): Promise<SessionInfo | null>;

  /**
   * Create or update session information
   * Upserts session data with current timestamp
   */
  upsertSession(session: SessionInfo): Promise<void>;

  /**
   * Delete a session and all its checkpoints
   * Cascading delete of all associated data
   */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Get storage usage statistics
   * Returns aggregated storage information
   */
  getStorageStats(): Promise<StorageStats>;

  /**
   * Validate storage integrity
   * Checks for corruption and orphaned data
   */
  validateIntegrity(): Promise<ValidationResult>;

  /**
   * Close storage connections and cleanup resources
   */
  close(): Promise<void>;
}

/**
 * Interface for metadata storage operations (typically SQLite)
 * Handles structured data with fast querying capabilities
 */
export interface IMetadataStorage {
  /**
   * Initialize metadata storage (create tables, indexes, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Save checkpoint metadata
   */
  saveCheckpointMetadata(metadata: CheckpointMetadata): Promise<void>;

  /**
   * Get checkpoint metadata by ID
   */
  getCheckpointMetadata(checkpointId: string): Promise<CheckpointMetadata | null>;

  /**
   * List checkpoint metadata for a session
   */
  listCheckpointMetadata(sessionId: string, limit?: number, offset?: number): Promise<CheckpointMetadata[]>;

  /**
   * Delete checkpoint metadata
   */
  deleteCheckpointMetadata(checkpointId: string): Promise<void>;

  /**
   * Save or update session information
   */
  upsertSessionInfo(session: SessionInfo): Promise<void>;

  /**
   * Get session information
   */
  getSessionInfo(sessionId: string): Promise<SessionInfo | null>;

  /**
   * Delete session and cascade to checkpoints
   */
  deleteSessionInfo(sessionId: string): Promise<void>;

  /**
   * Get aggregated storage statistics
   */
  getMetadataStats(): Promise<MetadataStats>;

  /**
   * Acquire exclusive lock for session operations
   * Returns operation ID for lock tracking
   */
  acquireSessionLock(sessionId: string, operationType: string, timeoutMs?: number): Promise<string>;

  /**
   * Release session lock
   */
  releaseSessionLock(operationId: string): Promise<void>;

  /**
   * Update operation heartbeat for long-running operations
   */
  updateOperationHeartbeat(operationId: string): Promise<void>;

  /**
   * Cleanup stale operations and expired locks
   */
  cleanupStaleOperations(): Promise<number>;

  /**
   * Close metadata storage connection
   */
  close(): Promise<void>;
}

/**
 * Interface for blob storage operations (typically filesystem)
 * Handles large binary data with efficient I/O
 */
export interface IBlobStorage {
  /**
   * Initialize blob storage (create directories, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Save compressed blob data
   * Returns blob metadata with path and checksum
   */
  saveBlob(sessionId: string, checkpointId: string, blob: CompressedBlob): Promise<BlobMetadata>;

  /**
   * Load blob data by metadata
   * Returns the compressed blob for decompression
   */
  loadBlob(blobMetadata: BlobMetadata): Promise<CompressedBlob>;

  /**
   * Delete blob file
   */
  deleteBlob(blobMetadata: BlobMetadata): Promise<void>;

  /**
   * Get blob storage statistics
   */
  getBlobStats(): Promise<BlobStats>;

  /**
   * Validate blob integrity (checksums, file existence)
   */
  validateBlobIntegrity(): Promise<BlobValidationResult>;

  /**
   * Cleanup orphaned blob files
   * Removes files not referenced by any checkpoint
   */
  cleanupOrphanedBlobs(referencedPaths: string[]): Promise<number>;

  /**
   * Get available disk space
   */
  getAvailableSpace(): Promise<number>;

  /**
   * Close blob storage resources
   */
  close(): Promise<void>;
}

// =============================================================================
// STORAGE RESULT TYPES
// =============================================================================

/**
 * Storage usage statistics
 */
export interface StorageStats {
  totalSessions: number;
  totalCheckpoints: number;
  totalSizeBytes: number;
  averageCheckpointSize: number;
  oldestCheckpoint?: string;
  newestCheckpoint?: string;
  storageUtilization: number; // Percentage of quota used
}

/**
 * Metadata storage statistics
 */
export interface MetadataStats {
  databaseSizeBytes: number;
  totalSessions: number;
  totalCheckpoints: number;
  activeOperations: number;
  averageCheckpointSize: number;
  indexEfficiency: number; // Query performance metric
}

/**
 * Blob storage statistics
 */
export interface BlobStats {
  totalFiles: number;
  totalSizeBytes: number;
  averageFileSize: number;
  compressionRatio: number;
  availableSpaceBytes: number;
  directoryStructure: DirectoryInfo[];
}

/**
 * Directory information for blob storage
 */
export interface DirectoryInfo {
  path: string;
  fileCount: number;
  totalSize: number;
  lastModified?: string;
}

/**
 * Storage validation results
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  repairSuggestions: string[];
}

/**
 * Blob validation results
 */
export interface BlobValidationResult {
  isValid: boolean;
  corruptedFiles: string[];
  missingFiles: string[];
  orphanedFiles: string[];
  checksumMismatches: ChecksumMismatch[];
}

/**
 * Validation error information
 */
export interface ValidationError {
  type: 'CORRUPTION' | 'MISSING_DATA' | 'CONSTRAINT_VIOLATION' | 'ORPHANED_DATA';
  description: string;
  affectedItems: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

/**
 * Validation warning information
 */
export interface ValidationWarning {
  type: 'PERFORMANCE' | 'CLEANUP_NEEDED' | 'QUOTA_WARNING';
  description: string;
  suggestion: string;
}

/**
 * Checksum mismatch information
 */
export interface ChecksumMismatch {
  filePath: string;
  expectedChecksum: string;
  actualChecksum: string;
  checkpointId: string;
}

// =============================================================================
// STORAGE CONFIGURATION
// =============================================================================

/**
 * Configuration for context storage
 */
export interface ContextStorageConfig {
  /** Base directory for all context data */
  dataDirectory: string;

  /** SQLite database configuration */
  database: {
    /** Database file path (relative to dataDirectory) */
    path: string;
    /** Connection timeout in milliseconds */
    timeout: number;
    /** Maximum number of connections */
    maxConnections: number;
    /** Enable WAL mode for better concurrency */
    walMode: boolean;
  };

  /** Blob storage configuration */
  blobs: {
    /** Directory for context blobs (relative to dataDirectory) */
    directory: string;
    /** File permissions for created files */
    filePermissions: number;
    /** Directory permissions for created directories */
    directoryPermissions: number;
    /** Enable atomic writes (temp file + rename) */
    atomicWrites: boolean;
  };

  /** Lock and concurrency configuration */
  concurrency: {
    /** Default operation timeout in milliseconds */
    operationTimeoutMs: number;
    /** Maximum retry attempts for acquiring locks */
    maxRetries: number;
    /** Heartbeat interval for long operations */
    heartbeatIntervalMs: number;
    /** Stale operation cleanup interval */
    cleanupIntervalMs: number;
  };

  /** Storage quota limits */
  quotas: {
    /** Maximum total storage size in bytes */
    maxTotalSize: number;
    /** Maximum checkpoints per session */
    maxCheckpointsPerSession: number;
    /** Warning threshold (0.0 - 1.0) */
    warningThreshold: number;
    /** Cleanup threshold (0.0 - 1.0) */
    cleanupThreshold: number;
  };

  /** Validation and integrity checking */
  validation: {
    /** Enable checksum validation on read */
    enableChecksumValidation: boolean;
    /** Automatic integrity check interval (0 = disabled) */
    integrityCheckIntervalMs: number;
    /** Enable orphaned file cleanup */
    enableOrphanedFileCleanup: boolean;
  };
}

/**
 * Default storage configuration factory
 */
export function createDefaultContextStorageConfig(baseDir?: string): ContextStorageConfig {
  const os = require('os');
  const path = require('path');
  
  const defaultBaseDir = baseDir || path.join(os.homedir(), '.workrail');

  return {
    dataDirectory: defaultBaseDir,
    database: {
      path: 'workrail.db',
      timeout: 5000,
      maxConnections: 10,
      walMode: true
    },
    blobs: {
      directory: 'contexts',
      filePermissions: 0o600, // Read/write for owner only
      directoryPermissions: 0o700, // Read/write/execute for owner only
      atomicWrites: true
    },
    concurrency: {
      operationTimeoutMs: 5000,
      maxRetries: 3,
      heartbeatIntervalMs: 1000,
      cleanupIntervalMs: 60000 // 1 minute
    },
    quotas: {
      maxTotalSize: 10 * 1024 * 1024 * 1024, // 10GB
      maxCheckpointsPerSession: 1000,
      warningThreshold: 0.8,
      cleanupThreshold: 0.9
    },
    validation: {
      enableChecksumValidation: true,
      integrityCheckIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
      enableOrphanedFileCleanup: true
    }
  };
}

// =============================================================================
// STORAGE FACTORY INTERFACE
// =============================================================================

/**
 * Factory interface for creating storage implementations
 * Supports dependency injection and testing
 */
export interface IContextStorageFactory {
  /**
   * Create metadata storage implementation
   */
  createMetadataStorage(config: ContextStorageConfig): Promise<IMetadataStorage>;

  /**
   * Create blob storage implementation
   */
  createBlobStorage(config: ContextStorageConfig): Promise<IBlobStorage>;

  /**
   * Create complete context storage with decorators
   */
  createContextStorage(config: ContextStorageConfig): Promise<IContextStorage>;
}

/**
 * Storage operation context for tracking and debugging
 */
export interface StorageOperationContext {
  operationId: string;
  operationType: string;
  sessionId?: string;
  checkpointId?: string;
  startTime: number;
  metadata?: Record<string, any>;
} 