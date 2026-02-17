/**
 * V2 Tool Registry
 *
 * Builds v2 workflow tools and their wrapped handlers.
 * Mirrors the structure of v1/tool-registry.ts for symmetry.
 *
 * The registry produces ready-to-dispatch handlers (validation at boundary).
 *
 * @module mcp/v2/tool-registry
 */

import type { z } from 'zod';
import type { ToolBuilder, ToolDefinition } from '../tool-factory.js';
import type { V2WorkflowHandlers } from '../types/workflow-tool-edition.js';
import { createHandler } from '../handler-factory.js';
import {
  V2CheckpointWorkflowInput,
  V2ContinueWorkflowInput,
  V2InspectWorkflowInput,
  V2ListWorkflowsInput,
  V2StartWorkflowInput,
  V2_TOOL_ANNOTATIONS,
  V2_TOOL_TITLES,
} from './tools.js';
import { handleV2ContinueWorkflow, handleV2StartWorkflow } from '../handlers/v2-execution.js';
import { handleV2InspectWorkflow, handleV2ListWorkflows } from '../handlers/v2-workflow.js';
import { handleV2CheckpointWorkflow } from '../handlers/v2-checkpoint.js';

// -----------------------------------------------------------------------------
// V2 Tool Registration
// -----------------------------------------------------------------------------

/**
 * V2 tool registration result.
 * Contains tools for ListTools and wrapped handlers for CallTool.
 */
export interface V2ToolRegistration {
  readonly tools: readonly ToolDefinition<z.ZodType>[];
  readonly handlers: V2WorkflowHandlers;
}

/**
 * Build the v2 workflow tool registry.
 *
 * @param buildTool - Tool builder with injected description provider
 * @returns Tools and wrapped handlers for v2 workflow surface
 */
export function buildV2ToolRegistry(buildTool: ToolBuilder): V2ToolRegistration {
  // Build tool definitions
  const tools: ToolDefinition<z.ZodType>[] = [
    buildTool({
      name: 'list_workflows',
      title: V2_TOOL_TITLES.list_workflows,
      inputSchema: V2ListWorkflowsInput,
      annotations: V2_TOOL_ANNOTATIONS.list_workflows,
    }),
    buildTool({
      name: 'inspect_workflow',
      title: V2_TOOL_TITLES.inspect_workflow,
      inputSchema: V2InspectWorkflowInput,
      annotations: V2_TOOL_ANNOTATIONS.inspect_workflow,
    }),
    buildTool({
      name: 'start_workflow',
      title: V2_TOOL_TITLES.start_workflow,
      inputSchema: V2StartWorkflowInput,
      annotations: V2_TOOL_ANNOTATIONS.start_workflow,
    }),
    buildTool({
      name: 'continue_workflow',
      title: V2_TOOL_TITLES.continue_workflow,
      inputSchema: V2ContinueWorkflowInput,
      annotations: V2_TOOL_ANNOTATIONS.continue_workflow,
    }),
    buildTool({
      name: 'checkpoint_workflow',
      title: V2_TOOL_TITLES.checkpoint_workflow,
      inputSchema: V2CheckpointWorkflowInput,
      annotations: V2_TOOL_ANNOTATIONS.checkpoint_workflow,
    }),
  ];

  // Build wrapped handlers (validation at boundary)
  const handlers: V2WorkflowHandlers = {
    list_workflows: createHandler(V2ListWorkflowsInput, handleV2ListWorkflows),
    inspect_workflow: createHandler(V2InspectWorkflowInput, handleV2InspectWorkflow),
    start_workflow: createHandler(V2StartWorkflowInput, handleV2StartWorkflow),
    continue_workflow: createHandler(V2ContinueWorkflowInput, handleV2ContinueWorkflow),
    checkpoint_workflow: createHandler(V2CheckpointWorkflowInput, handleV2CheckpointWorkflow),
  };

  return { tools, handlers };
}
