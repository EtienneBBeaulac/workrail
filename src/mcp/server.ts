/**
 * MCP Server Composition Root
 *
 * This module is the entry point for the WorkRail MCP server.
 * It wires together:
 * - Server from the SDK
 * - Tool definitions with Zod schemas
 * - Handler functions
 * - DI container
 *
 * @module mcp/server
 */

import { z } from 'zod';
import { zodToJsonSchema } from './zod-to-json-schema.js';
import { bootstrap, container } from '../di/container.js';
import { DI } from '../di/tokens.js';
import type { WorkflowService } from '../application/services/workflow-service.js';
import type { IFeatureFlagProvider } from '../config/feature-flags.js';
import type { SessionManager } from '../infrastructure/session/SessionManager.js';
import type { HttpServer } from '../infrastructure/session/HttpServer.js';
import type { ShutdownEvents, ShutdownEvent } from '../runtime/ports/shutdown-events.js';
import type { ProcessSignals } from '../runtime/ports/process-signals.js';
import type { ProcessTerminator } from '../runtime/ports/process-terminator.js';

import type { ToolContext, ToolResult, ToolError, JsonValue } from './types.js';
import { createToolFactory, type ToolAnnotations, type ToolDefinition } from './tool-factory.js';
import type { IToolDescriptionProvider } from './tool-description-provider.js';
import { preValidateWorkflowNextArgs, type PreValidateResult } from './validation/workflow-next-prevalidate.js';
import { toBoundedJsonValue } from './validation/bounded-json.js';
import {
  // Workflow tool input schemas
  WorkflowListInput,
  WorkflowGetInput,
  WorkflowNextInput,
  WorkflowValidateJsonInput,
  WorkflowGetSchemaInput,
  // Workflow tool metadata
  WORKFLOW_TOOL_ANNOTATIONS,
  WORKFLOW_TOOL_TITLES,
  // Session tools (static definitions)
  createSessionTool,
  updateSessionTool,
  readSessionTool,
  openDashboardTool,
} from './tools.js';

import { buildV2ToolRegistry } from './v2/tool-registry.js';

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
            code: result.code,
            message: result.message,
            retry: result.retry,
            ...(result.suggestion && { suggestion: result.suggestion }),
            ...(result.details !== undefined ? { details: result.details } : {}),
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
    v2: null, // TODO: wire v2 dependencies when v2Tools flag is enabled
  };
}

// -----------------------------------------------------------------------------
// Tool Conversion
// -----------------------------------------------------------------------------

/**
 * Convert a tool definition to MCP Tool format.
 */
function toMcpTool<TInput extends z.ZodType>(tool: ToolDefinition<TInput>): Tool {
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
      // Unified error envelope (v2 locks): Zod parse failures use the same ToolError shape as handlers.
      const validationIssues = parseResult.error.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
      }));
      const toolError: ToolError = {
        type: 'error',
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        retry: { kind: 'not_retryable' },
        details: { validationIssues },
      };
      return toMcpResult(toolError);
    }
    return toMcpResult(await handler(parseResult.data, ctx));
  };
}

// -----------------------------------------------------------------------------
// Validation-heavy tool support (error UX)
// -----------------------------------------------------------------------------

