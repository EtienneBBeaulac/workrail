/**
 * In-memory fake for pinned workflow store.
 *
 * Implements invariants:
 * - Workflows are stored by workflowHash (content-addressed)
 * - put() is idempotent (same hash → same snapshot)
 * - get() returns null if not found (not an error)
 *
 * @enforces workflow-hash-deterministic
 * @enforces pinned-workflow-immutable
 */

import { okAsync, type ResultAsync } from 'neverthrow';
import type {
  PinnedWorkflowStorePortV2,
  PinnedWorkflowStoreError,
} from '../../../src/v2/ports/pinned-workflow-store.port.js';
import type { WorkflowHash } from '../../../src/v2/durable-core/ids/index.js';
import type { CompiledWorkflowSnapshot } from '../../../src/v2/durable-core/schemas/compiled-workflow/index.js';

/**
 * In-memory fake pinned workflow store.
 *
 * Behavior:
 * - Workflows are stored by workflowHash (deterministic content address)
 * - get() returns null if not found
 * - put() is idempotent for same hash
 */
export class InMemoryPinnedWorkflowStore implements PinnedWorkflowStorePortV2 {
  private store = new Map<string, CompiledWorkflowSnapshot>();

  get(workflowHash: WorkflowHash): ResultAsync<CompiledWorkflowSnapshot | null, PinnedWorkflowStoreError> {
    const snapshot = this.store.get(String(workflowHash));
    return okAsync(snapshot ?? null);
  }

  put(workflowHash: WorkflowHash, compiled: CompiledWorkflowSnapshot): ResultAsync<void, PinnedWorkflowStoreError> {
    // Idempotent: store by hash
    this.store.set(String(workflowHash), compiled);
    return okAsync(void 0);
  }

  list(): ResultAsync<readonly WorkflowHash[], PinnedWorkflowStoreError> {
    return okAsync([...this.store.keys()] as WorkflowHash[]);
  }

  prune(_olderThanMs: number): ResultAsync<number, PinnedWorkflowStoreError> {
    // No-op in tests -- GC policy not exercised here.
    return okAsync(0);
  }
}
