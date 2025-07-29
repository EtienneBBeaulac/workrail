// Native Context Management Type Definitions
// Core types for automatic context persistence, classification, and compression

// =============================================================================
// CORE CONTEXT MANAGEMENT TYPES
// =============================================================================

/**
 * Four-layer context classification hierarchy for intelligent compression
 * Based on ADR 002: Four-Layer Context Classification Model
 */
export enum ContextLayer {
  CRITICAL = 'CRITICAL',     // Never compressed/dropped - user goals, core decisions
  IMPORTANT = 'IMPORTANT',   // Compressed when necessary - reasoning chains, plans  
  USEFUL = 'USEFUL',         // Aggressively compressed - detailed analysis, examples
  EPHEMERAL = 'EPHEMERAL'    // Dropped between steps - timestamps, debug logs
}

/**
 * Context organized by classification layer
 */
export interface ClassifiedContext {
  [ContextLayer.CRITICAL]: Record<string, any>;
  [ContextLayer.IMPORTANT]: Record<string, any>;
  [ContextLayer.USEFUL]: Record<string, any>;
  [ContextLayer.EPHEMERAL]: Record<string, any>;
}

/**
 * Raw context data before classification
 */
export interface RawContext {
  [key: string]: any;
}

/**
 * Context data prepared for persistence (immutable)
 */
export interface PersistableContext extends Record<string, any> {
  readonly _contextSize?: number;
  readonly _timestamp?: string;
}

// =============================================================================
// CHECKPOINT AND SESSION TYPES
// =============================================================================

/**
 * Metadata for a single saved checkpoint
 * Stored in SQLite database for fast querying
 */
export interface CheckpointMetadata {
  id: string;                    // Primary Key, UUID
  sessionId: string;             // Foreign Key to Session
  name?: string;                 // User-provided name for the checkpoint
  agentId?: string;              // Optional ID of agent that saved
  createdAt: string;             // ISO 8601 timestamp
  tags?: string[];               // User-defined tags for search
  contextSizeBytes: number;      // Size of compressed blob on disk
  contextHash: string;           // SHA-256 of uncompressed context for dedup
  blobPath: string;              // Relative path to context blob file
  status: 'active' | 'archived' | 'corrupt'; // Checkpoint status
}

/**
 * Workflow session information
 * Collection of checkpoints for a workflow execution
 */
export interface SessionInfo {
  id: string;                    // Primary Key, UUID
  createdAt: string;             // ISO 8601 timestamp
  lastAccessedAt: string;        // ISO 8601 timestamp
  tags?: string[];               // User-defined tags for the entire session
  totalSizeBytes: number;        // Total storage used by this session's blobs
}

/**
 * Complete checkpoint data including metadata and context
 */
export interface CheckpointData {
  metadata: CheckpointMetadata;
  context: RawContext;
}

// =============================================================================
// COMPRESSION AND STORAGE TYPES
// =============================================================================

/**
 * Compressed context blob ready for storage
 */
export interface CompressedBlob {
  data: Buffer;                  // Compressed context data
  originalSize: number;          // Size before compression
  compressedSize: number;        // Size after compression
  compressionRatio: number;      // Ratio achieved (originalSize/compressedSize)
  algorithm: 'gzip' | 'deflate' | 'none'; // Compression algorithm used
}

/**
 * Context blob metadata for filesystem storage
 */
export interface BlobMetadata {
  checkpointId: string;
  sessionId: string;
  path: string;                  // Relative path to blob file
  sizeBytes: number;             // File size on disk
  hash: string;                  // SHA-256 checksum
  encrypted: boolean;            // Whether blob is encrypted
}

// =============================================================================
// CLASSIFICATION AND CONFIGURATION TYPES
// =============================================================================

/**
 * Rules for automatic context classification
 */
export interface ClassificationRules {
  patterns: {
    [K in ContextLayer]: ClassificationPattern[];
  };
  heuristics: ClassificationHeuristics;
  overrides: Record<string, ContextLayer>; // Manual overrides per session
}

/**
 * Pattern-based classification rule
 */