function createValidatingHandler<TInput extends z.ZodType, TOutput>(
  schema: TInput,
  preValidate: (args: unknown) => PreValidateResult,
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<ToolResult<TOutput>>
): ToolHandler {
  return async (args: unknown, ctx: ToolContext): Promise<McpCallToolResult> => {
    const pre = preValidate(args);
    if (!pre.ok) {
      // Unified error envelope: prevalidation failures use ToolError with details.correctTemplate.
      const bounded = pre.correctTemplate ? toBoundedJsonValue(pre.correctTemplate, 512) : undefined;
      const toolError: ToolError = {
        type: 'error',
        code: pre.code,
        message: pre.message,
        retry: { kind: 'not_retryable' },
        ...(bounded !== undefined ? { details: { correctTemplate: bounded } as JsonValue } : {}),
      };
      return toMcpResult(toolError);
    }

    // Fall back to the standard Zod + handler pipeline
    return createHandler(schema, handler)(args, ctx);
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
  await bootstrap({ runtimeMode: { kind: 'production' } });

  // Create tool context with all dependencies
  const ctx = createToolContext();

  // Resolve description provider from DI
  const descriptionProvider = container.resolve<IToolDescriptionProvider>(
    DI.Mcp.DescriptionProvider
  );

  // Create tool factory with dynamic descriptions
  const buildTool = createToolFactory(descriptionProvider);

  // Build workflow tools with dynamic descriptions
  const workflowListTool = buildTool({
    name: 'workflow_list',
    title: WORKFLOW_TOOL_TITLES.workflow_list,
    inputSchema: WorkflowListInput,
    annotations: WORKFLOW_TOOL_ANNOTATIONS.workflow_list,
  });

  const workflowGetTool = buildTool({
    name: 'workflow_get',
    title: WORKFLOW_TOOL_TITLES.workflow_get,
    inputSchema: WorkflowGetInput,
    annotations: WORKFLOW_TOOL_ANNOTATIONS.workflow_get,
  });

  const workflowNextTool = buildTool({
    name: 'workflow_next',
    title: WORKFLOW_TOOL_TITLES.workflow_next,
    inputSchema: WorkflowNextInput,
    annotations: WORKFLOW_TOOL_ANNOTATIONS.workflow_next,
  });

  const workflowValidateJsonTool = buildTool({
    name: 'workflow_validate_json',
    title: WORKFLOW_TOOL_TITLES.workflow_validate_json,
    inputSchema: WorkflowValidateJsonInput,
    annotations: WORKFLOW_TOOL_ANNOTATIONS.workflow_validate_json,
  });

  const workflowGetSchemaTool = buildTool({
    name: 'workflow_get_schema',
    title: WORKFLOW_TOOL_TITLES.workflow_get_schema,
    inputSchema: WorkflowGetSchemaInput,
    annotations: WORKFLOW_TOOL_ANNOTATIONS.workflow_get_schema,
  });

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

  // Add v2 tools if enabled (explicit opt-in)
  const v2Registry = ctx.featureFlags.isEnabled('v2Tools') ? buildV2ToolRegistry(buildTool) : null;
  if (v2Registry) {
    console.error('[FeatureFlags] v2 tools enabled (enable with WORKRAIL_ENABLE_V2_TOOLS=true)');
    tools.push(...v2Registry.tools.map(toMcpTool));
  } else {
    console.error('[FeatureFlags] v2 tools disabled (enable with WORKRAIL_ENABLE_V2_TOOLS=true)');
  }

  // Build handler map (uses input schemas directly)
  const handlers: Record<string, ToolHandler> = {
    workflow_list: createHandler(WorkflowListInput, handleWorkflowList),
    workflow_get: createHandler(WorkflowGetInput, handleWorkflowGet),
    workflow_next: createValidatingHandler(WorkflowNextInput, preValidateWorkflowNextArgs, handleWorkflowNext),
    workflow_validate_json: createHandler(WorkflowValidateJsonInput, handleWorkflowValidateJson),
    workflow_get_schema: createHandler(WorkflowGetSchemaInput, handleWorkflowGetSchema),
    workrail_create_session: createHandler(createSessionTool.inputSchema, handleCreateSession),
    workrail_update_session: createHandler(updateSessionTool.inputSchema, handleUpdateSession),
    workrail_read_session: createHandler(readSessionTool.inputSchema, handleReadSession),
    workrail_open_dashboard: createHandler(openDashboardTool.inputSchema, handleOpenDashboard),
  };

  // Register v2 handlers only when tools are enabled (prevents tool leaks)
  if (v2Registry) {
    for (const [name, entry] of Object.entries(v2Registry.handlers)) {
      handlers[name] = createHandler(entry.schema, entry.handler);
    }
  }

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

  // Composition-root shutdown hook:
  // Infrastructure can request shutdown via ShutdownEvents, but only the entrypoint terminates the process.
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);
  const processSignals = container.resolve<ProcessSignals>(DI.Runtime.ProcessSignals);
  const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);

  // Ensure we can shut down even when session tools are disabled (no HttpServer to emit events).
  processSignals.on('SIGINT', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGINT' }));
  processSignals.on('SIGTERM', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGTERM' }));
  processSignals.on('SIGHUP', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' }));

  let shutdownStarted = false;
  shutdownEvents.onShutdown((event: ShutdownEvent) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    void (async () => {
      try {
        console.error(`[Shutdown] Requested by ${event.signal}. Stopping services...`);
        await ctx.httpServer?.stop();
        terminator.terminate({ kind: 'success' });
      } catch (err) {
        console.error('[Shutdown] Error while stopping services:', err);
        terminator.terminate({ kind: 'failure' });
      }
    })();
  });
}
