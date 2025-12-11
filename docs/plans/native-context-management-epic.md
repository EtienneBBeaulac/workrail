# Epic: Native Context Management for Workflows

**Status:** Not Started
**Owner:** TBD
**Related Document:** [Native Context Management Design Doc](../design/native-context-management-design.md)

## Summary

This epic covers the implementation of a native context management system for the WorkRail MCP server. The goal is to solve context window saturation in long-running workflows by providing automatic context persistence, intelligent compression, and
automatic session resumption, all while maintaining the server's stateless architecture.

## Phases & Tasks

This project will be broken down into four main phases, moving from core infrastructure to feature polish.

---

### Phase 1: Core Infrastructure (MVP)

**Goal:** Establish the foundational storage layers and the basic ability to save and load workflow checkpoints. This phase focuses on data integrity and core functionality.

- [ ] **Dependencies & Setup**
    - [ ] Add `better-sqlite3` dependency to `package.json`.
    - [ ] Configure `tsconfig.json` and build scripts to handle the new dependency.

- [ ] **Storage Layer**
    - [ ] **Implement SQLite Database Schema and Migrations**
        - Create `src/infrastructure/storage/migrations/001_initial_schema.sql` based on the ERD (data-model-erd.md) and provided SQL snapshot (e.g., tables for `sessions` and `checkpoint_metadata`, with indexes and triggers for `total_size_bytes`).
        - Implement a migration runner in `src/infrastructure/storage/sqlite-migrator.ts` using `better-sqlite3` to apply schemas on startup, checking `schema_version` table for applied versions.
        - Add error handling for migration failures (e.g., rollback and log).

    - [ ] **Implement Data Migration and Compatibility Logic**
        - Extend the migration runner to handle data transformations (e.g., if schema changes in future versions, add scripts to migrate existing rows, like updating tags from string to JSON).
        - Add a version check on server startup: Query `schema_version` and fail gracefully (e.g., log warning and suggest backup if incompatible).
        - Implement a basic import utility for legacy data (e.g., a CLI command `workrail import-legacy <path-to-CONTEXT.md>` that creates a checkpoint from manual files; mark as optional/post-MVP if not prioritized).
        - Test for backward compatibility (e.g., simulate upgrading from v0 to v1 and verify data integrity).

    - [ ] **Implement SqliteStorage Class**
        - In `src/infrastructure/storage/sqlite-storage.ts`, create the class with methods for CRUD (e.g., `createSession(id: string)`, `getLatestCheckpoint(sessionId: string)`).
        - Use prepared statements for queries to prevent SQL injection and ensure performance (e.g., indexed queries for `idx_checkpoints_session_created_desc`).
        - Implement transaction support (e.g., `beginTransaction()`, `commit()`) for atomic operations, per sequence diagrams.

    - [ ] **Implement ContextBlobStorage Class**
        - In `src/infrastructure/storage/context-blob-storage.ts`, add methods like `saveBlob(sessionId: string, checkpointId: string, blob: Buffer): string` (returns relative path).
        - Handle atomic writes (e.g., write to temp file, then rename) and directory structure (e.g., `contexts/{sessionId}/{checkpointId}.json.gz`).
        - Add methods for read/delete, with checksum validation (e.g., compute SHA-256 on save/read to detect corruption).

    - [ ] **Integration and Composition**
        - Create a facade class `HybridStorage` in `src/infrastructure/storage/hybrid-storage.ts` that composes `SqliteStorage` and `ContextBlobStorage` for unified access (e.g., `saveCheckpointMetadataAndBlob(metadata, blob)` in a transaction).
        - Inject into `ContextManagementService` via DI container (`src/container.ts`).

    - [ ] **Error Handling and Edge Cases**
        - Add custom errors (e.g., `StorageUnavailableError`) and retries for transient issues (e.g., disk full).
        - Handle platform-specific paths (e.g., use `path` module for cross-OS compatibility).

    - [ ] **Documentation and Hooks**
        - Add TSDoc for all methods.
        - Include extensibility hooks (e.g., abstract methods for alternative backends like in-memory for testing).

- [ ] **Core Tools API**
    - [ ] Implement the `workflow_checkpoint_save` tool. In this phase, it will save the full context without compression.
    - [ ] Implement the `workflow_checkpoint_load` tool to restore context from a saved checkpoint.
    - [ ] Implement the `workflow_checkpoint_list` tool to list available checkpoints for a given session.

