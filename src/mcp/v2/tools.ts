import { z } from 'zod';
import type { ToolAnnotations } from '../tool-factory.js';
import {
  CONTINUE_WORKFLOW_PROTOCOL,
  findAliasFieldConflicts,
  normalizeAliasedFields,
} from '../workflow-protocol-contracts.js';

const workspacePathField = z.string()
  .refine((p) => p.startsWith('/'), 'workspacePath must be an absolute path (starting with /)')
  .optional()
  .describe('Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). Used to resolve project-scoped workflow variants against the correct workspace. If omitted, WorkRail uses MCP roots when available, then falls back to the server process directory.');

export const V2ListWorkflowsInput = z.object({
  workspacePath: workspacePathField,
});
export type V2ListWorkflowsInput = z.infer<typeof V2ListWorkflowsInput>;

export const V2InspectWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('The workflow ID to inspect'),
  mode: z.enum(['metadata', 'preview']).default('preview').describe('Detail level: metadata (name and description only) or preview (full step-by-step breakdown, default)'),
  workspacePath: workspacePathField,
});
export type V2InspectWorkflowInput = z.infer<typeof V2InspectWorkflowInput>;

export const V2StartWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('The workflow ID to start'),
  workspacePath: workspacePathField.describe('Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). Used to resolve the correct project-scoped workflow variant and to anchor this session to your workspace for future resume_session discovery. Pass this on every start_workflow call. If omitted, WorkRail uses MCP roots when available, then falls back to the server process directory.'),
});
export type V2StartWorkflowInput = z.infer<typeof V2StartWorkflowInput>;

/**
 * Canonical shape schema for continue_workflow input (introspection contract).
 *
 * This is the single source of truth for field names, types, and descriptions.
 * The validation schema (V2ContinueWorkflowInput) derives from this via transforms.
 *
 * Introspection functions (extractExpectedKeys, generateTemplate, patchTemplateForFailedOptionals)
 * read THIS schema, not the wrapped validation schema.
 *
 * @canonical
 */
export const V2ContinueWorkflowInputShape = z.object({
  workspacePath: workspacePathField,
  continueToken: z.string().min(1).describe(
    'The token for your next continue_workflow call. Two valid token kinds: ' +
    '(1) A continueToken (ct_...) from start_workflow or a previous continue_workflow — carries session identity AND advance authority. ' +
    '(2) A resumeToken (st_...) from resume_session or checkpoint_workflow — carries session identity only; valid for intent: "rehydrate", not "advance". ' +
    'Round-trip exactly as received — never decode, inspect, or modify it.'
  ),
  intent: z.enum(['advance', 'rehydrate']).optional().describe(
    'What you want to do. Auto-inferred if omitted: ' +
    'output present → "advance", output absent → "rehydrate". ' +
    '"advance": I completed the current step. ' +
    '"rehydrate": Remind me what the current step is (state recovery after rewind/lost context) — do NOT include output.'
  ),
  context: z.record(z.unknown()).optional().describe('External facts (only if CHANGED since last call). Omit this entirely if no facts changed. WorkRail auto-merges with previous context. Example: if context={branch:"main"} at start, do NOT re-pass it unless branch changed. Pass only NEW or OVERRIDDEN values.'),
  output: z
    .object({
      notesMarkdown: z.string().min(1).optional().describe(
        'Recap of THIS step only (WorkRail concatenates across steps automatically — never repeat earlier notes). ' +
        'Write for a human reader who will review your work later. Include: ' +
        '(1) What you did and the key decisions/trade-offs made, ' +
        '(2) What you found or produced (files changed, endpoints added, test results, etc.), ' +
        '(3) Anything the reader should know (risks, open questions, things you chose NOT to do and why). ' +
        'Use markdown: headings, bullet lists, bold for emphasis. Be specific — names, paths, numbers, not vague summaries. ' +
        'Good length: 10–30 lines. Too short is worse than too long.'
      ),
      artifacts: z.array(z.unknown()).optional().describe('Optional structured artifacts (schema is workflow/contract-defined)'),
    })
    .optional()
    .describe('Durable output to attach to the current node. Only valid when intent is "advance".'),
}).strict();

const continueWorkflowContextAliasField = z.record(z.unknown()).optional().describe(
  'Compatibility alias for context. Canonical field name: "context".'
);

/**
 * Validation schema for continue_workflow (runtime contract).
 *
 * Derives from V2ContinueWorkflowInputShape and adds:
 * - Cross-field validation on the raw boundary shape
 * - Canonical normalization of boundary aliases onto the single continue_workflow contract
 *
 * Handlers use THIS schema for validation. Introspection uses the shape schema.
 */
export const V2ContinueWorkflowInput = V2ContinueWorkflowInputShape
  .extend({
    contextVariables: continueWorkflowContextAliasField,
  })
  .superRefine((data, ctx) => {
    const aliasMap = CONTINUE_WORKFLOW_PROTOCOL.aliasMap;
    const conflicts = aliasMap
      ? findAliasFieldConflicts(data as Readonly<Record<string, unknown>>, aliasMap)
      : [];
    for (const { alias, canonical } of conflicts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [alias],
        message: `Provide either "${canonical}" or "${alias}", not both. Canonical field: "${canonical}".`,
      });
    }
    if (data.intent === 'rehydrate' && data.output) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output'],
        message:
          'intent is "rehydrate" but output was provided. ' +
          'Rehydration is read-only state recovery — it does not accept output.',
      });
    }
  })
  .transform((data) => {
    const normalized = CONTINUE_WORKFLOW_PROTOCOL.aliasMap
      ? normalizeAliasedFields(data as Readonly<Record<string, unknown>>, CONTINUE_WORKFLOW_PROTOCOL.aliasMap)
      : (data as Record<string, unknown>);
    const intent = data.intent ?? (data.output ? 'advance' : 'rehydrate');
    return {
      intent,
      continueToken: data.continueToken,
      ...(normalized.context ? { context: normalized.context } : {}),
      ...(data.output ? { output: data.output } : {}),
      ...(data.workspacePath !== undefined ? { workspacePath: data.workspacePath } : {}),
    };
  });
export type V2ContinueWorkflowInput = z.infer<typeof V2ContinueWorkflowInput>;

export const V2ResumeSessionInput = z.object({
  query: z.string().min(1).max(256).optional().describe(
    'Free text search to find a relevant session. Matches against recap notes and workflow IDs. ' +
    'Without query, only git-context matching runs — the semantic (notes) tier is skipped.'
  ),
  gitBranch: z.string().max(256).optional().describe(
    'Git branch name to match against session observations. Overrides auto-detected branch.'
  ),
  gitHeadSha: z.string().regex(/^[0-9a-f]{40}$/).optional().describe(
    'Git HEAD SHA to match against session observations. Overrides auto-detected HEAD.'
  ),
  workspacePath: z.string()
    .refine((p) => p.startsWith('/'), 'workspacePath must be an absolute path (starting with /)')
    .optional()
    .describe('Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). Used to resolve your git branch and HEAD SHA for workspace-aware session matching. Pass the same path used in the original start_workflow call. If omitted, WorkRail uses the server process directory which may not match your workspace.'),
}).strict();
export type V2ResumeSessionInput = z.infer<typeof V2ResumeSessionInput>;

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
  resume_session: 'Resume Session (v2)',
} as const;

export const V2_TOOL_ANNOTATIONS: Readonly<Record<keyof typeof V2_TOOL_TITLES, ToolAnnotations>> = {
  list_workflows: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inspect_workflow: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  start_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  continue_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  checkpoint_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  resume_session: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
} as const;
