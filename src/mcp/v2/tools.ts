import path from 'path';
import { z } from 'zod';
import type { ToolAnnotations } from '../tool-factory.js';
import {
  CONTINUE_WORKFLOW_PROTOCOL,
  findAliasFieldConflicts,
  normalizeAliasedFields,
} from '../workflow-protocol-contracts.js';

function isAbsoluteWorkspacePath(p: string): boolean {
  return path.isAbsolute(p);
}

const workspacePathField = z.string()
  .refine((p) => isAbsoluteWorkspacePath(p), 'workspacePath must be an absolute path')
  .describe('Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). Used to resolve project-scoped workflow variants against the correct workspace. If omitted, WorkRail uses MCP roots when available, then falls back to the server process directory.');

const optionalWorkspacePathField = workspacePathField.optional();

export const V2ListWorkflowsInput = z.object({
  workspacePath: workspacePathField.describe(
    'Required. Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). WorkRail uses this to resolve project-scoped workflow variants against the correct workspace for discovery-sensitive workflow listing. Shared MCP servers cannot infer this safely.'
  ),
  includeSources: z.boolean().optional().describe(
    'When true, includes a source catalog in the response showing where workflows come from (built-in, project-scoped, rooted-sharing, external), with effective and shadowed workflow counts per source. Omit or set false for the default workflow-list-only response.'
  ),
});
export type V2ListWorkflowsInput = z.infer<typeof V2ListWorkflowsInput>;

export const V2InspectWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^([a-z0-9_-]+|[a-z][a-z0-9_-]+\.[a-z][a-z0-9_-]+)$/, 'Workflow ID must be a valid legacy ID (e.g. my-workflow) or namespaced ID (e.g. wr.discovery)').describe('The workflow ID to inspect'),
  mode: z.enum(['metadata', 'preview']).default('preview').describe('Detail level: metadata (name and description only) or preview (full step-by-step breakdown, default)'),
  workspacePath: workspacePathField.describe(
    'Required. Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). WorkRail uses this to resolve the correct project-scoped workflow variant for discovery-sensitive workflow inspection. Shared MCP servers cannot infer this safely.'
  ),
});
export type V2InspectWorkflowInput = z.infer<typeof V2InspectWorkflowInput>;

export const V2StartWorkflowInput = z.object({
  workflowId: z.string().min(1).regex(/^([a-z0-9_-]+|[a-z][a-z0-9_-]+\.[a-z][a-z0-9_-]+)$/, 'Workflow ID must be a valid legacy ID (e.g. my-workflow) or namespaced ID (e.g. wr.discovery)').describe('The workflow ID to start'),
  workspacePath: workspacePathField.describe('Required. Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). WorkRail uses this to resolve the correct project-scoped workflow variant and to anchor the session to the correct repo for future resume_session discovery. Shared MCP servers cannot infer this safely.'),
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
  workspacePath: optionalWorkspacePathField,
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
    if (data.intent === 'rehydrate' && data.workspacePath === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workspacePath'],
        message:
          'workspacePath is required for rehydration. Shared WorkRail servers cannot safely infer your current workspace, so pass the absolute "Workspace:" path from your system parameters.',
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
    'Tip: use the user\'s exact words (e.g. "mr ownership", "ACEI-1234"). ' +
    'Without query, only git-context matching runs — the semantic (notes) tier is skipped.'
  ),
  runId: z.string().regex(/^run_[a-z0-9]+$/).optional().describe(
    'Exact run ID to find (e.g. "run_tbi2ag7njfjgc2aitt4qg5eaiq"). ' +
    'When provided, the matching session is returned as the sole top-priority candidate.'
  ),
  sessionId: z.string().regex(/^sess_[a-zA-Z0-9_]+$/).optional().describe(
    'Exact session ID to find (e.g. "sess_s5o2ieem4mwypoqnn6ztzyyag4"). ' +
    'When provided, the matching session is returned as the sole top-priority candidate.'
  ),
  gitBranch: z.string().max(256).optional().describe(
    'Git branch name to match against session observations. Overrides auto-detected branch.'
  ),
  gitHeadSha: z.string().regex(/^[0-9a-f]{40}$/).optional().describe(
    'Git HEAD SHA to match against session observations. Overrides auto-detected HEAD.'
  ),
  workspacePath: workspacePathField.describe(
    'Required. Absolute path to your current workspace directory (e.g. the "Workspace:" value from your system parameters). WorkRail uses this to identify the current repo and resume the correct session on shared MCP servers.'
  ),
  sameWorkspaceOnly: z.boolean().optional().describe(
    'If true, only sessions from the same repo/workspace are considered when repo_root_hash is available. ' +
    'Use this when the user clearly means "resume work from this repo only".'
  ),
}).strict();
export type V2ResumeSessionInput = z.infer<typeof V2ResumeSessionInput>;

export const V2ManageWorkflowSourceInput = z.object({
  action: z.enum(['attach', 'detach']).describe(
    'The operation to perform. "attach" registers the directory as a managed workflow source; "detach" removes it. Both operations are idempotent.'
  ),
  path: z.string().min(1).refine((p) => path.isAbsolute(p), 'path must be an absolute path').describe(
    'Absolute filesystem path to the workflow directory to attach or detach. Must be an absolute path. The path is normalized (resolved) before storage.'
  ),
}).strict();
export type V2ManageWorkflowSourceInput = z.infer<typeof V2ManageWorkflowSourceInput>;

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
  manage_workflow_source: 'Manage Workflow Source (v2)',
} as const;

export const V2_TOOL_ANNOTATIONS: Readonly<Record<keyof typeof V2_TOOL_TITLES, ToolAnnotations>> = {
  list_workflows: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inspect_workflow: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  start_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  continue_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  checkpoint_workflow: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  resume_session: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  manage_workflow_source: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
} as const;
