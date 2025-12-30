import type { ResultAsync } from 'neverthrow';
import type { WorkflowHash } from '../durable-core/ids/index.js';
import type { CompiledWorkflowSnapshot } from '../durable-core/schemas/compiled-workflow/index.js';

export type PinnedWorkflowStoreError =
  | { readonly code: 'PINNED_WORKFLOW_IO_ERROR'; readonly message: string };

/**
 * Port: Pinned compiled workflow store (determinism anchor).
 *
 * Purpose:
 * - Store compiled workflow snapshots by workflowHash (content-addressed identity)
 * - Enable deterministic execution even when source workflow changes
 * - Support export/import resumability by persisting pinned snapshots
 *
 * Locked invariants (docs/design/v2-core-design-locks.md Section 5):
 * - workflowHash = sha256(RFC 8785 JCS canonical bytes of compiled snapshot)
 * - Snapshots are immutable; pinned content must never be mutated in place
 * - Storage is durable across restarts (data/workflows/pinned/<hash>.json)
 *
 * Guarantees:
 * - get() returns null if not found
 * - put() is idempotent for the same hash (overwrites equivalent content)
 * - Stored snapshots are safe to re-load for later runs
 *
 * When to use:
 * - Pin at `start_workflow` time (or first execution) before any durable advance
 * - Retrieve at `continue_workflow` time for interpretation
 * - Export: include pinned snapshots in bundles
 *
 * Example:
 * ```typescript
 * await pinnedStore.put(workflowHash, compiled);
 * const pinned = await pinnedStore.get(workflowHash);
 * ```
 */
export interface PinnedWorkflowStorePortV2 {
  /**
   * Retrieve pinned compiled workflow by workflow hash.
   *
   * Returns snapshot if found, null otherwise.
   */
  get(workflowHash: WorkflowHash): ResultAsync<CompiledWorkflowSnapshot | null, PinnedWorkflowStoreError>;

  /**
   * Store pinned compiled workflow by workflow hash.
   *
   * Idempotent for the same hash.
   */
  put(workflowHash: WorkflowHash, compiled: CompiledWorkflowSnapshot): ResultAsync<void, PinnedWorkflowStoreError>;
}
