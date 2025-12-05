
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    description TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, description) VALUES (1, 'Initial schema for native context management');

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tags TEXT,  -- JSON array as string
    total_size_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_last_accessed ON sessions(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_sessions_tags ON sessions(tags);

CREATE TABLE IF NOT EXISTS checkpoint_metadata (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT,
    agent_id TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tags TEXT,  -- JSON array as string
    context_size_bytes INTEGER NOT NULL,
    context_hash TEXT NOT NULL,
    blob_path TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session_id ON checkpoint_metadata(session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoint_metadata(created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_tags ON checkpoint_metadata(tags);
CREATE INDEX IF NOT EXISTS idx_checkpoints_hash ON checkpoint_metadata(context_hash); 

-- Add CHECK constraint to sessions
ALTER TABLE sessions ADD CONSTRAINT check_total_size CHECK (total_size_bytes >= 0);

-- Add trigger to update last_accessed_at on session access
-- Note: This trigger assumes updates to sessions table; actual 'access' may need code-level handling
CREATE TRIGGER IF NOT EXISTS update_session_accessed
AFTER UPDATE ON sessions
FOR EACH ROW
BEGIN
    UPDATE sessions SET last_accessed_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

-- Add status column to checkpoint_metadata with default and CHECK
ALTER TABLE checkpoint_metadata ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'corrupt'));

-- Add CHECK constraints to checkpoint_metadata
ALTER TABLE checkpoint_metadata ADD CONSTRAINT check_context_size CHECK (context_size_bytes >= 0);

-- Add triggers for total_size_bytes in sessions
CREATE TRIGGER IF NOT EXISTS update_total_size_insert
AFTER INSERT ON checkpoint_metadata
FOR EACH ROW
BEGIN
    UPDATE sessions SET total_size_bytes = total_size_bytes + NEW.context_size_bytes WHERE id = NEW.session_id;
END;

CREATE TRIGGER IF NOT EXISTS update_total_size_update
AFTER UPDATE ON checkpoint_metadata
FOR EACH ROW
WHEN OLD.context_size_bytes != NEW.context_size_bytes
BEGIN
    UPDATE sessions SET total_size_bytes = total_size_bytes + (NEW.context_size_bytes - OLD.context_size_bytes) WHERE id = NEW.session_id;
END;

CREATE TRIGGER IF NOT EXISTS update_total_size_delete
AFTER DELETE ON checkpoint_metadata
FOR EACH ROW
BEGIN
    UPDATE sessions SET total_size_bytes = total_size_bytes - OLD.context_size_bytes WHERE id = OLD.session_id;
END;

-- Add composite index for efficient latest-per-session queries
CREATE INDEX IF NOT EXISTS idx_checkpoints_session_created_desc ON checkpoint_metadata(session_id, created_at DESC);

-- Create a VIEW for joined session and checkpoint data
CREATE VIEW IF NOT EXISTS session_checkpoints AS
SELECT 
    s.id AS session_id,
    s.created_at AS session_created_at,
    s.last_accessed_at,
    s.tags AS session_tags,
    s.total_size_bytes,
    c.id AS checkpoint_id,
    c.name AS checkpoint_name,
    c.agent_id,
    c.created_at AS checkpoint_created_at,
    c.tags AS checkpoint_tags,
    c.context_size_bytes,
    c.context_hash,
    c.blob_path,
    c.status
FROM sessions s
LEFT JOIN checkpoint_metadata c ON s.id = c.session_id; 