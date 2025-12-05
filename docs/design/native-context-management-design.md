# Native Context Management for MCP Workflows

## Executive Summary

This document outlines the design for native context management in the Workrail MCP server. The solution addresses the fundamental challenge of context saturation in long-running workflows by providing automatic, intelligent context persistence and compression while maintaining the MCP's stateless architecture.

## Problem Statement

### Current Challenges

1. **Manual Context Management**: Each workflow must manually implement context documentation (e.g., CONTEXT.md files), leading to:
   - Repetitive boilerplate code across workflows
   - Inconsistent implementation patterns
   - Error-prone manual state handling
   - Increased workflow complexity

2. **Context Window Saturation**: LLM context windows (even 100K+ tokens) fill rapidly during complex workflows:
   - Multi-agent workflows consume 4-15x more tokens than standard chats
   - No automatic compression or prioritization
   - Loss of critical information when limits are reached
   - Expensive token usage

3. **No Native Resumption**: When a workflow session ends:
   - All context is lost
   - No standardized way to resume work
   - Users must manually reconstruct state
   - Collaboration and handoffs are difficult

4. **Architectural Impedance Mismatch**: Stateful workflows forced onto stateless infrastructure:
   - LLMs have no memory between calls
   - MCP servers are stateless by design
   - Complex workflows require continuity

## Solution Overview

### Core Concept

Provide native context management tools in the MCP server that automatically handle:
- Context classification and prioritization
- Intelligent compression
- Checkpoint persistence
- Seamless workflow resumption

All while maintaining the MCP's stateless architecture by using external storage.

### Key Principles

1. **MCP Remains Stateless**: The MCP server acts as an API to external storage, maintaining no state between requests
2. **Zero Configuration**: Works out of the box with sensible defaults
3. **Workflow Transparent**: Existing workflows continue to work without modification
4. **Agent Friendly**: Minimal cognitive load on the LLM
5. **Storage Agnostic**: Pluggable storage backends

## Architecture

### System Components

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│                 │     │                  │     │                 │
│   LLM Agent     │────▶│   MCP Server     │────▶│ Storage Layer   │
│                 │     │   (Stateless)    │     │  (Stateful)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                           │
                               │                    ┌──────▼────────┐
                        ┌──────▼────────┐           │               │
                        │               │           │  SQLite DB    │
                        │ Context Tools │           │               │
                        │               │           └───────────────┘
                        └───────────────┘                  │
                               │                    ┌──────▼────────┐
                        ┌──────▼────────┐           │               │
                        │               │           │  File System  │
                        │  Compression  │           │               │
                        │               │           └───────────────┘
                        └───────────────┘
```

### Storage Strategy (Hybrid Approach)

#### SQLite Database
- **Purpose**: Metadata, indices, and queries
- **Stores**:
  - Session information
  - Checkpoint metadata
  - Search indices
  - Workflow state
- **Benefits**: Zero-config, ACID compliant, excellent query capabilities

#### File System
- **Purpose**: Large context blobs
- **Stores**:
  - Compressed context data
  - Human-readable exports
  - Backup files
- **Benefits**: Simple, efficient for large data, Git-friendly

### Context Classification System

#### Four-Layer Hierarchy (Based on Research)

1. **CRITICAL (30% of budget)**
   - Never compressed or dropped
   - Examples: User goals, core decisions, task requirements
   - Patterns: `/^user(Goal|Requirement)/`, `/^task(Complexity|Type)/`

2. **IMPORTANT (40% of budget)**
   - Compressed when necessary
   - Examples: Reasoning chains, implementation plans
   - Patterns: `/^analysis|findings/`, `/^implementation(Plan|Strategy)/`

3. **USEFUL (20% of budget)**
   - Aggressively compressed
   - Examples: Detailed analysis, code examples
   - Content-based: Long text blocks, verbose outputs

4. **EPHEMERAL (10% of budget)**
   - Dropped between steps
   - Examples: Timestamps, debug logs, temporary data
   - Patterns: `/^timestamp|debug|log|temp/`

### Compression Strategies

1. **LLMLingua Integration**
   - Up to 20x compression with minimal information loss
   - Token importance scoring
   - Budget-based compression

2. **Hierarchical Summarization**
   - Recursive summarization for deep context
   - Preserves key decisions and outcomes
   - Human-readable summaries

3. **Progressive Compression**
   - More aggressive as context ages
   - Recent context stays detailed
   - Historical context becomes summaries

## Implementation Design

### MCP Tools API

#### Core Tools

```
workflow_checkpoint_save
- Saves current workflow state and context
- Automatic compression and classification
- Returns checkpoint ID

