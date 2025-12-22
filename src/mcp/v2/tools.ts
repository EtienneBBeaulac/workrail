import { z } from 'zod';
import type { ToolAnnotations } from '../tool-factory.js';

export const V2ListWorkflowsInput = z.object({});
export type V2ListWorkflowsInput = z.infer<typeof V2ListWorkflowsInput>;

export const V2InspectWorkflowInput = z.object({
  workflowId: z.string().min(1).describe('The workflow ID to inspect'),
  mode: z.enum(['metadata', 'preview']).default('preview').describe('Detail level'),
});
export type V2InspectWorkflowInput = z.infer<typeof V2InspectWorkflowInput>;

export const V2_TOOL_TITLES = {
  list_workflows: 'List Workflows (v2)',
  inspect_workflow: 'Inspect Workflow (v2)',
} as const;

export const V2_TOOL_ANNOTATIONS: Readonly<Record<keyof typeof V2_TOOL_TITLES, ToolAnnotations>> = {
  list_workflows: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inspect_workflow: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
} as const;
