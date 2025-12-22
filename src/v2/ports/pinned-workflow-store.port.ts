import type { ResultAsync } from 'neverthrow';
import type { WorkflowHash } from '../durable-core/ids/index.js';
import type { CompiledWorkflowSnapshotV1 } from '../durable-core/schemas/compiled-workflow/index.js';

export type PinnedWorkflowStoreError =
  | { readonly code: 'PINNED_WORKFLOW_IO_ERROR'; readonly message: string };

export interface PinnedWorkflowStorePortV2 {
  get(workflowHash: WorkflowHash): ResultAsync<CompiledWorkflowSnapshotV1 | null, PinnedWorkflowStoreError>;
  put(workflowHash: WorkflowHash, compiled: CompiledWorkflowSnapshotV1): ResultAsync<void, PinnedWorkflowStoreError>;
}
