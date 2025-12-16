/**
 * MCP Tool Definitions
 *
 * Declarative definitions for all tools exposed by the WorkRail MCP server.
 * Each tool has:
 * - name: Unique identifier
 * - title: Human-readable name for UIs
 * - description: Detailed description for LLMs
 * - inputSchema: Zod schema for validation and type inference
 * - annotations: Safety hints for clients
 */

import { z } from 'zod';
import { ExecutionStateSchema } from '../domain/execution/state.js';
import { WorkflowEventSchema } from '../domain/execution/event.js';

// -----------------------------------------------------------------------------
// Input Schemas
// -----------------------------------------------------------------------------

export const WorkflowListInput = z.object({});
export type WorkflowListInput = z.infer<typeof WorkflowListInput>;

export const WorkflowGetInput = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'ID must contain only letters, numbers, hyphens, and underscores')
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
  state: ExecutionStateSchema.describe('Serializable workflow execution state (authoritative)'),
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

export const CreateSessionInput = z.object({
  workflowId: z
    .string()
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
  workflowId: z.string().describe('Workflow identifier'),
  sessionId: z.string().describe('Session identifier'),
  updates: z
    .record(z.unknown())
    .describe('Data to merge into session. Supports nested updates via dot notation.'),
});
export type UpdateSessionInput = z.infer<typeof UpdateSessionInput>;

export const ReadSessionInput = z.object({
  workflowId: z.string().describe('Workflow identifier'),
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
// Tool Annotations
// -----------------------------------------------------------------------------

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

// -----------------------------------------------------------------------------
// Tool Definitions
// -----------------------------------------------------------------------------

export interface ToolDefinition<TInput extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly annotations: ToolAnnotations;
}

// --- Workflow Tools ---

export const workflowListTool: ToolDefinition<typeof WorkflowListInput> = {
  name: 'workflow_list',
  title: 'List Available Workflows',
  description: `Your primary tool for any complex or multi-step request. Call this FIRST to see if a reliable, pre-defined workflow exists, as this is the preferred method over improvisation.

Your process:
1. Call this tool to get a list of available workflows.
2. Analyze the returned descriptions to find a match for the user's goal.
3. If a good match is found, suggest it to the user and use workflow_get to start.
4. If NO match is found, inform the user and then attempt to solve the task using your general abilities.`,
  inputSchema: WorkflowListInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export const workflowGetTool: ToolDefinition<typeof WorkflowGetInput> = {
  name: 'workflow_get',
  title: 'Get Workflow Details',
  description: `Retrieves workflow information with configurable detail level. Supports progressive disclosure to prevent "workflow spoiling" while providing necessary context for workflow selection and initiation.`,
  inputSchema: WorkflowGetInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export const workflowNextTool: ToolDefinition<typeof WorkflowNextInput> = {
  name: 'workflow_next',
  title: 'Execute Next Workflow Step',
  description: `Executes a workflow by getting the next step.

This server is **state + event** driven:
- Provide the current **state** (JSON-serializable execution state)
- Optionally provide an **event** (e.g. step completed) to advance state
- Provide **context** for condition evaluation and loop inputs (forEach items, for counts, etc.)

Repeat calling this tool until it returns isComplete=true.`,
  inputSchema: WorkflowNextInput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export const workflowValidateJsonTool: ToolDefinition<typeof WorkflowValidateJsonInput> = {
  name: 'workflow_validate_json',
  title: 'Validate Workflow JSON',
  description: `Validates workflow JSON content directly without external tools. Use this tool when you need to verify that a workflow JSON file is syntactically correct and follows the proper schema.

This tool provides comprehensive validation including:
- JSON syntax validation with detailed error messages
- Workflow schema compliance checking
- User-friendly error reporting with actionable suggestions
- Support for all workflow features (steps, conditions, validation criteria, etc.)`,
  inputSchema: WorkflowValidateJsonInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export const workflowGetSchemaTool: ToolDefinition<typeof WorkflowGetSchemaInput> = {
  name: 'workflow_get_schema',
  title: 'Get Workflow Schema',
  description: `Retrieves the complete workflow JSON schema for reference and development purposes. Use this tool when you need to understand the structure, required fields, and validation rules for workflows.

This tool provides:
- Complete JSON schema definition with all properties and constraints
- Field descriptions and validation rules
- Examples of valid patterns and formats
- Schema version and metadata information`,
  inputSchema: WorkflowGetSchemaInput,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

// --- Session Tools ---

export const createSessionTool: ToolDefinition<typeof CreateSessionInput> = {
  name: 'workrail_create_session',
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
  name: 'workrail_update_session',
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
  name: 'workrail_read_session',
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
  name: 'workrail_open_dashboard',
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
// Tool Collections
// -----------------------------------------------------------------------------

export const workflowTools = [
  workflowListTool,
  workflowGetTool,
  workflowNextTool,
  workflowValidateJsonTool,
  workflowGetSchemaTool,
] as const;

export const sessionTools = [
  createSessionTool,
  updateSessionTool,
  readSessionTool,
  openDashboardTool,
] as const;

export const allTools = [...workflowTools, ...sessionTools] as const;
