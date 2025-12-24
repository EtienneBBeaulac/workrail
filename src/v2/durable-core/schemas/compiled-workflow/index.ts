import { z } from 'zod';
import { JsonValueSchema } from '../../canonical/json-zod.js';

/**
 * Compiled workflow snapshot (schemaVersion 1).
 *
 * Lock: schemaVersion 1 is the canonical v2 pinned snapshot schema.
 * We use `sourceKind` to discriminate between:
 * - 'v1_preview': Slice 1 read-only preview (id/name/description/preview only; cannot be used for execution)
 * - 'v1_pinned': Slice 3+ full pinned v1 definition (executable; determinism anchor for v1-backed v2 execution)
 */
const CompiledWorkflowSnapshotV1PreviewSchema = z.object({
  schemaVersion: z.literal(1),
  sourceKind: z.literal('v1_preview'),
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  // Minimal preview to support inspect_workflow without implementing execution.
  preview: z.object({
    stepId: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
  }),
});

const CompiledWorkflowSnapshotV1PinnedSchema = z.object({
  schemaVersion: z.literal(1),
  sourceKind: z.literal('v1_pinned'),
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  // The full v1 workflow definition as JSON-safe data.
  // This is the determinism anchor for v1-backed v2 execution.
  definition: JsonValueSchema,
});

export const CompiledWorkflowSnapshotV1Schema = z.discriminatedUnion('sourceKind', [
  CompiledWorkflowSnapshotV1PreviewSchema,
  CompiledWorkflowSnapshotV1PinnedSchema,
]);

export type CompiledWorkflowSnapshotV1 = z.infer<typeof CompiledWorkflowSnapshotV1Schema>;

export const CompiledWorkflowSnapshotSchema = CompiledWorkflowSnapshotV1Schema;
export type CompiledWorkflowSnapshot = CompiledWorkflowSnapshotV1;