- [ ] **Integration**
    - [ ] Add new Tool definitions (e.g., `WORKFLOW_CHECKPOINT_SAVE_TOOL`) following the existing pattern in `src/mcp-server.ts` lines 28-306.
        - [ ] **Code Sketch: Tool Definition Example**
            ```typescript
            const WORKFLOW_CHECKPOINT_SAVE_TOOL: Tool = {
              name: "workflow_checkpoint_save",
              description: "Saves the current workflow state and context as a new checkpoint.",
              inputSchema: { /* schema from API doc */ }
            };
            ```
    - [ ] Add the new tools to the tools array in the `ListToolsRequestSchema` handler (around line 357).
        - [ ] **Code Sketch: Adding to List Handler**
            ```typescript
            server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
              tools: [
                // ... existing tools ...
                WORKFLOW_CHECKPOINT_SAVE_TOOL,
                WORKFLOW_CHECKPOINT_LOAD_TOOL,
                WORKFLOW_CHECKPOINT_LIST_TOOL,
                WORKFLOW_MARK_CRITICAL_TOOL
              ],
            }));
            ```
    - [ ] Add new case statements in the `CallToolRequestSchema` handler (around line 358-400) for each new tool, calling into ContextManagementService methods.
        - [ ] **Code Sketch: Call Handler Case Example**
            ```typescript
            case "workflow_checkpoint_save":
              if (!args?.['sessionId'] || !args?.['context']) {
                return { content: [{ type: "text", text: "Error: required params missing" }], isError: true };
              }
              return await workflowServer.saveCheckpoint(args as SaveCheckpointParams);
            ```
    - [ ] Implement the tool handler methods in the `WorkflowOrchestrationServer` class, injecting and using ContextManagementService.
        - [ ] **Code Sketch: Handler Method Example**
            ```typescript
            class WorkflowOrchestrationServer {
              // ...
              async saveCheckpoint(params: SaveCheckpointParams): Promise<CallToolResult> {
                try {
                  const result = await this.contextMgmtService.saveCheckpoint(params);
                  return { content: [{ type: "tool_result", result }] };
                } catch (error) {
                  return { content: [{ type: "text", text: error.message }], isError: true };
                }
              }
            }
            ```
    - [ ] Create the `ContextManagementService` class in `src/application/services/context-management-service.ts`.
    - [ ] Add the service to the dependency injection container in `src/container.ts` and inject into WorkflowOrchestrationServer if needed.
    - [ ] Implement basic session correlation logic (e.g., using sessionId from tool params).
    - [ ] Test integration with mock calls to verify tool availability and basic functionality.

- [ ] **Testing**
    - [ ] Write unit tests for `SqliteStorage` operations.
    - [ ] Write unit tests for `ContextBlobStorage` operations.
    - [ ] Write integration tests to verify the end-to-end `save` -> `list` -> `load` cycle.

---

### Phase 2: Compression & Classification

**Goal:** Introduce intelligence into the system by automatically classifying and compressing context to manage token budget and storage efficiently.

