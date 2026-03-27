import type { ResultAsync } from 'neverthrow';

export type RememberedRootsStoreError =
  | {
      readonly code: 'REMEMBERED_ROOTS_BUSY';
      readonly message: string;
      readonly retry: { readonly kind: 'retryable_after_ms'; readonly afterMs: number };
      readonly lockPath: string;
    }
  | { readonly code: 'REMEMBERED_ROOTS_IO_ERROR'; readonly message: string }
  | { readonly code: 'REMEMBERED_ROOTS_CORRUPTION'; readonly message: string };

export interface RememberedRootRecordV2 {
  readonly path: string;
  readonly addedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly source: 'explicit_workspace_path';
}

export interface RememberedRootsStorePortV2 {
  /**
   * Return all remembered workspace roots in deterministic order.
   *
   * Order is insertion order with de-duplication applied.
   */
  listRoots(): ResultAsync<readonly string[], RememberedRootsStoreError>;

  /**
   * Return full remembered-root records for inspection and future source visibility work.
   */
  listRootRecords(): ResultAsync<readonly RememberedRootRecordV2[], RememberedRootsStoreError>;

  /**
   * Persist a workspace root if not already present.
   *
   * Callers should pass explicit workspace identity only.
   */
  rememberRoot(rootPath: string): ResultAsync<void, RememberedRootsStoreError>;
}
