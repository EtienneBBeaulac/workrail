/**
 * MCP Module Exports
 *
 * Re-exports all public types and functions from the MCP module.
 */

// Types
export type {
  ErrorCode,
  ToolSuccess,
  ToolError,
  ToolResult,
  ToolContext,
  ToolHandler,
} from './types.js';

export {
  success,
  error,
} from './types.js';

// Tool definitions
export type {
  ToolAnnotations,
  ToolDefinition,
} from './tools.js';

export {
  // Input schemas
  WorkflowListInput,
  WorkflowGetInput,
  WorkflowNextInput,
  WorkflowValidateJsonInput,
  WorkflowGetSchemaInput,
  CreateSessionInput,
  UpdateSessionInput,
  ReadSessionInput,
  OpenDashboardInput,
  // Tool definitions
  workflowListTool,
  workflowGetTool,
  workflowNextTool,
  workflowValidateJsonTool,
  workflowGetSchemaTool,
  createSessionTool,
  updateSessionTool,
  readSessionTool,
  openDashboardTool,
  // Collections
  workflowTools,
  sessionTools,
  allTools,
} from './tools.js';

// Workflow handlers
export {
  handleWorkflowList,
  handleWorkflowGet,
  handleWorkflowNext,
  handleWorkflowValidateJson,
  handleWorkflowGetSchema,
} from './handlers/workflow.js';

export type {
  WorkflowSummary,
  WorkflowListOutput,
  WorkflowGetOutput,
  WorkflowNextOutput,
  WorkflowValidateJsonOutput,
  WorkflowGetSchemaOutput,
} from './handlers/workflow.js';

// Session handlers
export {
  handleCreateSession,
  handleUpdateSession,
  handleReadSession,
  handleOpenDashboard,
} from './handlers/session.js';

export type {
  CreateSessionOutput,
  UpdateSessionOutput,
  ReadSessionOutput,
  ReadSessionSchemaOutput,
  SchemaOverview,
  OpenDashboardOutput,
} from './handlers/session.js';

// Server
export {
  createToolContext,
  startServer,
} from './server.js';
