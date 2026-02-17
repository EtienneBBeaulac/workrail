/**
 * Tool Description Type System
 *
 * Provides compile-time guarantees:
 * - All tools must have descriptions in all modes
 * - Tool names are type-safe (no stringly-typed code)
 * - Description modes are exhaustive
 *
 * @module mcp/types/tool-description-types
 */

/**
 * Available description modes.
 *
 * Extensible: Add new modes here, TypeScript will enforce
 * that descriptions exist for all tools in the new mode.
 */
export const DESCRIPTION_MODES = [
  'standard',       // Current suggestive language
  'authoritative',  // Imperative/mandatory language
] as const;

export type DescriptionMode = typeof DESCRIPTION_MODES[number];

/**
 * Workflow tool names that require descriptions.
 *
 * Adding a tool here forces descriptions in all modes (compile error otherwise).
 */
export const WORKFLOW_TOOL_NAMES = [
  // v1 tools (action-oriented names)
  'discover_workflows',
  'preview_workflow',
  'advance_workflow',
  'validate_workflow',
  'get_workflow_schema',
  // v2 tools (feature-flagged)
  'list_workflows',
  'inspect_workflow',
  'start_workflow',
  'continue_workflow',
  'checkpoint_workflow',
] as const;

export type WorkflowToolName = typeof WORKFLOW_TOOL_NAMES[number];

/**
 * Type-safe description map: every tool must have a description.
 */
export type ToolDescriptionMap = Readonly<Record<WorkflowToolName, string>>;

/**
 * Complete descriptions: every mode must have all tool descriptions.
 */
export type DescriptionsByMode = Readonly<Record<DescriptionMode, ToolDescriptionMap>>;

/**
 * Type guard for DescriptionMode
 */
export function isDescriptionMode(value: string): value is DescriptionMode {
  return (DESCRIPTION_MODES as readonly string[]).includes(value);
}

/**
 * Type guard for WorkflowToolName
 */
export function isWorkflowToolName(value: string): value is WorkflowToolName {
  return (WORKFLOW_TOOL_NAMES as readonly string[]).includes(value);
}
