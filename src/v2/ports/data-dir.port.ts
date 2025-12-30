/**
 * Port: WorkRail v2 data directory layout (canonical paths).
 *
 * Purpose:
 * - Provide canonical absolute paths for all v2 durable storage
 * - Centralize path construction (no hardcoded paths elsewhere)
 * - Support configurable data root (env var / platform defaults)
 *
 * Locked layout (docs/design/v2-core-design-locks.md Section 13):
 * - data/sessions/<sessionId>/events/*.jsonl
 * - data/sessions/<sessionId>/manifest.jsonl
 * - data/sessions/<sessionId>/lock
 * - data/snapshots/<snapshotRef>
 * - data/workflows/pinned/<workflowHash>.json
 * - data/keys/keyring.json
 *
 * Guarantees:
 * - All returned paths are absolute
 * - Callers never need to string-concatenate paths
 * - Paths are stable across restarts for the same root
 *
 * When to use:
 * - All storage adapters (session store, snapshot store, pinned workflows, keyring)
 * - Never hardcode paths outside this port
 *
 * Example:
 * ```typescript
 * const lockPath = dataDir.sessionLockPath(sessionId);
 * await fs.writeFile(lockPath, '...');
 * ```
 */
export interface DataDirPortV2 {
  /** Root directory for pinned compiled workflows. */
  pinnedWorkflowsDir(): string;
  /** Absolute path for pinned workflow file for given hash. */
  pinnedWorkflowPath(workflowHash: string): string;

  // Slice 3 prereq: snapshot CAS store
  /** Root directory for content-addressed snapshots. */
  snapshotsDir(): string;
  /** Absolute path for a snapshot object for given snapshotRef. */
  snapshotPath(snapshotRef: string): string;

  // Slice 3 prereq: token signing keyring
  /** Root directory for token signing keys. */
  keysDir(): string;
  /** Absolute path for keyring file. */
  keyringPath(): string;

  // Slice 2: session durable substrate
  /** Root directory for all sessions. */
  sessionsDir(): string;
  /** Root directory for a single session. */
  sessionDir(sessionId: string): string;
  /** Directory containing session event JSONL segments. */
  sessionEventsDir(sessionId: string): string;
  /** Absolute path to the session manifest JSONL file. */
  sessionManifestPath(sessionId: string): string;
  /** Absolute path to the session lock file. */
  sessionLockPath(sessionId: string): string;
}
