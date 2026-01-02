import { z } from 'zod';
import type { ToolAnnotations } from '../tool-factory.js';

export const V2ListWorkflowsInput = z.object({});
export type V2ListWorkflowsInput = z.infer<typeof V2ListWorkflowsInput>;

export const V2InspectWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('The workflow ID to inspect'),
  mode: z.enum(['metadata', 'preview']).default('preview').describe('Detail level'),
});
export type V2InspectWorkflowInput = z.infer<typeof V2InspectWorkflowInput>;

export const V2StartWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('The workflow ID to start'),
  context: z.record(z.unknown()).optional().describe('External context inputs (conditions, parameters). Do not include workflow progress state.'),
});
export type V2StartWorkflowInput = z.infer<typeof V2StartWorkflowInput>;

export const V2ContinueWorkflowInput = z.object({
  stateToken: z.string().min(1).describe('Opaque WorkRail-minted state token'),
  ackToken: z.string().min(1).optional().describe('Opaque WorkRail-minted ack token (omit for rehydrate-only)'),
  context: z.record(z.unknown()).optional().describe('External context inputs (conditions, parameters). Do not include workflow progress state.'),
  output: z
    .object({
      notesMarkdown: z.string().min(1).optional().describe('Durable recap notes (short; WorkRail may truncate deterministically)'),
      artifacts: z.array(z.unknown()).optional().describe('Optional structured artifacts (schema is workflow/contract-defined)'),
    })
    .optional()
    .describe('Optional durable output to attach to the current node'),
});
export type V2ContinueWorkflowInput = z.infer<typeof V2ContinueWorkflowInput>;

export const V2_TOOL_TITLES = {
  list_workflows: 'List Workflows (v2)',
  inspect_workflow: 'Inspect Workflow (v2)',
  start_workflow: 'Start Workflow (v2)',
  continue_workflow: 'Continue Workflow (v2)',
} as const;

export const V2_TOOL_ANNOTATIONS: Readonly<Record<keyof typeof V2_TOOL_TITLES, ToolAnnotations>> = {
  list_workflows: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inspect_workflow: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  start_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  continue_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
} as const;