export interface ClassificationPattern {
  keyPattern: string;            // Regex pattern for context keys
  valuePattern?: string;         // Optional regex pattern for values
  weight: number;                // Priority weight (higher = more important)
  description: string;           // Human-readable description
}

/**
 * Heuristic-based classification settings
 */
export interface ClassificationHeuristics {
  lengthThresholds: {
    [K in ContextLayer]: number; // Minimum content length for each layer
  };
  keywordWeights: Record<string, number>; // Keywords and their importance scores
  defaultLayer: ContextLayer;   // Fallback layer for unmatched content
}

/**
 * Configuration for context management system
 */
export interface ContextConfig {
  storage: StorageConfig;
  classification: ClassificationRules;
  compression: CompressionConfig;
  encryption: EncryptionConfig;
  quotas: QuotaConfig;
}

/**
 * Storage configuration settings
 */
export interface StorageConfig {
  dataDir: string;               // Base directory for all context data
  maxCheckpoints: number;        // Maximum checkpoints per session
  maxSessionSize: number;        // Maximum storage per session (bytes)
  maxTotalSize: number;          // Maximum total storage (bytes)
  cleanupInterval: number;       // Cleanup interval in milliseconds
}

/**
 * Compression configuration settings
 */
export interface CompressionConfig {
  enabled: boolean;
  algorithm: 'gzip' | 'deflate'; // Compression algorithm
  level: number;                 // Compression level (1-9)
  layerSettings: {
    [K in ContextLayer]: {
      enabled: boolean;
      aggressiveness: 'none' | 'light' | 'medium' | 'aggressive';
    };
  };
}

/**
 * Encryption configuration settings
 */
export interface EncryptionConfig {
  enabled: boolean;
  algorithm: 'aes-256-gcm';      // Encryption algorithm
  keySource: 'os-keychain' | 'env' | 'file'; // Key storage method
}

/**
 * Storage quota configuration
 */
export interface QuotaConfig {
  maxCheckpointsPerSession: number;
  maxContextSizePerCheckpoint: number; // In bytes
  maxTotalStoragePerSession: number;   // In bytes
  maxGlobalStorage: number;            // In bytes
  warningThreshold: number;            // Warning at X% of quota
  cleanupThreshold: number;            // Auto-cleanup at X% of quota
}

// =============================================================================
// SERVICE INTERFACES
// =============================================================================

/**
 * Main context management service interface
 */
export interface IContextManagementService {
  /**
   * Save a checkpoint with automatic classification and compression
   */
  saveCheckpoint(params: SaveCheckpointParams): Promise<SaveCheckpointResult>;

  /**
   * Load a checkpoint by ID or latest from session
   */
  loadCheckpoint(params: LoadCheckpointParams): Promise<LoadCheckpointResult>;

  /**
   * List checkpoints for a session with pagination
   */
  listCheckpoints(params: ListCheckpointsParams): Promise<CheckpointMetadata[]>;

  /**
   * Mark a context key as critical to prevent compression/dropping
   */
  markCritical(params: MarkCriticalParams): Promise<MarkCriticalResult>;
}

/**
 * Context persistence service interface
 */
export interface IContextPersistenceService {
  /**
   * Persist context with classification and compression
   */
  persistContext(sessionId: string, context: RawContext, metadata?: Partial<CheckpointMetadata>): Promise<CheckpointMetadata>;

  /**
   * Restore context from storage
   */
  restoreContext(checkpointId: string): Promise<RawContext>;

  /**
   * Get session information
   */
  getSession(sessionId: string): Promise<SessionInfo>;
}

/**
 * Classification engine interface
 */
export interface IClassificationEngine {
  /**
   * Classify context into layers
   */
  classify(context: RawContext): Promise<ClassifiedContext>;

  /**
   * Mark a key as critical for a session
   */
  markCritical(sessionId: string, contextKey: string): Promise<void>;

  /**
   * Load classification rules
   */
  loadRules(config?: Partial<ClassificationRules>): Promise<void>;
}

/**
 * Compression service interface
 */
