/**
 * MCP Tool Schemas and Types
 *
 * Input schemas for tool validation and session tool definitions.
 * Workflow tool descriptions are provided by IToolDescriptionProvider.
 *
 * @module mcp/tools
 */

import { z } from 'zod';
import { ExecutionStateSchema } from '../domain/execution/state.js';
import { WorkflowEventSchema } from '../domain/execution/event.js';

// -----------------------------------------------------------------------------
// Types (re-exported from tool-factory for convenience)
// -----------------------------------------------------------------------------

export type { ToolAnnotations, ToolDefinition } from './tool-factory.js';

// -----------------------------------------------------------------------------
// Workflow Tool Input Schemas
// -----------------------------------------------------------------------------

export const WorkflowListInput = z.object({});
export type WorkflowListInput = z.infer<typeof WorkflowListInput>;

export const WorkflowGetInput = z.object({
  workflowId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores')
    .describe('The unique identifier of the workflow to retrieve'),
  mode: z
    .enum(['metadata', 'preview'])
    .default('preview')
    .describe("Detail level: 'metadata' for info only, 'preview' for first step"),
});
export type WorkflowGetInput = z.infer<typeof WorkflowGetInput>;

export const WorkflowNextInput = z.object({
  workflowId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores')
    .describe('The unique identifier of the workflow'),
  state: ExecutionStateSchema.describe(
    'Serializable workflow execution state (authoritative). ' +
    'For the first call, use: { kind: "init" }. ' +
    'For subsequent calls, use the "state" returned by the previous workflow_next response.'
  ),
  event: WorkflowEventSchema.optional().describe('Optional event to apply before selecting the next step'),
  context: z
    .record(z.unknown())
    .optional()
    .describe('External context variables for condition evaluation and loop inputs'),
});
export type WorkflowNextInput = z.infer<typeof WorkflowNextInput>;

export const WorkflowValidateJsonInput = z.object({
  workflowJson: z
    .string()
    .min(1, 'Workflow JSON cannot be empty')
    .describe('The complete workflow JSON content as a string to validate'),
});
export type WorkflowValidateJsonInput = z.infer<typeof WorkflowValidateJsonInput>;

export const WorkflowGetSchemaInput = z.object({});
export type WorkflowGetSchemaInput = z.infer<typeof WorkflowGetSchemaInput>;

// -----------------------------------------------------------------------------
// Workflow Tool Annotations (static, don't change by mode)
// -----------------------------------------------------------------------------

import type { ToolAnnotations } from './tool-factory.js';
import type { WorkflowToolName } from './types/tool-description-types.js';

