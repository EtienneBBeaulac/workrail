import { z } from 'zod';
import type { ToolAnnotations } from '../tool-factory.js';

export const V2ListWorkflowsInput = z.object({});
export type V2ListWorkflowsInput = z.infer<typeof V2ListWorkflowsInput>;

export const V2InspectWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('The workflow ID to inspect'),
  mode: z.enum(['metadata', 'preview']).default('preview').describe('Detail level: metadata (name and description only) or preview (full step-by-step breakdown, default)'),
});
export type V2InspectWorkflowInput = z.infer<typeof V2InspectWorkflowInput>;

export const V2StartWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('The workflow ID to start'),
  context: z.record(z.unknown()).optional().describe('External facts influencing execution (ticketId, branch, constraints). Pass once at start to establish baseline. WorkRail auto-loads context on subsequent continue_workflow calls. Only pass context again if facts have CHANGED (e.g., user provided new information). Do NOT re-pass unchanged values.'),
});
export type V2StartWorkflowInput = z.infer<typeof V2StartWorkflowInput>;

export const V2ContinueWorkflowInput = z.object({
  intent: z.enum(['advance', 'rehydrate']).describe(
    'What you want to do. ' +
    '"advance": I completed the current step — requires ackToken. ' +
    '"rehydrate": Remind me what the current step is (state recovery after rewind/lost context) — do NOT include ackToken or output.'
  ),
  stateToken: z.string().min(1).describe('Your session handle from start_workflow or previous continue_workflow. Pass this in EVERY continue_workflow call to identify your session. Round-trip exactly as received — never decode, inspect, or modify it.'),
  ackToken: z.string().min(1).optional().describe('Your step completion receipt. Required when intent is "advance". Must be omitted when intent is "rehydrate".'),
  context: z.record(z.unknown()).optional().describe('External facts (only if CHANGED since last call). Omit this entirely if no facts changed. WorkRail auto-merges with previous context. Example: if context={branch:"main"} at start, do NOT re-pass it unless branch changed. Pass only NEW or OVERRIDDEN values.'),
  output: z
    .object({
      notesMarkdown: z.string().min(1).optional().describe('Summary of work completed in THIS step only — fresh and specific to this step. Do NOT append previous step notes. WorkRail concatenates notes across steps automatically. WRONG: "Phase 0: planning. Phase 1: implemented." RIGHT: "Implemented OAuth2 with 3 endpoints; added token validation middleware." Aim for ≤10 lines.'),
      artifacts: z.array(z.unknown()).optional().describe('Optional structured artifacts (schema is workflow/contract-defined)'),
    })
    .optional()
    .describe('Durable output to attach to the current node. Only valid when intent is "advance".'),
}).strict().superRefine((data, ctx) => {
  if (data.intent === 'advance' && !data.ackToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ackToken'],
      message:
        'intent is "advance" but ackToken is missing. ' +
        'To advance to the next step, include the ackToken from the previous start_workflow or continue_workflow response. ' +
        'If you don\'t have an ackToken, set intent to "rehydrate" to recover the current step.',
    });
  }
  if (data.intent === 'rehydrate' && data.ackToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ackToken'],
      message:
        'intent is "rehydrate" but ackToken was provided. ' +
        'Rehydration recovers the current step without advancing — it does not accept ackToken. ' +
        'To advance, set intent to "advance". To rehydrate, remove ackToken.',
    });
  }
  if (data.intent === 'rehydrate' && data.output) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['output'],
      message:
        'intent is "rehydrate" but output was provided. ' +
        'Rehydration is read-only state recovery — it does not accept output. ' +
        'To submit output and advance, set intent to "advance" and include ackToken.',
    });
  }
});
export type V2ContinueWorkflowInput = z.infer<typeof V2ContinueWorkflowInput>;

export const V2CheckpointWorkflowInput = z.object({
  checkpointToken: z.string().min(1).describe(
    'The checkpoint token from the most recent start_workflow or continue_workflow response. ' +
    'Creates a checkpoint on the current step without advancing. Idempotent — calling with the same token is safe.'
  ),
}).strict();
export type V2CheckpointWorkflowInput = z.infer<typeof V2CheckpointWorkflowInput>;

export const V2_TOOL_TITLES = {
  list_workflows: 'List Workflows (v2)',
  inspect_workflow: 'Inspect Workflow (v2)',
  start_workflow: 'Start Workflow (v2)',
  continue_workflow: 'Continue Workflow (v2)',
  checkpoint_workflow: 'Checkpoint Workflow (v2)',
} as const;

export const V2_TOOL_ANNOTATIONS: Readonly<Record<keyof typeof V2_TOOL_TITLES, ToolAnnotations>> = {
  list_workflows: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inspect_workflow: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  start_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  continue_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  checkpoint_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
} as const;