export interface ICompressionService {
  /**
   * Compress classified context
   */
  compress(classified: ClassifiedContext): Promise<CompressedBlob>;

  /**
   * Decompress blob back to raw context
   */
  decompress(blob: CompressedBlob): Promise<RawContext>;

  /**
   * Get compression statistics
   */
  getStats(): CompressionStats;
}

/**
 * Storage interface for context data
 */
export interface IContextStorage {
  /**
   * Save checkpoint metadata and blob
   */
  saveCheckpoint(metadata: CheckpointMetadata, blob: CompressedBlob): Promise<void>;

  /**
   * Load checkpoint by ID
   */
  loadCheckpoint(checkpointId: string): Promise<CheckpointData>;

  /**
   * List checkpoints for session
   */
  listCheckpoints(sessionId: string, limit?: number, offset?: number): Promise<CheckpointMetadata[]>;

  /**
   * Delete checkpoint
   */
  deleteCheckpoint(checkpointId: string): Promise<void>;

  /**
   * Get session info
   */
  getSession(sessionId: string): Promise<SessionInfo>;

  /**
   * Create or update session
   */
  upsertSession(session: SessionInfo): Promise<void>;
}

// =============================================================================
// API PARAMETER AND RESULT TYPES
// =============================================================================

/**
 * Parameters for saving a checkpoint
 */
export interface SaveCheckpointParams {
  sessionId?: string;            // Auto-generated if not provided
  context: RawContext;           // Current workflow context
  metadata?: {
    name?: string;
    tags?: string[];
  };
  force?: boolean;               // Save even if unchanged
}

/**
 * Result from saving a checkpoint
 */
export interface SaveCheckpointResult {
  checkpointId: string;
  sessionId: string;
  status: 'SAVED' | 'SKIPPED_UNCHANGED';
  sizeBytes?: number;
}

/**
 * Parameters for loading a checkpoint
 */
export interface LoadCheckpointParams {
  checkpointId?: string;         // Specific checkpoint
  sessionId?: string;            // Latest checkpoint from session
}

/**
 * Result from loading a checkpoint
 */
export interface LoadCheckpointResult {
  checkpointId: string;
  sessionId: string;
  context: RawContext;
  metadata: CheckpointMetadata;
}

/**
 * Parameters for listing checkpoints
 */
export interface ListCheckpointsParams {
  sessionId: string;
  limit?: number;                // Default: 20
  offset?: number;               // Default: 0
  tags?: string[];               // Filter by tags
}

/**
 * Parameters for marking context as critical
 */
export interface MarkCriticalParams {
  sessionId: string;
  contextKey: string;
}

/**
 * Result from marking context as critical
 */
export interface MarkCriticalResult {
  status: 'SUCCESS' | 'KEY_NOT_FOUND';
  message: string;
}

// =============================================================================
// UTILITY AND MONITORING TYPES
// =============================================================================

/**
 * Compression statistics for monitoring
 */
export interface CompressionStats {
  totalOperations: number;
  averageRatio: number;
  totalSizeReduction: number;    // Bytes saved
  averageCompressionTime: number; // Milliseconds
}

/**
 * Performance metrics for context operations
 */
export interface ContextMetrics {
  saveOperations: OperationMetrics;
  loadOperations: OperationMetrics;
  classificationTime: OperationMetrics;
  compressionTime: OperationMetrics;
}

/**
 * Metrics for a specific operation type
 */
export interface OperationMetrics {
  count: number;
  averageTime: number;           // Milliseconds
  p50Time: number;               // 50th percentile
  p95Time: number;               // 95th percentile
  p99Time: number;               // 99th percentile
  errorRate: number;             // Percentage
}

/**
 * System health status
 */
export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unavailable';
  storage: {
    available: boolean;
    usedSpace: number;           // Bytes
    availableSpace: number;      // Bytes
    quotaUsage: number;          // Percentage
  };
  performance: {
    averageSaveTime: number;     // Milliseconds
    averageLoadTime: number;     // Milliseconds
    compressionRatio: number;
  };
  errors: string[];              // Recent error messages
} 