workflow_checkpoint_load
- Loads specific checkpoint
- Decompresses context as needed
- Restores complete workflow state

workflow_checkpoint_list
- Lists available checkpoints
- Supports filtering by workflow, time, etc.
- Returns metadata for selection

workflow_context_compress
- Manual compression trigger
- Configurable strategies
- Returns compressed context

workflow_context_prioritize
- Reorganizes context by importance
- Applies token budgets
- Drops ephemeral data

workflow_mark_critical
- Agent override for important data
- Prevents compression/dropping
- Adds metadata tags
```

### Workflow Integration

#### Automatic Mode (Default)
- Context automatically classified based on patterns
- Compression triggered at thresholds
- Checkpoints saved at phase boundaries
- No workflow changes required

#### Hybrid Mode (Recommended)
- Automatic management with agent overrides
- Workflows can define context rules
- Agents can mark critical items
- Best balance of automation and control

### Storage Organization

```
~/.local/share/workrail/        # Linux
~/Library/Application Support/workrail/  # macOS
%APPDATA%\workrail\            # Windows

workrail/
├── workrail.db                # SQLite database
├── contexts/                  # Compressed context blobs
│   ├── {session-id}/
│   │   ├── {checkpoint-id}.json.gz
│   │   └── metadata.json
├── exports/                   # Human-readable exports
│   └── {workflow-id}-{date}.json
└── config.json               # User configuration
```

### Storage Management and Quotas

To prevent uncontrolled storage growth, the system will enforce configurable limits.

TODO: need to check if these are truly the numbers we want.

#### Per-Session/Workflow Limits
- **Maximum Checkpoints**: `100` (default, configurable). Oldest checkpoints are pruned first when the limit is reached.
- **Maximum Context Size per Checkpoint**: `10MB` (compressed). Prevents single oversized checkpoints.
- **Maximum Total Storage per Session**: `1GB`.

#### Global Limits
- **Maximum Total Storage**: `10GB` (configurable).
- **Warning Threshold**: A warning is logged when global storage exceeds 80% of its capacity.
- **Automatic Cleanup**: A cleanup job is triggered when storage exceeds 90% capacity, pruning the oldest sessions first.

#### Quota Enforcement
- **Soft Limits**: Log warnings and notify the agent/user.
- **Hard Limits**: Fail the `workflow_checkpoint_save` operation with a clear error message.
- **Emergency Cleanup**: If a write fails due to disk space, the system will attempt an emergency cleanup and retry the operation once.

### Session Management

#### Session Correlation
- Chat ID from the platform
- Agent ID for multi-agent systems
- Workflow ID being executed
- Unique session ID
- Optional user ID

#### Discovery Mechanisms
1. Exact chat/session match
2. Recent workflow runs by same user
3. Semantic search on context
4. Time-based queries
5. Tag-based retrieval

#### Multi-Agent Session Sharing

To support collaborative workflows, the system must handle concurrent access to the same session.

**Locking Strategy**:
- **Optimistic Locking for Reads**: Multiple agents can read from the same session context simultaneously without issue.
- **Pessimistic Locking for Writes**: When `workflow_checkpoint_save` is called, an exclusive lock is placed on the session's metadata record in SQLite. This ensures that concurrent writes are serialized, preventing race conditions.
- **Lock Timeout**: A sensible timeout (e.g., 5 seconds) will be implemented to prevent indefinite blocking.

**Conflict Resolution**:
- **Last-Write-Wins**: Due to write serialization, the last agent to acquire the lock will successfully save its checkpoint.
- **Agent Attribution**: The `agentId` will be stored in the checkpoint metadata, providing a clear audit trail of who made which changes.

### Concurrency Management

To handle concurrent operations from multiple agents or processes on the same session, the system will use SQLite's transaction support to ensure data integrity. When a write operation (like `workflow_checkpoint_save`) is initiated, the process will acquire a lock on the relevant session records within a transaction. This serializes concurrent writes, preventing race conditions and ensuring that checkpoints are always saved in a consistent state.

### Error Handling and Storage Recovery

The system will be designed to be resilient to common storage failures:
- **Atomic Writes**: All write operations will be atomic. Context blobs will be written to a temporary file before being renamed to their final destination on success. All database modifications will be wrapped in transactions. This prevents checkpoints from being left in a partially written, corrupt state.
- **Corruption Recovery**: On startup, the system will validate the integrity of the SQLite database. If corruption is detected, a recovery mode will be triggered to attempt to rebuild the metadata index by scanning the checkpoint files on the filesystem.
- **Graceful Degradation**: If the storage directory is inaccessible (e.g., due to a permissions error or a full disk), the context management system will gracefully fall back to a transient, in-memory-only mode for the current session, logging a clear error.

#### Detailed Error Scenarios

1.  **Storage Full**:
    -   **Detection**: Check available disk space before initiating a write operation.
    -   **Recovery**: If space is low, trigger an automatic cleanup of the oldest, least-recently-used checkpoints. Retry the write once.
    -   **Fallback**: If cleanup doesn't free enough space, switch to in-memory-only mode for the session and return an error.
    -   **User Notification**: Return a clear error message to the agent and log a persistent warning about the storage state.

2.  **Corrupted Checkpoint**:
    -   **Detection**: Use checksums (e.g., SHA-256) stored in the SQLite metadata to validate context blobs on read.
    -   **Recovery**: If a checkpoint file is found to be corrupt, mark it as invalid in the database and attempt to load the previous valid checkpoint for the session.
    -   **Logging**: Log a detailed report of the corruption, including the checkpoint ID and associated file path.

3.  **Database Unavailability**:
    -   **Detection**: Handle connection errors or timeouts when querying the SQLite database.
    -   **Recovery**: For transient errors, retry with exponential backoff for a short period.
    -   **Fallback**: If the database remains unavailable, revert to in-memory-only mode. Checkpoint listing and loading will be disabled.
    -   **User Notification**: Log a critical error indicating the system is operating in a degraded state.

### Integration with Existing `ContextOptimizer`

The new native context management system is designed to **complement, not replace,** the existing in-memory `ContextOptimizer`.
- The `ContextOptimizer` will continue to handle high-frequency, runtime optimizations (e.g., efficient context merging for loops) to ensure low-latency workflow execution.
- The new persistence layer takes over when the context needs to be prepared for long-term storage. The flow is as follows: `ContextOptimizer` manages the live context -> at a trigger point, the live context is passed to the persistence layer -> the persistence layer then classifies, compresses, and saves the state as a checkpoint.

#### Detailed Integration Flow

1.  **Runtime Context Flow**:
    *   The `ContextOptimizer` continues to manage the live, in-memory context during normal workflow step execution for maximum performance.
    *   When the context size approaches its warning threshold (e.g., 80% of max), it can trigger a background compression task on non-critical parts of the context.
    *   At a checkpoint trigger (either manual via the tool or automatic), the `ContextOptimizer` passes the fully optimized context to the persistence layer.
    *   On workflow resumption, the persistence layer loads the compressed context, which is then rehydrated and managed by the `ContextOptimizer` for the new session.

2.  **API Contract Sketch**:
    To facilitate this, the `ContextOptimizer` could be enhanced with methods to interface cleanly with the persistence layer.
    ```typescript
    // ContextOptimizer could gain new methods for persistence
    interface ContextOptimizer {
      // Existing methods remain unchanged
      createEnhancedContext(...);
      mergeLoopState(...);
      
      // New integration points
      prepareForPersistence(context: EnhancedContext): CompressibleContext;
      restoreFromPersistence(compressed: CompressedContext): EnhancedContext;
    }
    ```

## User Experience

### Zero Configuration Setup

#### NPX Installation
```bash
npx @workrail/mcp-server
```
- Automatically creates storage directories
- Initializes SQLite database
- No configuration required

#### Docker Installation
```bash
docker run -v ~/.workrail:/data workrail/mcp-server
```
- Persistent volume for data
- Same zero-config experience
- Isolated environment

### Agent Configuration
Users only need to add to their MCP configuration:
```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["@workrail/mcp-server"],
      "env": {}
    }
  }
}
```

### Configuration Examples

#### Minimal Configuration (Default Behavior)
This is the standard zero-config setup that works out of the box.
```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["@workrail/mcp-server"]
    }
  }
}
```

#### Advanced Configuration
Users can override default behaviors by passing environment variables through their MCP configuration.
```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["@workrail/mcp-server"],
      "env": {
        "WORKRAIL_CONTEXT_COMPRESSION": "advanced",
        "WORKRAIL_CHECKPOINT_AUTO_SAVE": "true",
        "WORKRAIL_MAX_CHECKPOINTS": "50",
        "WORKRAIL_STORAGE_PATH": "/custom/path/to/data",
        "WORKRAIL_ENCRYPTION": "enabled"
      }
    }
  }
}
```

### Workflow Execution Experience

1. **Transparent Operation**: Workflows run normally without changes
2. **Automatic Benefits**: Context compression and checkpointing happen automatically
3. **Resume Capability**: Simple checkpoint selection to continue work
4. **Debugging Tools**: Built-in CLI for inspection and management

## Design Decisions

### Why Hybrid Storage (SQLite + Files)?

**Decision**: Use SQLite for metadata and files for context blobs

**Reasons**:
- SQLite provides excellent query capabilities with zero configuration
- File storage prevents database bloat from large contexts
- Allows efficient streaming compression/decompression
- Maintains human-readable export capability
- Balances performance with simplicity

### Why Four-Layer Context Model?

**Decision**: Adopt CRITICAL/IMPORTANT/USEFUL/EPHEMERAL classification

**Reasons**:
- Research-validated approach showing optimal token distribution
- Maps naturally to workflow information patterns
- Provides clear compression priorities
- Maintains essential information under pressure

### Why Automatic Classification?

**Decision**: Use pattern matching and content analysis for auto-classification

**Reasons**:
- Reduces cognitive load on LLM agents
- Ensures consistent classification
- Allows workflow-specific overrides
- Provides sensible defaults

### Why Support Both NPX and Docker?

**Decision**: Provide both distribution methods

**Reasons**:
- NPX offers simplest installation for Node.js users
- Docker provides complete isolation and consistency
- Both require zero configuration
- Meets users where they are

## Privacy and Security Considerations

### Local-Only Storage
- All data stored on user's machine
- No network transmission of context
- User has complete control

### Optional Encryption
- Opt-in encryption for sensitive workflows
- OS keychain integration for key management
- Transparent encryption/decryption

### Data Isolation
- Separate storage per user on multi-user systems
- Appropriate file permissions
- No cross-workflow data leakage

### Security Hardening

#### Input Validation
- Sanitize all checkpoint and session IDs to prevent injection attacks (e.g., allow only alphanumeric characters, dashes, and underscores).
- Validate context size before processing to avoid denial-of-service from oversized payloads.
- Prevent path traversal attacks in any file-based storage operations by resolving and normalizing all paths.

#### Access Control
- On multi-user systems, ensure file permissions are set correctly (e.g., `0700` for directories) to prevent unauthorized access to other users' data.
- Implement a read-only mode via configuration for environments where writing new checkpoints should be disabled.
- Include audit logging for sensitive operations like checkpoint creation, deletion, and loading.

#### Sensitive Data Handling
- Implement a mechanism to warn users if potentially sensitive data (e.g., content matching patterns for API keys, PII) is detected in the context.
- Provide clear guidance on using `workflow_mark_critical` combined with encryption to protect sensitive information.
- Ensure that when a checkpoint is deleted, the associated data is securely removed from the filesystem, not just unlinked.

## Performance Characteristics

### Performance SLAs

The system will be benchmarked to meet the following Service Level Agreements for performance.

| Operation                 | P50   | P95    | P99    | Max  |
|---------------------------|-------|--------|--------|------|
| Checkpoint Save (avg ctx) | 50ms  | 100ms  | 200ms  | 1s   |
| Checkpoint Load (avg ctx) | 100ms | 500ms  | 1s     | 5s   |
| Compression (100KB)       | 10ms  | 20ms   | 50ms   | 100ms|
| Classification            | 1ms   | 5ms    | 10ms   | 50ms |
| Metadata Query (indexed)  | 5ms   | 10ms   | 20ms   | 100ms|

### Expected Metrics
- **Compression Ratio**: 10-20x for typical workflows
- **Checkpoint Save Time**: <100ms for average context
- **Resume Time**: <500ms including decompression
- **Storage Growth**: ~1-5MB per workflow day
- **Query Performance**: <10ms for checkpoint discovery

### Optimization Strategies
- WAL mode for SQLite (better concurrency)
- Streaming compression for large contexts
- Indexed queries for fast retrieval
- Automatic cleanup of old data

### Hardware Requirements
- **Minimum**: 2GB RAM, 1GB free disk space.
- **Recommended**: 4GB+ RAM, 5GB+ free disk space for extensive history.
- **Storage Growth**: Estimated ~1-5MB per typical workflow session per day.

## Migration and Compatibility

### Versioning Strategy
- Schema version tracked in database
- Automatic migrations on upgrade
- Backward compatibility for exports
- Clear upgrade paths

### Export/Import Format
- Standard JSON format for portability
- Includes version information
- Human-readable structure
- Tool-independent format

### Legacy Manual Context Migration

We have decided not to prioritize automated tools or features for migrating legacy manual context (e.g., from CONTEXT.md files) into the new checkpoint system at this time. Current manual context files are very limited in scope and functionality, and there are no known users with active, long-running legacy contexts that require porting. This decision keeps the MVP focused and avoids unnecessary complexity. If user needs evolve, we can revisit adding import capabilities in a future iteration.

### Feature Detection
An agent or workflow can detect if the native context management features are available and adjust its strategy accordingly. This ensures robust behavior in environments with different server versions.
```typescript
// Example logic for an agent to check for tool availability
if (serverCapabilities.tools.some(tool => tool.name === 'workflow_checkpoint_save')) {
  // Use native features for state management
} else {
  // Fall back to manual, in-context state management
}
```

## Future Enhancements

### Potential Features
1. **Workflow Analytics**: Token usage, compression effectiveness
2. **Collaborative Checkpoints**: Shareable workflow states
3. **Cloud Backup**: Optional cloud storage integration
4. **Context Search**: Full-text search across checkpoints
5. **Visual Timeline**: GUI for checkpoint exploration
6. **Chunked Processing for Large Contexts**: Post-MVP enhancement to handle very large context blobs (e.g., 100MB+) by breaking them into chunks for streaming compression/decompression, improving scalability and preventing timeouts on lower-end hardware.

### Extension Points
- Pluggable storage providers
- Custom compression strategies
- Workflow-specific plugins
- Integration with other MCP tools

## Testing Requirements

A comprehensive testing strategy is critical for ensuring the reliability and data integrity of this feature.

### Unit Tests
- **Classification Logic**: Verify that context items are correctly assigned to `CRITICAL`, `IMPORTANT`, etc., with >95% accuracy on a predefined test set.
- **Compression Helpers**: Test compression and decompression algorithms for correctness, performance, and data integrity.
- **Storage Operations**: Ensure all database and file operations are atomic and correctly handle edge cases (e.g., file locks, empty data, permissions errors).
- **Error Handling Paths**: Each failure scenario (e.g., disk full, DB corruption, invalid permissions) must have a corresponding unit test to verify graceful degradation.

### Integration Tests
- **Full Save/Load Cycle**: Test the end-to-end flow of saving a checkpoint—including classification, compression, and storage—and then loading it back to a valid state.
- **Concurrent Access**: Simulate multiple agents or processes trying to write to the same session simultaneously to verify that locking mechanisms prevent data corruption.
- **Storage Failure Recovery**: Test the system's ability to recover from a simulated corrupt database or missing context files during startup.
- **Performance Benchmarks**: Run automated tests to ensure the system meets the defined Performance SLAs under typical and high-load conditions.

### End-to-End (E2E) / Acceptance Tests
- **Workflow Interruption & Resumption**: Simulate a full user journey where a complex workflow is started, the server is unexpectedly terminated, and the workflow is successfully and accurately resumed from the last checkpoint.
- **Storage Cleanup**: Verify that automatic and manual cleanup policies correctly identify and delete old or excessive checkpoints without affecting active workflows.
- **Cross-Platform Compatibility**: Run key E2E tests on all three target operating systems (Windows, macOS, Linux) to ensure consistent behavior.
- **Resilience and Chaos Testing**: Incorporate fault injection to simulate real-world failures, such as disk full mid-save, process interruptions, concurrent overloads, or low-resource conditions, and verify that recovery mechanisms (e.g., atomic writes, graceful degradation) function correctly while meeting SLAs.

## Implementation Timeline

### Phase 1: Core Infrastructure
- SQLite setup and schema
- Basic checkpoint save/load
- File-based context storage

### Phase 2: Compression and Classification
- Pattern-based classification
- LLMLingua integration
- Progressive compression

### Phase 3: Developer Experience
- CLI tools
- Export/import functionality
- Debugging capabilities

### Phase 4: Polish and optimization
- Performance tuning
- Documentation
- Example workflows

## Success Metrics

### Technical Metrics
- Context compression ratio achieved
- Checkpoint/resume reliability
- Performance benchmarks met
- Storage efficiency

### User Metrics
- Zero-configuration success rate
- Workflow completion rates improvement
- Token cost reduction
- User satisfaction scores

## Conclusion

Native context management in the MCP server solves fundamental workflow challenges while maintaining architectural purity. By providing automatic, intelligent context handling with zero configuration, we enable workflows to scale beyond traditional context limits while improving developer and user experience.

The hybrid storage approach, research-backed compression strategies, and thoughtful integration patterns create a solution that is both powerful and accessible, setting a new standard for workflow context management in LLM-based systems. 

## Design Decisions Log

This section tracks key decisions made during the design process, including rationale, pros/cons, and any refinements.

### Decision 1: Compression Strategy

**Chosen Option**: Hybrid Algorithmic + Local LLM (Rank 1).

**Description**: Use pure JS algorithms (e.g., TF-IDF for summarization, gzip for basics) as the default, with optional local LLM (e.g., Phi-2 or GPT-2 small) for advanced compression. Hierarchical summarization would use the same mechanisms.

**Refinements**:
- **Default Mode**: Pure algorithmic for zero-config, always-available basics.
- **Advanced Mode**: Enables local LLM for 10-20x compression, triggered via config args/env (e.g., `--context-compression=advanced`).
- **Automatic Setup**: Non-interactive background downloads to global persistent storage (e.g., `~/.workrail/models/`); silent fallbacks to basic if offline/low-spec.
- **Post-MVP Note**: Local LLM integration is post-MVP—implement algorithmic core first, add LLM later after thorough testing (e.g., performance benchmarks, hardware compatibility verification across platforms, and edge-case handling like failed downloads).
- **Testing/Verification**: This needs proper validation, including benchmarks for compression ratios, startup times, offline behavior, and cross-platform persistence.
- **Post-MVP Deferral with Enhanced Basic Mode**: Defer local LLM entirely to post-MVP, and strengthen the basic mode with additional algorithmic techniques (e.g., multi-level gzip + TF-IDF-based summarization) to achieve 5-10x compression ratios reliably in the MVP.

**Pros**:
- Eliminates overhead and bloat in the initial release; provides a robust, dependency-free baseline; maintains zero-config purity while improving default performance.

**Cons**:
- Delays access to maximum compression ratios; requires additional implementation effort for enhanced algorithms.

**Rationale**: This prioritizes a lightweight MVP, avoiding potential user frustration from model downloads or hardware requirements, while ensuring basic compression is effective enough for most use cases and setting up a clear path for advanced features.

### Decision 2: Semantic Search Implementation

**Chosen Option**: Include with Lightweight Local Library (Rank 1).

**Description**: Add a small, JS-based library (e.g., MiniSearch or hnswlib-node) for basic semantic search on checkpoint metadata/content. Enable it automatically if the dep is present (bundled in package).

**Refinements**:
- Bundled as a dependency in NPX/Docker, with auto-detection (use if available, fallback to keyword otherwise).
- Focus on low-bloat implementation to align with zero-config goals.

**Pros**:
- Enables intuitive discovery (semantic queries like "find checkpoints about auth"); improves resumption in real scenarios; low bloat (small deps, no runtime overhead if unused); fully local/offline.

**Cons**:
- Adds minor package size (~10-50MB); potential perf hit on low-end hardware (embedding computation ~100ms/query); extra code to maintain.

**Rationale**: Prioritizes UX/resumption reliability (critical for long workflows) while minimizing bloat—Option 1 adds meaningful value with controlled deps. Our local-only constraint favors lightweight JS libs over heavy ML. The analysis's dep concerns are mitigated by bundling and fallbacks. 

### Decision 3: Primary Storage Backend

**Chosen Option**: Hybrid SQLite + Filesystem (Rank 1).

**Description**: Use SQLite for metadata (session info, checkpoint headers, tags, search indices) and store large context blobs as compressed files (e.g., `.json.gz`) in the filesystem, linked by a path in the database.

**Pros**:
- Excellent query performance on metadata; keeps the database lean and fast; efficient storage for large blobs; easy to inspect/backup context files manually; atomic metadata operations via transactions.

**Cons**:
- Slightly more complex to implement (managing file links and potential orphans); requires two storage locations to manage.

**Rationale**: This is a proven, scalable pattern for local applications. It leverages SQLite's powerful querying for metadata while avoiding database bloat by offloading large blobs, directly mitigating concerns from the analysis. This combination of performance, flexibility, and scalability makes it the most robust choice. 

### Decision 4: Encryption Approach

**Chosen Option**: Opt-in Encryption via Config (Rank 1).

**Description**: Encryption is off by default. Users can enable it with a config flag (e.g., `--encryption=enabled` in the `args` of their MCP config). When enabled, the system uses the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service API) to securely store a master encryption key non-interactively.

**Pros**:
- Flexible (user chooses); no performance penalty for users who don't need it; secure key storage via OS keychain; can be implemented non-interactively once configured.

**Cons**:
- Not secure by default (requires an explicit user choice); slightly more complex to implement the opt-in logic and keychain integration.

**Rationale**: Aligns with mature developer tool design by providing a powerful feature without forcing it on everyone. It makes security a conscious, low-friction choice, directly addressing the analysis's concern by specifying a concrete, secure implementation (OS keychain) without being overly prescriptive for every user. 

### Decision 5: Retention and Cleanup Policies

**Chosen Option**: Hybrid: Automatic Defaults with Manual Overrides (Rank 1).

**Description**: Implement an automatic, non-blocking cleanup job that runs on server startup. It deletes checkpoints with no activity for a default period (e.g., 30 days). Additionally, provide CLI tools for manual cleanup (e.g., `workrail-mcp cleanup --older-than 7d`, `... --keep-last 5`).

**Refinements**:
- The default automatic cleanup policy will be based on **last activity date** (e.g., last load/update), not the creation date, to avoid deleting active long-running projects.

**Pros**:
- Prevents storage exhaustion by default; highly flexible for power users; clear and explicit manual control when needed; safe default behavior that protects active work.

**Cons**:
- Slightly more complex to implement both automatic and manual logic and to track activity timestamps.

**Rationale**: This provides a safety net against runaway storage growth while giving power users fine-grained control. Basing cleanup on last activity is a smarter default that protects ongoing work, directly addressing the analysis's concern in a robust and user-friendly way. 

### Decision 6: Checkpoint Triggering

**Chosen Option**: Hybrid: Automatic Phase-Based + Manual Override (Rank 1).

**Description**: The system automatically saves a checkpoint at the end of each major workflow "phase" (a logical unit of work defined in the workflow's metadata). Additionally, the agent can explicitly call `workflow_checkpoint_save` at any time to force a save at a critical moment.

**Pros**:
- Guarantees regular, logical save points automatically; provides agent flexibility for critical moments; creates meaningful, easy-to-understand checkpoints; best data durability.

**Cons**:
- Requires workflows to be structured with logical "phases" for the automatic trigger to be effective; slightly more complex implementation.

**Rationale**: This approach aligns checkpointing with the workflow's semantic structure, creating logical and useful save points. The manual override is a crucial escape hatch that provides the flexibility needed for complex, unpredictable AI-driven tasks, offering the best combination of reliability and intelligent control. 

### Decision 7: Classification Method

**Chosen Option**: Hybrid: Automatic Rules + Workflow Schema Hints (Rank 1).

**Description**: Use a primary system of automatic, pattern-based rules (e.g., regex on keys, content analysis). Augment this with optional, explicit hints that workflow authors can embed directly in their workflow schema (e.g., a `contextRules` block).

**Refinements**:
- We will consider **ML-Enhanced Classification** (using a small, local model) as a potential post-MVP enhancement to further improve classification accuracy.
- **Hybrid with Content Analysis**: Augment pattern-based rules with lightweight, pure-JS content heuristics (e.g., score based on text length, keyword density like "critical" or "temporary") applied as a secondary refinement pass. This improves accuracy for non-standard keys without adding dependencies.

**Pros**:
- Highly flexible and accurate; provides smart defaults while allowing for precise control; decouples classification logic from the agent's core task; makes workflows more self-documenting.

**Cons**:
- Requires a small extension to the workflow schema; slightly more complex for the MCP to parse both rules and hints.

**Rationale**: This creates a powerful, layered system. The automatic rules provide a solid baseline, and schema hints act as a clean, structured override mechanism. This makes the system both easy for simple workflows and powerful enough for complex ones, directly addressing the analysis's feedback on the potential brittleness of a purely rule-based approach. 

### Decision 8: Session Correlation and Discovery

**Chosen Option**: Phased Approach: Explicit Load (MVP) followed by Multi-Layered Discovery (Post-MVP).

**Description**:
- **MVP (Rank 4 for initial simplicity)**: The system will only support resuming a workflow via an exact `checkpointId` or `sessionId`. A `workflow_checkpoint_list` tool will be available for manual discovery by the agent.
- **Post-MVP (Rank 1 for user experience)**: We will implement a multi-layered discovery process. This will include an exact `sessionId` match, followed by indexed metadata search, with a semantic search fallback. Crucially, non-exact matches will require agent confirmation before loading to prevent errors.
- **Basic Keyword Search in MVP**: Enhance the MVP's `workflow_checkpoint_list` tool with simple keyword filtering (e.g., by tags, names, or partial metadata) using indexed SQLite queries, allowing more intuitive discovery without new dependencies.

**Pros**:
- **MVP**: Simplest implementation; zero risk of incorrect automatic resumption; provides a solid foundation.
- **Post-MVP**: Most reliable and safest option; combines automatic search with user control; excellent user experience.
- **Basic Keyword Search in MVP**: Improves MVP usability by reducing manual ID hunting; fast and efficient leveraging existing storage; zero additional deps or complexity.

**Cons**:
- **MVP**: Places the initial burden of discovery on the agent; less user-friendly.
- **Post-MVP**: More complex interaction flow to implement.

**Rationale**: This phased approach prioritizes simplicity and reliability for the initial release, directly addressing the core need for *any* resumption capability. It avoids the complexity and potential edge cases of automatic discovery in the MVP. The post-MVP plan then builds on this foundation to create a more sophisticated and user-friendly experience, aligning with our long-term goals while mitigating initial development risk. 

### Decision 9: Distribution Methods

**Chosen Option**: Unified Core with Platform-Specific Installers (Rank 1).

**Description**: Create a single, primary NPM package (`@workrail/mcp-server`) containing all core server logic. This package will be used directly by `npx`. An official `Dockerfile` in the same repository will use this NPM package as its foundation to build the image published to Docker Hub.

**Pros**:
- Single source of truth for all code, ensuring version parity between NPX and Docker.
- Easy to maintain and follows standard industry best practices for cross-platform tools.

**Cons**:
- Requires managing two publishing pipelines (one for NPM, one for Docker Hub).

**Rationale**: This is the most professional and maintainable approach. It establishes a single source of truth, minimizing code duplication and ensuring both NPX and Docker users receive the same functionality. It avoids forcing heavy dependencies (like Docker) on NPX users while providing a first-class, isolated environment for those who prefer Docker. 

### Decision 10: Dependencies Management

**Chosen Option**: Strict Version Pinning & Bundling (Rank 1).

**Description**: Pin the exact versions of all dependencies in `package.json` (e.g., `"better-sqlite3": "9.4.3"` instead of `"^9.4.3"`). Bundle all required JavaScript dependencies into a single file for distribution to optimize startup time and ensure consistency.

**Pros**:
- Maximum reliability and reproducibility; prevents unexpected breaking changes from dependencies; improves security by avoiding automatic updates from potentially compromised packages; faster startup.

**Cons**:
- Requires manual updates to dependencies, which can be tedious; may miss out on important bug fixes or security patches until a manual update is done.

**Rationale**: Reliability is paramount for a background server process. Strict pinning gives us a stable, predictable foundation and directly addresses the analysis's concern about managing dependency versions. The maintenance overhead is a worthwhile trade-off for this level of stability. 

### Decision 11: Testing Strategy

**Chosen Option**: Comprehensive Multi-Layered Testing (Rank 1).

**Description**: Implement a full testing suite, including:
- **Unit Tests**: For individual, pure functions (e.g., classification rules, compression helpers).
- **Integration Tests**: To verify interactions between components (e.g., writing to both SQLite and the filesystem).
- **End-to-End (E2E) Tests**: To simulate a full user journey (start, kill, and resume from checkpoint).

**Pros**:
- Maximum reliability; catches bugs at all levels (logic, integration, and UX); provides a safety net for future refactoring; builds high confidence in the feature's stability.

**Cons**:
- Most time-consuming to write and maintain the test suite.

**Rationale**: For a feature this critical to data integrity, a multi-layered testing strategy is non-negotiable. It is the only way to ensure every part of the system is working correctly and to earn user trust. This directly and thoroughly addresses the gap identified in the analysis. 

### Decision 12: User Configuration Overrides

**Chosen Option**: Unified Config File with CLI/Env Overrides (Rank 1).

**Description**: Provide a single, optional `config.json` file in the main data directory (e.g., `~/.workrail/config.json`). Settings in this file can be overridden by environment variables (e.g., `WORKRAIL_STORAGE_PATH`), which can in turn be overridden by CLI arguments (e.g., `--storage-path`), following a standard order of precedence.

**Pros**:
- Most flexible and powerful; supports persistence, scripting, and temporary overrides; follows well-established conventions.

**Cons**:
- Most complex to implement due to managing the precedence chain.

**Rationale**: This is the industry standard for flexible developer tools. It provides a clean separation of concerns: a config file for persistent settings, environment variables for automation, and CLI arguments for immediate changes. This layered approach supports every use case, from the default zero-config user to the advanced developer. 