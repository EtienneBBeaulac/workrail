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

// Tool factory and definitions
export type {
  ToolAnnotations,
  ToolDefinition,
  ToolConfig,
  ToolBuilder,
} from './tool-factory.js';

export { createToolFactory } from './tool-factory.js';

// Tool description types
export type {
  DescriptionMode,
  WorkflowToolName,
  ToolDescriptionMap,
  DescriptionsByMode,
} from './types/tool-description-types.js';

export {
  DESCRIPTION_MODES,
  WORKFLOW_TOOL_NAMES,
  isDescriptionMode,
  isWorkflowToolName,
} from './types/tool-description-types.js';

// Tool description provider
export type { IToolDescriptionProvider } from './tool-description-provider.js';

export {
  ToolDescriptionProvider,
  StaticToolDescriptionProvider,
} from './tool-description-provider.js';

// Tool descriptions content
export { DESCRIPTIONS } from './tool-descriptions.js';

// Input schemas and session tools
export {
  // Workflow input schemas
  WorkflowListInput,
  WorkflowGetInput,
  WorkflowNextInput,
  WorkflowValidateJsonInput,
  WorkflowGetSchemaInput,
  // Workflow tool metadata
  WORKFLOW_TOOL_ANNOTATIONS,
  WORKFLOW_TOOL_TITLES,
  // Session input schemas
  CreateSessionInput,
  UpdateSessionInput,
  ReadSessionInput,
  OpenDashboardInput,
  // Session tool definitions (static)
  createSessionTool,
  updateSessionTool,
  readSessionTool,
  openDashboardTool,
  // Session tool collection
  sessionTools,
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

// Utilities
export { zodToJsonSchema } from './zod-to-json-schema.js';
