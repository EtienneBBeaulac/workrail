-- Enhanced Concurrency Safety for Native Context Management
-- Version 2: Adds active operations tracking and lock management
-- Based on Devil's Advocate Review recommendations

-- Update schema version
INSERT OR IGNORE INTO schema_version (version, description) VALUES (2, 'Enhanced concurrency safety with active operations tracking');

-- =============================================================================
-- ACTIVE OPERATIONS TRACKING
-- =============================================================================

-- Table to track active operations for concurrency safety
CREATE TABLE IF NOT EXISTS active_operations (
    id TEXT PRIMARY KEY,                                    -- Operation UUID
    session_id TEXT NOT NULL,                              -- Session being operated on
    operation_type TEXT NOT NULL CHECK (operation_type IN ('save', 'load', 'delete', 'cleanup')), -- Type of operation
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- When operation started
    heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- Last heartbeat timestamp
    timeout_ms INTEGER NOT NULL DEFAULT 5000,              -- Timeout in milliseconds
    metadata TEXT,                                          -- JSON metadata about operation
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Indexes for efficient lock management
CREATE INDEX IF NOT EXISTS idx_active_operations_session ON active_operations(session_id);
CREATE INDEX IF NOT EXISTS idx_active_operations_heartbeat ON active_operations(heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_active_operations_started ON active_operations(started_at);
CREATE INDEX IF NOT EXISTS idx_active_operations_type ON active_operations(operation_type);

-- =============================================================================
-- AUTOMATIC CLEANUP TRIGGERS
-- =============================================================================

-- Trigger to cleanup stale operations when new operations are inserted
CREATE TRIGGER IF NOT EXISTS cleanup_stale_operations_on_insert
AFTER INSERT ON active_operations
FOR EACH ROW
BEGIN
    -- Remove operations older than 10 minutes or with stale heartbeats (>5 minutes)
    DELETE FROM active_operations 
    WHERE (
        heartbeat_at < datetime('now', '-5 minutes') OR 
        started_at < datetime('now', '-10 minutes')
    ) AND id != NEW.id;
END;

-- Trigger to cleanup operations when sessions are deleted
CREATE TRIGGER IF NOT EXISTS cleanup_operations_on_session_delete
AFTER DELETE ON sessions
FOR EACH ROW
BEGIN
    DELETE FROM active_operations WHERE session_id = OLD.id;
END;

-- =============================================================================
-- SESSION LOCK MANAGEMENT
-- =============================================================================

-- Add session-level lock information to sessions table
ALTER TABLE sessions ADD COLUMN locked_at DATETIME DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN locked_by TEXT DEFAULT NULL;  -- Operation ID holding the lock
ALTER TABLE sessions ADD COLUMN lock_timeout_at DATETIME DEFAULT NULL;

-- Index for efficient lock queries
CREATE INDEX IF NOT EXISTS idx_sessions_locked_at ON sessions(locked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_lock_timeout ON sessions(lock_timeout_at);

-- Trigger to automatically release expired locks
CREATE TRIGGER IF NOT EXISTS release_expired_session_locks
AFTER INSERT ON active_operations
FOR EACH ROW
BEGIN
    -- Release locks that have timed out
    UPDATE sessions 
    SET locked_at = NULL, locked_by = NULL, lock_timeout_at = NULL
    WHERE lock_timeout_at IS NOT NULL AND lock_timeout_at < CURRENT_TIMESTAMP;
END;

-- =============================================================================
-- ENHANCED CHECKPOINT METADATA
-- =============================================================================

-- Add operation tracking to checkpoint metadata
ALTER TABLE checkpoint_metadata ADD COLUMN created_by_operation TEXT DEFAULT NULL;
ALTER TABLE checkpoint_metadata ADD COLUMN compression_ratio REAL DEFAULT 1.0;
ALTER TABLE checkpoint_metadata ADD COLUMN classification_info TEXT DEFAULT NULL; -- JSON with layer counts

-- Index for operation tracking
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_by_operation ON checkpoint_metadata(created_by_operation);

-- =============================================================================
-- STORAGE QUOTA TRACKING
-- =============================================================================

-- Table for tracking storage quotas and usage
CREATE TABLE IF NOT EXISTS storage_quotas (
    id TEXT PRIMARY KEY DEFAULT 'global',                  -- Usually 'global' or session_id
    max_total_size INTEGER NOT NULL DEFAULT 10737418240,   -- 10GB default
    max_checkpoints INTEGER NOT NULL DEFAULT 1000,         -- 1000 checkpoints default
    warning_threshold REAL NOT NULL DEFAULT 0.8,           -- Warn at 80%
    cleanup_threshold REAL NOT NULL DEFAULT 0.9,           -- Auto-cleanup at 90%
    last_cleanup_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Insert default global quota
INSERT OR IGNORE INTO storage_quotas (id, max_total_size, max_checkpoints) 
VALUES ('global', 10737418240, 1000);

-- =============================================================================
-- PERFORMANCE MONITORING
-- =============================================================================

-- Table for tracking operation performance metrics
CREATE TABLE IF NOT EXISTS operation_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT NOT NULL,                          -- save, load, classify, compress
    duration_ms INTEGER NOT NULL,                          -- Operation duration
    context_size_bytes INTEGER DEFAULT NULL,               -- Input size
    compressed_size_bytes INTEGER DEFAULT NULL,            -- Output size (if applicable)
    compression_ratio REAL DEFAULT NULL,                   -- Compression ratio achieved
    session_id TEXT DEFAULT NULL,                          -- Associated session
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT DEFAULT NULL                             -- JSON with additional metrics
);

-- Indexes for performance analysis
CREATE INDEX IF NOT EXISTS idx_metrics_operation_type ON operation_metrics(operation_type);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON operation_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON operation_metrics(session_id);

-- Trigger to automatically cleanup old metrics (keep last 30 days)
CREATE TRIGGER IF NOT EXISTS cleanup_old_metrics
AFTER INSERT ON operation_metrics
FOR EACH ROW
WHEN (NEW.id % 100 = 0)  -- Only run cleanup every 100 inserts for performance
BEGIN
    DELETE FROM operation_metrics 
    WHERE timestamp < datetime('now', '-30 days');
END;

-- =============================================================================
-- ENHANCED VIEWS FOR MONITORING
-- =============================================================================

-- View for active sessions with lock status
CREATE VIEW IF NOT EXISTS active_sessions_with_locks AS
SELECT 
    s.*,
    ao.operation_type as active_operation,
    ao.started_at as operation_started_at,
    ao.heartbeat_at as last_heartbeat,
    CASE 
        WHEN s.locked_at IS NOT NULL AND s.lock_timeout_at > CURRENT_TIMESTAMP THEN 'locked'
        WHEN s.locked_at IS NOT NULL AND s.lock_timeout_at <= CURRENT_TIMESTAMP THEN 'expired_lock'
        WHEN ao.id IS NOT NULL THEN 'operation_active'
        ELSE 'available'
    END as lock_status
FROM sessions s
LEFT JOIN active_operations ao ON s.id = ao.session_id
WHERE s.last_accessed_at > datetime('now', '-7 days');  -- Only recent sessions

-- View for storage usage summary
CREATE VIEW IF NOT EXISTS storage_usage_summary AS
SELECT 
    'global' as scope,
    COUNT(DISTINCT s.id) as total_sessions,
    COUNT(c.id) as total_checkpoints,
    COALESCE(SUM(s.total_size_bytes), 0) as total_size_bytes,
    COALESCE(AVG(c.context_size_bytes), 0) as avg_checkpoint_size,
    MAX(c.created_at) as latest_checkpoint,
    q.max_total_size,
    q.max_checkpoints,
    CAST(COALESCE(SUM(s.total_size_bytes), 0) AS REAL) / q.max_total_size as size_utilization,
    CAST(COUNT(c.id) AS REAL) / q.max_checkpoints as checkpoint_utilization
FROM storage_quotas q
LEFT JOIN sessions s ON q.id = 'global'
LEFT JOIN checkpoint_metadata c ON s.id = c.session_id
WHERE q.id = 'global'
GROUP BY q.id, q.max_total_size, q.max_checkpoints;

-- View for recent operation performance
CREATE VIEW IF NOT EXISTS recent_operation_performance AS
SELECT 
    operation_type,
    COUNT(*) as operation_count,
    AVG(duration_ms) as avg_duration_ms,
    MIN(duration_ms) as min_duration_ms,
    MAX(duration_ms) as max_duration_ms,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as p50_duration_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration_ms,
    AVG(CASE WHEN compression_ratio IS NOT NULL THEN compression_ratio END) as avg_compression_ratio,
    COUNT(CASE WHEN duration_ms > 1000 THEN 1 END) as slow_operations_count
FROM operation_metrics 
WHERE timestamp > datetime('now', '-24 hours')
GROUP BY operation_type;

-- =============================================================================
-- INTEGRITY CONSTRAINTS
-- =============================================================================

-- Ensure no duplicate active operations per session for save operations
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_save_operations 
ON active_operations(session_id) 
WHERE operation_type = 'save';

-- Ensure checkpoint metadata integrity
CREATE INDEX IF NOT EXISTS idx_checkpoints_hash_unique ON checkpoint_metadata(context_hash, session_id);

-- =============================================================================
-- CLEANUP PROCEDURES
-- =============================================================================

-- Create a trigger for automatic maintenance
CREATE TRIGGER IF NOT EXISTS automatic_maintenance
AFTER INSERT ON sessions
FOR EACH ROW
WHEN (NEW.rowid % 50 = 0)  -- Run maintenance every 50 new sessions
BEGIN
    -- Update storage quota usage tracking
    UPDATE storage_quotas 
    SET updated_at = CURRENT_TIMESTAMP 
    WHERE id = 'global';
    
    -- Clean up orphaned operations
    DELETE FROM active_operations 
    WHERE session_id NOT IN (SELECT id FROM sessions);
    
    -- Clean up very old sessions with no checkpoints
    DELETE FROM sessions 
    WHERE id NOT IN (SELECT DISTINCT session_id FROM checkpoint_metadata)
    AND last_accessed_at < datetime('now', '-90 days');
END; 