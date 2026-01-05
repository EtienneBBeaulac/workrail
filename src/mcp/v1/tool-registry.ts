/**
 * V1 Tool Registry
 *
 * Builds v1 workflow tools and their wrapped handlers.
 * Mirrors the structure of v2/tool-registry.ts for symmetry.
 *
 * The registry produces ready-to-dispatch handlers (validation at boundary).
 *
 * @module mcp/v1/tool-registry
 */

import type { z } from 'zod';
import type { ToolBuilder, ToolDefinition } from '../tool-factory.js';
import type { V1WorkflowHandlers } from '../types/workflow-tool-edition.js';
import { createHandler, createValidatingHandler } from '../handler-factory.js';
import { preValidateWorkflowNextArgs } from '../validation/workflow-next-prevalidate.js';
import {
  WorkflowListInput,
  WorkflowGetInput,
  WorkflowNextInput,
  WorkflowValidateJsonInput,
  WorkflowGetSchemaInput,
  WORKFLOW_TOOL_ANNOTATIONS,
  WORKFLOW_TOOL_TITLES,
} from '../tools.js';
import {
  handleWorkflowList,
  handleWorkflowGet,
  handleWorkflowNext,
  handleWorkflowValidateJson,
  handleWorkflowGetSchema,
} from '../handlers/workflow.js';

// -----------------------------------------------------------------------------
// V1 Tool Registration
// -----------------------------------------------------------------------------

/**
 * V1 tool registration result.
 * Contains tools for ListTools and wrapped handlers for CallTool.
 */
export interface V1ToolRegistration {
  readonly tools: readonly ToolDefinition<z.ZodType>[];
  readonly handlers: V1WorkflowHandlers;
}

/**
 * Build the v1 workflow tool registry.
 *
 * @param buildTool - Tool builder with injected description provider
 * @returns Tools and wrapped handlers for v1 workflow surface
 */
export function buildV1ToolRegistry(buildTool: ToolBuilder): V1ToolRegistration {
  // Build tool definitions
  const tools: ToolDefinition<z.ZodType>[] = [
    buildTool({
      name: 'discover_workflows',
      title: WORKFLOW_TOOL_TITLES.discover_workflows,
      inputSchema: WorkflowListInput,
      annotations: WORKFLOW_TOOL_ANNOTATIONS.discover_workflows,
    }),
    buildTool({
      name: 'preview_workflow',
      title: WORKFLOW_TOOL_TITLES.preview_workflow,
      inputSchema: WorkflowGetInput,
      annotations: WORKFLOW_TOOL_ANNOTATIONS.preview_workflow,
    }),
    buildTool({
      name: 'advance_workflow',
      title: WORKFLOW_TOOL_TITLES.advance_workflow,
      inputSchema: WorkflowNextInput,
      annotations: WORKFLOW_TOOL_ANNOTATIONS.advance_workflow,
    }),
    buildTool({
      name: 'validate_workflow',
      title: WORKFLOW_TOOL_TITLES.validate_workflow,
      inputSchema: WorkflowValidateJsonInput,
      annotations: WORKFLOW_TOOL_ANNOTATIONS.validate_workflow,
    }),
    buildTool({
      name: 'get_workflow_schema',
      title: WORKFLOW_TOOL_TITLES.get_workflow_schema,
      inputSchema: WorkflowGetSchemaInput,
      annotations: WORKFLOW_TOOL_ANNOTATIONS.get_workflow_schema,
    }),
  ];

  // Build wrapped handlers (validation at boundary)
  // Note: advance_workflow uses createValidatingHandler for pre-validation
  const handlers: V1WorkflowHandlers = {
    discover_workflows: createHandler(WorkflowListInput, handleWorkflowList),
    preview_workflow: createHandler(WorkflowGetInput, handleWorkflowGet),
    advance_workflow: createValidatingHandler(
      WorkflowNextInput,
      preValidateWorkflowNextArgs,
      handleWorkflowNext
    ),
    validate_workflow: createHandler(WorkflowValidateJsonInput, handleWorkflowValidateJson),
    get_workflow_schema: createHandler(WorkflowGetSchemaInput, handleWorkflowGetSchema),
  };

  return { tools, handlers };
}
