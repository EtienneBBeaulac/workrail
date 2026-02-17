import type { ResultAsync } from 'neverthrow';
import { okAsync, errAsync } from 'neverthrow';
import type { Sha256Digest } from '../durable-core/ids/index.js';
import { asSha256Digest, asWorkflowHash } from '../durable-core/ids/index.js';
import type { SnapshotStorePortV2, SnapshotStoreError } from '../ports/snapshot-store.port.js';
import type { PinnedWorkflowStorePortV2, PinnedWorkflowStoreError } from '../ports/pinned-workflow-store.port.js';
import type { BundleImportError, ExportBundleV1 } from '../durable-core/schemas/export-bundle/index.js';
import type { CompiledWorkflowSnapshot } from '../durable-core/schemas/compiled-workflow/index.js';
import { ExecutionSnapshotFileV1Schema } from '../durable-core/schemas/execution-snapshot/index.js';
import { validateBundle } from '../durable-core/domain/bundle-validator.js';

// =============================================================================
// Types
// =============================================================================

export interface ImportSessionPorts {
  readonly snapshotStore: SnapshotStorePortV2;
  readonly pinnedWorkflowStore: PinnedWorkflowStorePortV2;
  /** Generate a new unique session ID for the imported session. */
  readonly generateSessionId: () => string;
  readonly sha256: (bytes: Uint8Array) => Sha256Digest;
}

export interface ImportResult {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly snapshotCount: number;
  readonly pinnedWorkflowCount: number;
  /** The validated bundle — caller can persist events from bundle.session.events. */
  readonly validatedBundle: ExportBundleV1;
}

export type ImportSessionError =
  | BundleImportError
  | { readonly code: 'IMPORT_SNAPSHOT_STORE_ERROR'; readonly message: string; readonly retry: 'no'; readonly cause: SnapshotStoreError }
  | { readonly code: 'IMPORT_PINNED_WORKFLOW_STORE_ERROR'; readonly message: string; readonly retry: 'no'; readonly cause: PinnedWorkflowStoreError }
  | { readonly code: 'IMPORT_SNAPSHOT_PARSE_ERROR'; readonly message: string; readonly retry: 'no' };

// =============================================================================
// Use Case
// =============================================================================

/**
 * Import a bundle as a new session.
 *
 * 1. Validates the raw bundle (pure, no I/O)
 * 2. Generates a new session ID (import-as-new policy)
 * 3. Stores pinned workflows (idempotent)
 * 4. Stores snapshots (idempotent)
 * 5. Returns the validated session contents for the caller to persist
 *
 * Note: This use case does NOT write session events to the session store.
 * The caller (Console) is responsible for persisting events, because event
 * persistence requires a session gate/witness flow that is Console-specific.
 * This keeps the use case focused on validation + reference storage.
 *
 * Lock: bundle-import-as-new, bundle-import-validates-first
 */
export function importSession(
  raw: unknown,
  ports: ImportSessionPorts
): ResultAsync<ImportResult, ImportSessionError> {
  // Phase 1-4: Pure validation (no I/O)
  const validationResult = validateBundle(raw, ports.sha256);
  if (validationResult.isErr()) {
    return errAsync(validationResult.error);
  }
  const bundle = validationResult.value;

  // Generate new session ID (import-as-new policy)
  const newSessionId = ports.generateSessionId();

  // Store pinned workflows (idempotent)
  const workflowKeys = Object.keys(bundle.session.pinnedWorkflows);
  const storeWorkflows = workflowKeys.length > 0
    ? workflowKeys.reduce<ResultAsync<void, ImportSessionError>>(
        (chain, hash) =>
          chain.andThen(() =>
            ports.pinnedWorkflowStore
              .put(
                asWorkflowHash(asSha256Digest(hash)),
                bundle.session.pinnedWorkflows[hash] as CompiledWorkflowSnapshot
              )
              .mapErr((cause): ImportSessionError => ({
                code: 'IMPORT_PINNED_WORKFLOW_STORE_ERROR',
                message: `Failed to store pinned workflow ${hash}: ${cause.message}`,
                retry: 'no',
                cause,
              }))
          ),
        okAsync(undefined)
      )
    : okAsync<void, ImportSessionError>(undefined);

  // Store snapshots (idempotent)
  const snapshotKeys = Object.keys(bundle.session.snapshots);
  const storeSnapshots = snapshotKeys.length > 0
    ? snapshotKeys.reduce<ResultAsync<void, ImportSessionError>>(
        (chain, ref) =>
          chain.andThen(() => {
            const rawSnapshot = bundle.session.snapshots[ref];
            const parsed = ExecutionSnapshotFileV1Schema.safeParse(rawSnapshot);
            if (!parsed.success) {
              return errAsync<void, ImportSessionError>({
                code: 'IMPORT_SNAPSHOT_PARSE_ERROR',
                message: `Snapshot ${ref} failed schema validation: ${parsed.error.issues.map(i => i.message).join('; ')}`,
                retry: 'no',
              });
            }
            return ports.snapshotStore
              .putExecutionSnapshotV1(parsed.data)
              .mapErr((cause): ImportSessionError => ({
                code: 'IMPORT_SNAPSHOT_STORE_ERROR',
                message: `Failed to store snapshot ${ref}: ${cause.message}`,
                retry: 'no',
                cause,
              }));
          }),
        okAsync(undefined)
      )
    : okAsync<void, ImportSessionError>(undefined);

  return storeWorkflows
    .andThen(() => storeSnapshots)
    .map(() => ({
      sessionId: newSessionId,
      eventCount: bundle.session.events.length,
      snapshotCount: snapshotKeys.length,
      pinnedWorkflowCount: workflowKeys.length,
      validatedBundle: bundle,
    }));
}
