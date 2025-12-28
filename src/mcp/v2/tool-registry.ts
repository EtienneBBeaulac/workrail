import type { z } from 'zod';
import type { ToolBuilder, ToolDefinition } from '../tool-factory.js';
import type { ToolHandler } from '../types.js';
import {
  V2ContinueWorkflowInput,
  V2InspectWorkflowInput,
  V2ListWorkflowsInput,
  V2StartWorkflowInput,
  V2_TOOL_ANNOTATIONS,
  V2_TOOL_TITLES,
} from './tools.js';
import { handleV2ContinueWorkflow, handleV2StartWorkflow } from '../handlers/v2-execution.js';
import { handleV2InspectWorkflow, handleV2ListWorkflows } from '../handlers/v2-workflow.js';

export interface V2ToolRegistration {
  readonly tools: readonly ToolDefinition<z.ZodType>[];
  readonly handlers: Readonly<Record<string, { readonly schema: z.ZodType; readonly handler: ToolHandler<any, any> }>>;
}

export function buildV2ToolRegistry(buildTool: ToolBuilder): V2ToolRegistration {
  const listTool = buildTool({
    name: 'list_workflows',
    title: V2_TOOL_TITLES.list_workflows,
    inputSchema: V2ListWorkflowsInput,
    annotations: V2_TOOL_ANNOTATIONS.list_workflows,
  });

  const inspectTool = buildTool({
    name: 'inspect_workflow',
    title: V2_TOOL_TITLES.inspect_workflow,
    inputSchema: V2InspectWorkflowInput,
    annotations: V2_TOOL_ANNOTATIONS.inspect_workflow,
  });

  const startTool = buildTool({
    name: 'start_workflow',
    title: V2_TOOL_TITLES.start_workflow,
    inputSchema: V2StartWorkflowInput,
    annotations: V2_TOOL_ANNOTATIONS.start_workflow,
  });

  const continueTool = buildTool({
    name: 'continue_workflow',
    title: V2_TOOL_TITLES.continue_workflow,
    inputSchema: V2ContinueWorkflowInput,
    annotations: V2_TOOL_ANNOTATIONS.continue_workflow,
  });

  return {
    tools: [listTool, inspectTool, startTool, continueTool],
    handlers: {
      list_workflows: { schema: V2ListWorkflowsInput, handler: handleV2ListWorkflows },
      inspect_workflow: { schema: V2InspectWorkflowInput, handler: handleV2InspectWorkflow },
      start_workflow: { schema: V2StartWorkflowInput, handler: handleV2StartWorkflow },
      continue_workflow: { schema: V2ContinueWorkflowInput, handler: handleV2ContinueWorkflow },
    },
  };
}
