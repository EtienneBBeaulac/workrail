import type { ResultAsync } from 'neverthrow';
import { okAsync, errAsync } from 'neverthrow';
import type { SessionId, SnapshotRef, Sha256Digest } from '../durable-core/ids/index.js';
import type { SessionEventLogReadonlyStorePortV2, SessionEventLogStoreError } from '../ports/session-event-log-store.port.js';
import type { SnapshotStorePortV2, SnapshotStoreError } from '../ports/snapshot-store.port.js';
import type { PinnedWorkflowStorePortV2, PinnedWorkflowStoreError } from '../ports/pinned-workflow-store.port.js';
import type { ExportBundleV1 } from '../durable-core/schemas/export-bundle/index.js';
import type { ExecutionSnapshotFileV1 } from '../durable-core/schemas/execution-snapshot/index.js';
import type { WorkflowHash } from '../durable-core/ids/index.js';
import { buildExportBundle, type BundleBuilderError } from '../durable-core/domain/bundle-builder.js';
import { EVENT_KIND } from '../durable-core/constants.js';

// =============================================================================
// Types
// =============================================================================

export interface ExportSessionPorts {
  readonly sessionStore: SessionEventLogReadonlyStorePortV2;
  readonly snapshotStore: SnapshotStorePortV2;
  readonly pinnedWorkflowStore: PinnedWorkflowStorePortV2;
  readonly sha256: (bytes: Uint8Array) => Sha256Digest;
}

export interface ExportSessionArgs {
  readonly sessionId: SessionId;
  readonly bundleId: string;
  readonly producer: {
    readonly appVersion: string;
    readonly appliedConfigHash?: string;
  };
}

export type ExportSessionError =
  | { readonly code: 'EXPORT_SESSION_STORE_ERROR'; readonly message: string; readonly cause: SessionEventLogStoreError }
  | { readonly code: 'EXPORT_SNAPSHOT_STORE_ERROR'; readonly message: string; readonly cause: SnapshotStoreError }
  | { readonly code: 'EXPORT_PINNED_WORKFLOW_STORE_ERROR'; readonly message: string; readonly cause: PinnedWorkflowStoreError }
  | { readonly code: 'EXPORT_MISSING_SNAPSHOT'; readonly message: string; readonly snapshotRef: string }
  | { readonly code: 'EXPORT_MISSING_PINNED_WORKFLOW'; readonly message: string; readonly workflowHash: string }
  | { readonly code: 'EXPORT_BUILD_FAILED'; readonly message: string; readonly cause: BundleBuilderError };

// =============================================================================
// Use Case
// =============================================================================

/**
 * Export a session as a self-contained bundle.
 *
 * Orchestrates loading from stores and delegates to the pure bundle builder.
 * No durable writes — read-only operation.
 *
 * Lock: docs/design/v2-core-design-locks.md §1.3
 */
export function exportSession(
  args: ExportSessionArgs,
  ports: ExportSessionPorts
): ResultAsync<ExportBundleV1, ExportSessionError> {
  return ports.sessionStore
    .load(args.sessionId)
    .mapErr((cause): ExportSessionError => ({
      code: 'EXPORT_SESSION_STORE_ERROR',
      message: `Failed to load session ${args.sessionId}: ${cause.message}`,
      cause,
    }))
    .andThen((truth) => {
      // Extract all referenced snapshotRefs and workflowHashes from events
      const snapshotRefs = new Set<string>();
      const workflowHashes = new Set<string>();

      for (const event of truth.events) {
        const evt = event as unknown as { kind: string; data: Record<string, unknown> };
        if (evt.kind === EVENT_KIND.NODE_CREATED) {
          if (typeof evt.data.snapshotRef === 'string') snapshotRefs.add(evt.data.snapshotRef);
          if (typeof evt.data.workflowHash === 'string') workflowHashes.add(evt.data.workflowHash);
        }
        if (evt.kind === EVENT_KIND.RUN_STARTED && typeof evt.data.workflowHash === 'string') {
          workflowHashes.add(evt.data.workflowHash);
        }
      }

      // Load all snapshots
      const snapshotEntries = [...snapshotRefs].map((ref) =>
        ports.snapshotStore
          .getExecutionSnapshotV1(ref as SnapshotRef)
          .mapErr((cause): ExportSessionError => ({
            code: 'EXPORT_SNAPSHOT_STORE_ERROR',
            message: `Failed to load snapshot ${ref}: ${cause.message}`,
            cause,
          }))
          .andThen((snapshot) => {
            if (snapshot === null) {
              return errAsync<[string, ExecutionSnapshotFileV1], ExportSessionError>({
                code: 'EXPORT_MISSING_SNAPSHOT',
                message: `Snapshot not found: ${ref}`,
                snapshotRef: ref,
              });
            }
            return okAsync<[string, ExecutionSnapshotFileV1], ExportSessionError>([ref, snapshot]);
          })
      );

      // Load all pinned workflows
      const workflowEntries = [...workflowHashes].map((hash) =>
        ports.pinnedWorkflowStore
          .get(hash as WorkflowHash)
          .mapErr((cause): ExportSessionError => ({
            code: 'EXPORT_PINNED_WORKFLOW_STORE_ERROR',
            message: `Failed to load pinned workflow ${hash}: ${cause.message}`,
            cause,
          }))
          .andThen((compiled) => {
            if (compiled === null) {
              return errAsync<[string, unknown], ExportSessionError>({
                code: 'EXPORT_MISSING_PINNED_WORKFLOW',
                message: `Pinned workflow not found: ${hash}`,
                workflowHash: hash,
              });
            }
            return okAsync<[string, unknown], ExportSessionError>([hash, compiled]);
          })
      );

      // Resolve all in parallel, then build
      const allSnapshots = snapshotEntries.length > 0
        ? snapshotEntries.reduce((acc, next) =>
            acc.andThen((list) => next.map((entry) => [...list, entry])),
          okAsync<[string, ExecutionSnapshotFileV1][], ExportSessionError>([]))
        : okAsync<[string, ExecutionSnapshotFileV1][], ExportSessionError>([]);

      const allWorkflows = workflowEntries.length > 0
        ? workflowEntries.reduce((acc, next) =>
            acc.andThen((list) => next.map((entry) => [...list, entry])),
          okAsync<[string, unknown][], ExportSessionError>([]))
        : okAsync<[string, unknown][], ExportSessionError>([]);

      return allSnapshots.andThen((snapshotPairs) =>
        allWorkflows.andThen((workflowPairs) => {
          const snapshots = new Map(snapshotPairs);
          const pinnedWorkflows = new Map(workflowPairs);

          const buildResult = buildExportBundle({
            bundleId: args.bundleId,
            sessionId: args.sessionId,
            events: truth.events,
            manifest: truth.manifest,
            snapshots,
            pinnedWorkflows,
            producer: args.producer,
            sha256: ports.sha256,
          });

          if (buildResult.isErr()) {
            return errAsync<ExportBundleV1, ExportSessionError>({
              code: 'EXPORT_BUILD_FAILED',
              message: `Bundle build failed: ${buildResult.error.message}`,
              cause: buildResult.error,
            });
          }

          return okAsync<ExportBundleV1, ExportSessionError>(buildResult.value);
        })
      );
    });
}
