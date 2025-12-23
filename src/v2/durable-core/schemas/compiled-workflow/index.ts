import { z } from 'zod';

// Slice 1: minimal compiled snapshot shape used only for hashing + read-only inspection.
export const CompiledWorkflowSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  sourceKind: z.literal('v1_shim'),
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

export type CompiledWorkflowSnapshotV1 = z.infer<typeof CompiledWorkflowSnapshotV1Schema>;
