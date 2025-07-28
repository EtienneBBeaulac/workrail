# Epic: Native Context Management for Workflows

**Status:** Not Started
**Owner:** TBD
**Related Document:** [Native Context Management Design Doc](../design/native-context-management-design.md)

## Summary

This epic covers the implementation of a native context management system for the WorkRail MCP server. The goal is to solve context window saturation in long-running workflows by providing automatic context persistence, intelligent compression, and seamless session resumption, all while maintaining the server's stateless architecture.

## Phases & Tasks

This project will be broken down into four main phases, moving from core infrastructure to feature polish.

---

### Phase 1: Core Infrastructure (MVP)

**Goal:** Establish the foundational storage layers and the basic ability to save and load workflow checkpoints. This phase focuses on data integrity and core functionality.

- [ ] **Dependencies & Setup**
    - [ ] Add `better-sqlite3` dependency to `package.json`.
    - [ ] Configure `tsconfig.json` and build scripts to handle the new dependency.

- [ ] **Storage Layer**
    - [ ] Design and implement the initial SQLite database schema for session and checkpoint metadata.
    - [ ] Create a `migrations` directory and a script for applying the initial schema.
    - [ ] Implement a new `SqliteStorage` class to handle all database interactions (CRUD for sessions, checkpoints).
    - [ ] Implement a `ContextBlobStorage` class for writing/reading/deleting compressed context blobs to the filesystem.

- [ ] **Core Tools API**
    - [ ] Implement the `workflow_checkpoint_save` tool. In this phase, it will save the full context without compression.
    - [ ] Implement the `workflow_checkpoint_load` tool to restore context from a saved checkpoint.
    - [ ] Implement the `workflow_checkpoint_list` tool to list available checkpoints for a given session.

- [ ] **Integration**
    - [ ] Integrate the new tools into `mcp-server.ts`, exposing them to the agent.
    - [ ] Implement the basic session correlation logic (e.g., using a `sessionId` passed in the context).

- [ ] **Testing**
    - [ ] Write unit tests for `SqliteStorage` operations.
    - [ ] Write unit tests for `ContextBlobStorage` operations.
    - [ ] Write integration tests to verify the end-to-end `save` -> `list` -> `load` cycle.

---

### Phase 2: Compression & Classification

**Goal:** Introduce intelligence into the system by automatically classifying and compressing context to manage token budget and storage efficiently.

- [ ] **Classification Engine**
    - [ ] Implement the four-layer context classification logic (CRITICAL, IMPORTANT, USEFUL, EPHEMERAL) based on key patterns.
    - [ ] Create a configuration file for classification patterns to allow for future customization.

- [ ] **Compression Layer**
    - [ ] Integrate a standard compression library (e.g., built-in `zlib` for `gzip`).
    - [ ] Apply compression in `ContextBlobStorage` before writing to disk.
    - [ ] Apply decompression after reading from disk.
    - [ ] Implement the progressive compression strategy (e.g., older checkpoints can be summarized or more aggressively compressed).

- [ ] **Enhanced Tools API**
    - [ ] Update `workflow_checkpoint_save` to use the classification and compression engines.
    - [ ] Implement the `workflow_context_compress` tool for manual compression triggers.
    - [ ] Implement the `workflow_context_prioritize` tool to re-organize context based on importance.
    - [ ] Implement the `workflow_mark_critical` tool to allow agent overrides.

- [ ] **Testing**
    - [ ] Write unit tests for the classification engine against a test suite of context objects.
    - [ ] Write unit tests to verify compression ratios and data integrity.
    - [ ] Update integration tests to ensure the end-to-end flow handles compression correctly.

---

### Phase 3: Developer & User Experience

**Goal:** Make the system robust, resilient, and configurable for advanced users and developers.

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
    - [ ] Implement all input validation and sanitization as defined in the design doc.
    - [ ] Implement optional opt-in encryption using the OS keychain.
    - [ ] Implement secure file permissions and data isolation.

- [ ] **Storage Management**
    - [ ] Implement the storage quota and limits system (global and per-session).
    - [ ] Implement the automatic cleanup policies (e.g., on startup or when nearing capacity).

- [ ] **Performance & Integration**
    - [ ] Benchmark the system against the defined Performance SLAs and perform optimizations.
    - [ ] Implement the detailed integration with `ContextOptimizer` (`prepareForPersistence`, `restoreFromPersistence`).

- [ ] **Documentation**
    - [ ] Finalize all public API documentation (TSDoc).
    - [ ] Write operations runbook for troubleshooting.
    - [ ] Complete any additional ADRs.

- [ ] **Testing**
    - [ ] Implement automated performance benchmark tests.
    - [ ] Add tests for security features (e.g., ensuring an invalid ID is rejected).
    - [ ] Add tests for quota enforcement (e.g., ensuring a save fails when storage is full). 