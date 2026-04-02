import type { ResultAsync } from 'neverthrow';

export type ManagedSourceStoreError =
  | {
      readonly code: 'MANAGED_SOURCE_BUSY';
      readonly message: string;
      readonly retry: { readonly kind: 'retryable_after_ms'; readonly afterMs: number };
      readonly lockPath: string;
    }
  | { readonly code: 'MANAGED_SOURCE_IO_ERROR'; readonly message: string }
  | { readonly code: 'MANAGED_SOURCE_CORRUPTION'; readonly message: string };

/**
 * A managed workflow source: an explicitly attached directory containing v2 workflow files.
 *
 * Distinct from remembered roots (workspace paths for auto-discovery). Managed sources are
 * directly attached by the user and always participate in the catalog as explicit entries.
 */
export interface ManagedSourceRecordV2 {
  /** Absolute, normalized filesystem path to the workflow directory. */
  readonly path: string;
  /** Epoch ms when the source was first attached. */
  readonly addedAtMs: number;
}

/**
 * Port: Managed workflow source store.
 *
 * Purpose:
 * - Persist user-attached workflow source directories
 * - Provide the persistence seam that Slice 3 (attach/enable) builds on
 * - Keep managed-source state separate from remembered roots (different intent)
 *
 * When to use:
 * - Use managed sources for directories explicitly named by the user (intentional attach)
 * - Use remembered roots for workspace paths discovered implicitly from tool invocations
 *
 * Guarantees:
 * - attach() is idempotent: duplicate paths are ignored (addedAtMs is not updated)
 * - detach() is idempotent: removing an absent path is a no-op
 * - list() returns paths in stable insertion order
 *
 * Storage: `~/.workrail/data/managed-sources/managed-sources.json`
 */
export interface ManagedSourceStorePortV2 {
  /**
   * Return all managed source records in stable insertion order.
   */
  list(): ResultAsync<readonly ManagedSourceRecordV2[], ManagedSourceStoreError>;

  /**
   * Attach a workflow directory as a managed source.
   *
   * Idempotent: if the path is already present, this is a no-op.
   */
  attach(path: string): ResultAsync<void, ManagedSourceStoreError>;

  /**
   * Detach a managed source by path.
   *
   * Idempotent: if the path is not present, this is a no-op.
   */
  detach(path: string): ResultAsync<void, ManagedSourceStoreError>;
}