export const WORKFLOW_TOOL_ANNOTATIONS: Readonly<Record<WorkflowToolName, ToolAnnotations>> = {
  // v1 tools (action-oriented names)
  discover_workflows: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  preview_workflow: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  advance_workflow: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  validate_workflow: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  get_workflow_schema: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  // v2 tools (feature-flagged)
  list_workflows: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inspect_workflow: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  start_workflow: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  continue_workflow: {
    readOnlyHint: false,
    destructiveHint: false,
    // The v2 contract is replay-safe; hint that retries are OK.
    idempotentHint: true,
  },
  checkpoint_workflow: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const;

// -----------------------------------------------------------------------------
// Workflow Tool Titles (static, don't change by mode)
// -----------------------------------------------------------------------------

export const WORKFLOW_TOOL_TITLES: Readonly<Record<WorkflowToolName, string>> = {
  // v1 tools (action-oriented names)
  discover_workflows: 'Discover Available Workflows',
  preview_workflow: 'Preview Workflow Details',
  advance_workflow: 'Advance Workflow Execution',
  validate_workflow: 'Validate Workflow JSON',
  get_workflow_schema: 'Get Workflow Schema',
  // v2 tools (feature-flagged)
  list_workflows: 'List Workflows (v2)',
  inspect_workflow: 'Inspect Workflow (v2)',
  start_workflow: 'Start Workflow (v2)',
  continue_workflow: 'Continue Workflow (v2)',
  checkpoint_workflow: 'Checkpoint Workflow (v2)',
} as const;

// -----------------------------------------------------------------------------
// Session Tool Input Schemas
// -----------------------------------------------------------------------------

export const CreateSessionInput = z.object({
  workflowId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores')
    .describe('Workflow identifier (e.g., "bug-investigation", "mr-review")'),
  sessionId: z
    .string()
    .describe('Unique session identifier (e.g., ticket ID "AUTH-1234", branch name)'),
  initialData: z
    .record(z.unknown())
    .default({})
    .describe('Initial session data. Can include dashboard, phases, etc.'),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

export const UpdateSessionInput = z.object({
  workflowId: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('Workflow identifier'),
  sessionId: z.string().describe('Session identifier'),
  updates: z
    .record(z.unknown())
    .describe('Data to merge into session. Supports nested updates via dot notation.'),
});
export type UpdateSessionInput = z.infer<typeof UpdateSessionInput>;

export const ReadSessionInput = z.object({
  workflowId: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Workflow ID must contain only letters, numbers, hyphens, and underscores').describe('Workflow identifier'),
  sessionId: z.string().describe('Session identifier'),
  path: z
    .string()
    .optional()
    .describe('JSONPath query. If omitted, returns full session data. Examples: "dashboard", "hypotheses[0]"'),
});
export type ReadSessionInput = z.infer<typeof ReadSessionInput>;

export const OpenDashboardInput = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Session to display. If provided, dashboard opens directly to this session.'),
});
export type OpenDashboardInput = z.infer<typeof OpenDashboardInput>;

// -----------------------------------------------------------------------------
// Session Tool Definitions (static, no description modes)
// -----------------------------------------------------------------------------

import type { ToolDefinition } from './tool-factory.js';

export const createSessionTool: ToolDefinition<typeof CreateSessionInput> = {
  name: 'create_session',
  title: 'Create Workflow Session',
  description: `Create a new workflow session stored in ~/.workrail/sessions/.

This creates a JSON file to track all workflow state and data. The dashboard will automatically display this session's progress in real-time.

Returns the session ID and file path.`,
  inputSchema: CreateSessionInput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export const updateSessionTool: ToolDefinition<typeof UpdateSessionInput> = {
  name: 'update_session',
  title: 'Update Session Data',
  description: `Update session data with deep merge.

Updates are merged into existing data (objects are merged, arrays are replaced).

Use this throughout the workflow to:
- Update progress and confidence
- Add phases and subsections
- Update hypotheses
- Add timeline events

Note: Use dot notation for nested updates.`,
  inputSchema: UpdateSessionInput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export const readSessionTool: ToolDefinition<typeof ReadSessionInput> = {
  name: 'read_session',
  title: 'Read Session Data',
  description: `Read session data with optional JSONPath query for targeted reads.

Reading only what you need saves tokens and improves performance.

Special Queries:
- Schema overview: Use path "$schema" to get a map of all available fields

Examples:
- Full session: omit path
- Dashboard only: path "dashboard"
- Specific hypothesis: path "hypotheses[0]"
- Phase 1 data: path "phases.phase-1"`,
  inputSchema: ReadSessionInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export const openDashboardTool: ToolDefinition<typeof OpenDashboardInput> = {
  name: 'open_dashboard',
  title: 'Open Dashboard',
  description: `Open the web dashboard in the user's default browser.

The dashboard shows real-time progress, visualizations, and all session data in a beautiful UI.

If sessionId is provided, opens directly to that session. Otherwise opens to the home page showing all sessions.`,
  inputSchema: OpenDashboardInput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

// -----------------------------------------------------------------------------
// Session Tool Collection
// -----------------------------------------------------------------------------

export const sessionTools = [
  createSessionTool,
  updateSessionTool,
  readSessionTool,
  openDashboardTool,
] as const;
