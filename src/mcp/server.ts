#!/usr/bin/env node
/**
 * MCP Server Composition Root
 *
 * This module is the entry point for the WorkRail MCP server.
 * It wires together:
 * - Server from the SDK
 * - Tool definitions with Zod schemas
 * - Handler functions
 * - DI container
 */

import { z } from 'zod';
import { zodToJsonSchema } from './zod-to-json-schema.js';
import { bootstrap, container } from '../di/container.js';
import { DI } from '../di/tokens.js';
import type { WorkflowService } from '../application/services/workflow-service.js';
import type { IFeatureFlagProvider } from '../config/feature-flags.js';
import type { SessionManager } from '../infrastructure/session/SessionManager.js';
import type { HttpServer } from '../infrastructure/session/HttpServer.js';

import type { ToolContext, ToolResult } from './types.js';
import type { ToolAnnotations } from './tools.js';
import {
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
} from './tools.js';

import {
  handleWorkflowList,
  handleWorkflowGet,
  handleWorkflowNext,
  handleWorkflowValidateJson,
  handleWorkflowGetSchema,
} from './handlers/workflow.js';

import {
  handleCreateSession,
  handleUpdateSession,
  handleReadSession,
  handleOpenDashboard,
} from './handlers/session.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

// MCP SDK result type (use any to avoid complex SDK type dependencies)
type McpCallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// -----------------------------------------------------------------------------
// Result Conversion
// -----------------------------------------------------------------------------

/**
 * Convert our ToolResult<T> to MCP's CallToolResult format.
 */
function toMcpResult<T>(result: ToolResult<T>): McpCallToolResult {
  switch (result.type) {
    case 'success':
      return {
        content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
      };
    case 'error':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: result.message,
            code: result.code,
            ...(result.suggestion && { suggestion: result.suggestion }),
          }, null, 2),
        }],
        isError: true,
      };
  }
}

// -----------------------------------------------------------------------------
// Context Creation
// -----------------------------------------------------------------------------

/**
 * Create the tool context from DI container.
 * This provides dependencies to all handlers.
 */
export function createToolContext(): ToolContext {
  const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);
  const featureFlags = container.resolve<IFeatureFlagProvider>(DI.Infra.FeatureFlags);

  let sessionManager: SessionManager | null = null;
  let httpServer: HttpServer | null = null;

  if (featureFlags.isEnabled('sessionTools')) {
    sessionManager = container.resolve<SessionManager>(DI.Infra.SessionManager);
    httpServer = container.resolve<HttpServer>(DI.Infra.HttpServer);
    console.error('[FeatureFlags] Session tools enabled');
  } else {
    console.error('[FeatureFlags] Session tools disabled (enable with WORKRAIL_ENABLE_SESSION_TOOLS=true)');
  }

  return {
    workflowService,
    featureFlags,
    sessionManager,
    httpServer,
  };
}

// -----------------------------------------------------------------------------
// Tool Conversion
// -----------------------------------------------------------------------------

/**
 * Convert a tool definition to MCP Tool format.
 */
function toMcpTool<TInput extends z.ZodType>(tool: {
  name: string;
  title: string;
  description: string;
  inputSchema: TInput;
  annotations: ToolAnnotations;
}): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
  };
}

// -----------------------------------------------------------------------------
// Tool Dispatch
// -----------------------------------------------------------------------------

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<McpCallToolResult>;

/**
 * Create a type-safe handler wrapper that parses input with Zod.
 */
function createHandler<TInput extends z.ZodType, TOutput>(
  schema: TInput,
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<ToolResult<TOutput>>
): ToolHandler {
  return async (args: unknown, ctx: ToolContext): Promise<McpCallToolResult> => {
    const parseResult = schema.safeParse(args);
    if (!parseResult.success) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Invalid input',
            code: 'VALIDATION_ERROR',
            details: parseResult.error.errors.map(e => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          }, null, 2),
        }],
        isError: true,
      };
    }
    return toMcpResult(await handler(parseResult.data, ctx));
  };
}

// -----------------------------------------------------------------------------
// Server Start
// -----------------------------------------------------------------------------

/**
 * Start the MCP server.
 * This is the main entry point.
 */
export async function startServer(): Promise<void> {
  // Bootstrap DI container
  await bootstrap();

  // Create tool context with all dependencies
  const ctx = createToolContext();

  // Dynamically import SDK modules (ESM-only)
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = await import('@modelcontextprotocol/sdk/types.js');

  // Create server
  const server = new Server(
    {
      name: 'workrail-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Build tool list
  const tools: Tool[] = [
    toMcpTool(workflowListTool),
    toMcpTool(workflowGetTool),
    toMcpTool(workflowNextTool),
    toMcpTool(workflowValidateJsonTool),
    toMcpTool(workflowGetSchemaTool),
  ];

  // Add session tools if enabled
  if (ctx.featureFlags.isEnabled('sessionTools')) {
    tools.push(
      toMcpTool(createSessionTool),
      toMcpTool(updateSessionTool),
      toMcpTool(readSessionTool),
      toMcpTool(openDashboardTool)
    );
  }

  // Build handler map
  const handlers: Record<string, ToolHandler> = {
    workflow_list: createHandler(workflowListTool.inputSchema, handleWorkflowList),
    workflow_get: createHandler(workflowGetTool.inputSchema, handleWorkflowGet),
    workflow_next: createHandler(workflowNextTool.inputSchema, handleWorkflowNext),
    workflow_validate_json: createHandler(workflowValidateJsonTool.inputSchema, handleWorkflowValidateJson),
    workflow_get_schema: createHandler(workflowGetSchemaTool.inputSchema, handleWorkflowGetSchema),
    workrail_create_session: createHandler(createSessionTool.inputSchema, handleCreateSession),
    workrail_update_session: createHandler(updateSessionTool.inputSchema, handleUpdateSession),
    workrail_read_session: createHandler(readSessionTool.inputSchema, handleReadSession),
    workrail_open_dashboard: createHandler(openDashboardTool.inputSchema, handleOpenDashboard),
  };

  // Register ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  // Register CallTool handler
  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => {
    const { name, arguments: args } = request.params;

    const handler = handlers[name];
    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    return handler(args ?? {}, ctx);
  });

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('WorkRail MCP Server running on stdio');
}

// -----------------------------------------------------------------------------
// Entry Point
// -----------------------------------------------------------------------------

// Run if this is the main module
startServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