- [ ] **Classification Engine**
    - [ ] **Define Core Data Structures and Interfaces**
        - Create a new TypeScript file `src/domain/context-classification.ts` to define enums and interfaces for the four layers (e.g., `enum ContextLayer { CRITICAL, IMPORTANT, USEFUL, EPHEMERAL }`).
        - Define an interface for classified context (e.g., `ClassifiedContext` as a map of layers to key-value pairs from the original context object).
        - Define a config interface for classification rules (e.g., `ClassificationConfig` with arrays of regex patterns for each layer, plus heuristic weights like minLength for USEFUL).

    - [ ] **Implement Automatic Pattern-Based Classification**
        - In a new class `ClassificationEngine` (in `src/application/services/classification-engine.ts`), implement the core `classify(context: object): ClassifiedContext` method.
        - Use regex matching on context keys (e.g., match `/^user(Goal|Requirement)/` to CRITICAL, as per ADR 002 examples).
        - Add default patterns based on design doc (e.g., `/^timestamp|debug/` for EPHEMERAL).
        - Ensure the method iterates over all top-level keys in the context object and assigns them to the highest-matching layer (with a fallback to IMPORTANT if no match).

    - [ ] **Augment with Lightweight Content Heuristics**
        - Extend the `classify` method to apply secondary heuristics after pattern matching (e.g., if a value's length > 1000 chars and contains keywords like "analysis" or "findings", bump to IMPORTANT).
        - Use pure JS utilities (no external deps) for heuristics: e.g., string length checks, simple keyword density scoring (e.g., count occurrences of words like "critical" or "temporary").
        - Make heuristics configurable (e.g., via thresholds in the config) to allow tuning without code changes.

    - [ ] **Implement Workflow Schema Hints Integration**
        - Add logic to parse optional `contextRules` from the workflow schema (e.g., during workflow loading in `WorkflowService`).
        - If hints exist (e.g., `{ "critical": ["userGoalKey"] }`), merge them with automatic rules—hints take precedence.
        - Update `WorkflowService` to pass these hints to `ClassificationEngine` when preparing context for saving.

    - [ ] **Implement Agent Override Mechanism**
        - Integrate with the `workflow_mark_critical` tool: Add a method `markCritical(sessionId: string, contextKey: string)` that updates an in-memory or session-specific override map.
        - During classification, check for overrides and force the key to CRITICAL (preventing compression/dropping).
        - Ensure overrides persist across saves (e.g., store in session metadata in SQLite).

    - [ ] **Configuration Loading and Defaults**
        - Create a default `classification-config.json` file in `src/config/` with predefined patterns and heuristics (e.g., based on ADR 002 examples).
        - Implement config loading in `ClassificationEngine` constructor: Load from file, with overrides from env vars (e.g., `WORKRAIL_CLASSIFICATION_CONFIG=path/to/custom.json`) or the unified config system.
        - Add validation for the config (e.g., ensure regex patterns are valid using `new RegExp()` try-catch).

    - [ ] **Error Handling and Edge Cases**
        - Handle invalid contexts (e.g., non-object input throws `INVALID_INPUT` error).
        - Add logging for classification decisions (e.g., debug logs showing why a key was assigned to a layer).
        - Ensure nested objects are handled (e.g., flatten or recursively classify if needed, per design doc's "deep context" note).

    - [ ] **Integration with Checkpoint Save/Load**
        - Update `ContextManagementService.saveCheckpoint` to call `ClassificationEngine.classify` before compression.
        - On load, optionally re-classify if needed (e.g., for overrides applied post-save).
        - Tie into `ContextOptimizer` integration (e.g., classify before calling `prepareForPersistence`).

    - [ ] **Documentation and Post-MVP Hooks**
        - Add TSDoc comments to all methods/interfaces.
        - Include hooks for future enhancements (e.g., a pluggable `classifyWithML` method stub for local LLM integration, marked as post-MVP).

- [ ] **Compression Layer**
    - [ ] **Integrate Compression Library**
        - Use Node.js built-in `zlib` in `src/application/services/compression-service.ts` for gzip/deflate methods (e.g., `compress(data: object, level: number): Buffer`).
        - Add type-safe serialization (e.g., `JSON.stringify` with custom replacers for non-serializable data).

    - [ ] **Implement Layer-Specific Compression**
        - Create `compressClassified(classified: ClassifiedContext): CompressedContext` that applies strategies per layer (e.g., no compression for CRITICAL, aggressive gzip + summarization for USEFUL).
        - Use heuristics for summarization (e.g., truncate long strings in EPHEMERAL).

    - [ ] **Implement Progressive Compression**
        - Add a method `applyProgressive(checkpointAge: number, classified: ClassifiedContext)` that increases aggression for older data (e.g., summarize if >30 days, based on `created_at`).
        - Integrate with load/save flows in `ContextManagementService`.

    - [ ] **Decompression Logic**
        - Implement `decompress(blob: Buffer): object` with error handling for corrupted data (e.g., throw `CORRUPT_CHECKPOINT`).

    - [ ] **Integration and Testing Hooks**
        - Update `ContextBlobStorage` to call compression before save/decompression after read.
        - Add configurable levels (e.g., via env vars like `WORKRAIL_COMPRESSION_LEVEL=advanced`).

- [ ] **Enhanced Tools API**
    - [ ] Update `workflow_checkpoint_save` to use the classification and compression engines.
    - [ ] Implement the `workflow_context_compress` tool for manual compression triggers.
    - [ ] Implement the `workflow_context_prioritize` tool to re-organize context based on importance.
    - [ ] Implement the `workflow_mark_critical` tool to allow agent overrides.

- [ ] **Testing**
    - [ ] Write unit tests for the classification engine against a test suite of context objects.
    - [ ] Write unit tests to verify compression ratios and data integrity.
    - [ ] Update integration tests to ensure the end-to-end flow handles classification correctly.

---

### Phase 3: Developer & User Experience

**Goal:** Make the system reliable, resilient, and configurable for advanced users and developers.

- [ ] **Concurrency & Error Handling**
    - [ ] Implement pessimistic locking for write operations (`workflow_checkpoint_save`) to ensure data consistency with concurrent agents.
    - [ ] Implement the graceful degradation feature (fallback to in-memory mode if storage is inaccessible).
    - [ ] Implement the corruption recovery mechanism (rebuild index from files if DB is corrupt).

- [ ] **Configuration & Overrides**
    - [ ] Implement the unified configuration system (`config.json` with CLI/env overrides) for settings like storage paths, limits, etc.
    - [ ] Ensure the `npx @workrail/mcp-server` command respects the new configuration.

- [ ] **CLI Tooling**
    - [ ] Add a `workrail context list` command to view checkpoints.
    - [ ] Add a `workrail context inspect <id>` command to view checkpoint metadata.
    - [ ] Add a `workrail context prune <options>` command for manual cleanup.

- [ ] **Documentation**
    - [ ] Write user-facing documentation for the new features.
    - [ ] Create an initial `ADR` (Architectural Decision Record) for the choice of SQLite + Filesystem.

- [ ] **Testing**
    - [ ] Write E2E tests for session resumption after a simulated server crash.
    - [ ] Write integration tests for concurrent access to verify locking.
    - [ ] Write tests for all new CLI commands.

---

### Phase 4: Polish & Optimization

**Goal:** Harden the system by implementing security measures, enforcing quotas, and conducting performance tuning.

- [ ] **Security Hardening**
    - [ ] **Implement Input Validation and Sanitization**
        - In `ContextManagementService`, add validators for all tool inputs (e.g., use Joi or Zod schemas matching API doc, reject invalid IDs with `INVALID_INPUT`).
        - Sanitize paths to prevent traversal (e.g., use `path.normalize` and checks in `ContextBlobStorage`).

    - [ ] **Implement Opt-In Encryption**
        - Add dependency `keytar` (or similar) for OS keychain access.
        - Create `EncryptionService` in `src/application/services/encryption-service.ts` with `encrypt/decrypt` methods; generate/store key if `WORKRAIL_ENCRYPTION=enabled`.
        - Integrate transparently in `ContextBlobStorage` (e.g., encrypt before gzip on save).

    - [ ] **Implement Secure File Permissions and Isolation**
        - Use `fs.chmod` to set 0600 on files/directories on save.
        - Ensure user-specific paths (e.g., via `os.homedir()` for multi-user systems).

    - [ ] **Audit Logging and PII Detection**
        - Add logging for sensitive ops (e.g., saves/loads) using existing utils.
        - Implement basic PII scanning (e.g., regex for API keys) with warnings.

- [ ] **Storage Management**
    - [ ] Implement the storage quota and limits system (global and per-session).
    - [ ] Implement the automatic cleanup policies (e.g., on startup or when nearing capacity).

- [ ] **Monitoring and Observability**
    - Integrate a lightweight logging/metrics library (e.g., built-in or `winston` if not already used) to track key events (e.g., checkpoint save time, compression ratio, quota usage).
    - Add endpoints or CLI commands for stats (e.g., `workrail stats` to show total storage, average context size, and recent errors).
    - Implement alerts (e.g., log warnings if context size >80% of budget or disk usage nears limits; optional email/Slack hooks via config).
    - Include hooks for external monitoring (e.g., export to Prometheus format for advanced users).
    - Test with simulated loads (e.g., assert logs capture failures like `STORAGE_QUOTA_EXCEEDED`).

- [ ] **Performance & Integration**
    - [ ] Benchmark the system against the defined Performance SLAs and perform optimizations.
    - [ ] Implement the detailed integration with `ContextOptimizer`:
        - [ ] Add `prepareForPersistence(context: EnhancedContext): CompressibleContext` method to `src/application/services/context-optimizer.ts`, which optimizes and serializes the live context for storage.
        - [ ] Add `restoreFromPersistence(compressed: CompressedContext): EnhancedContext` method to rehydrate stored context back into the optimizer's format.
        - [ ] Update `ContextManagementService` saveCheckpoint and loadCheckpoint methods to call these new functions during persistence flows.
        - [ ] Add unit tests for the new methods and integration tests for the full save-optimize-load cycle.
    - [ ] **Note**: Current `ContextOptimizer` is minimal (only has `createEnhancedContext`, `mergeLoopState`, `getProperty` methods), so the integration may require expanding its interface significantly.
    - [ ] Ensure compatibility with existing features like loop handling in ContextOptimizer.

- [ ] **Documentation**
    - [ ] Finalize all public API documentation (TSDoc).
    - [ ] Write operations runbook for troubleshooting.
    - [ ] Complete any additional ADRs.

- [ ] **Testing**
    - [ ] Implement automated performance benchmark tests.
    - [ ] Add tests for security features (e.g., ensuring an invalid ID is rejected).
    - [ ] Add tests for quota enforcement (e.g., ensuring a save fails when storage is full).

## Dependencies, Risks, and Mitigation

- [ ] **Manage External Dependencies**
    - List and pin versions (e.g., `better-sqlite3@^9.4.3`, `keytar@^7.9.0`) in `package.json` with rationale (e.g., for SQLite and keychain).
    - Add setup scripts (e.g., post-install to verify native builds for `better-sqlite3` on different OSes).

- [ ] **Identify and Mitigate Risks**
    - Document key risks (e.g., disk full → add auto-cleanup triggers; OS keychain failures → fallback to unencrypted with warnings).
    - Plan cross-platform testing (e.g., CI jobs for macOS/Windows/Linux to verify encryption and paths).
    - Create a rollback plan (e.g., backup script before migrations, using the design's export format for data portability). 