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

import type { ToolContext, V2Dependencies } from './types.js';
import { assertNever } from '../runtime/assert-never.js';
import { unsafeTokenCodecPorts } from '../v2/durable-core/tokens/token-codec-ports.js';
import { createToolFactory, type ToolAnnotations, type ToolDefinition } from './tool-factory.js';
import type { IToolDescriptionProvider } from './tool-description-provider.js';
import { createHandler } from './handler-factory.js';
import type { WrappedToolHandler } from './types/workflow-tool-edition.js';
import { selectWorkflowToolEdition } from './workflow-tool-edition-selector.js';
import {
  // Session tools (static definitions)
  createSessionTool,
  updateSessionTool,
  readSessionTool,
  openDashboardTool,
} from './tools.js';

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

// -----------------------------------------------------------------------------
// Context Creation
// -----------------------------------------------------------------------------

/**
 * Create the tool context from DI container.
 * This provides dependencies to all handlers.
 */
export async function createToolContext(): Promise<ToolContext> {
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

  let v2: V2Dependencies | null = null;

  if (featureFlags.isEnabled('v2Tools')) {
    const gate = container.resolve<any>(DI.V2.ExecutionGate);
    const sessionStore = container.resolve<any>(DI.V2.SessionStore);
    const snapshotStore = container.resolve<any>(DI.V2.SnapshotStore);
    const pinnedStore = container.resolve<any>(DI.V2.PinnedWorkflowStore);
    const keyringPort = container.resolve<any>(DI.V2.Keyring);
    
    // Keyring must be loaded before use (returns Result).
    // Errors are expected failures (missing file on first run creates fresh keyring).
    const keyringResult = await keyringPort.loadOrCreate();
    if (keyringResult.isErr()) {
      const err = keyringResult.error;
      console.error(`[V2Init] Keyring load failed: code=${err.code}, message=${err.message}`);
      // Do not throw; instead, v2 tools remain disabled (null)
      console.error('[FeatureFlags] v2 tools disabled due to keyring initialization failure');
    } else {
      const sha256 = container.resolve<any>(DI.V2.Sha256);
      const crypto = container.resolve<any>(DI.V2.Crypto);
      const hmac = container.resolve<any>(DI.V2.HmacSha256);
      const base64url = container.resolve<any>(DI.V2.Base64Url);
      const base32 = container.resolve<any>(DI.V2.Base32);
      const bech32m = container.resolve<any>(DI.V2.Bech32m);
      const idFactory = container.resolve<any>(DI.V2.IdFactory);

      // Create grouped token codec ports (prevents "forgot base32" bugs)
      const tokenCodecPorts = unsafeTokenCodecPorts({
        keyring: keyringResult.value,
        hmac,
        base64url,
        base32,
        bech32m,
      });

      v2 = {
        gate,
        sessionStore,
        snapshotStore,
        pinnedStore,
        sha256,
        crypto,
        idFactory,
        tokenCodecPorts,
      };
      console.error('[FeatureFlags] v2 tools enabled');
    }
  } else {
    console.error('[FeatureFlags] v2 tools disabled (enable with WORKRAIL_ENABLE_V2_TOOLS=true)');
  }

  return {
    workflowService,
    featureFlags,
    sessionManager,
    httpServer,
    v2,
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
  const ctx = await createToolContext();

  // Resolve description provider from DI
  const descriptionProvider = container.resolve<IToolDescriptionProvider>(
    DI.Mcp.DescriptionProvider
  );

  // Create tool factory with dynamic descriptions
  const buildTool = createToolFactory(descriptionProvider);

  // -------------------------------------------------------------------------
  // Workflow tool edition: v1 XOR v2 (mutually exclusive)
  //
  // Select the active edition using a discriminated union.
  // Illegal states (both v1 and v2) are unrepresentable by construction.
  // -------------------------------------------------------------------------
  const workflowEdition = selectWorkflowToolEdition(ctx.featureFlags, buildTool);

  // Exhaustive switch for logging (compiler ensures all cases handled)
  switch (workflowEdition.kind) {
    case 'v1':
      console.error('[ToolEdition] v1 workflow tools active');
      break;
    case 'v2':
      console.error('[ToolEdition] v2 workflow tools active (v1 excluded)');
      break;
    default:
      assertNever(workflowEdition);
  }

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

  // Build tool list from selected edition
  const tools: Tool[] = workflowEdition.tools.map(toMcpTool);

  // Add session tools if enabled (independent of workflow edition)
  if (ctx.featureFlags.isEnabled('sessionTools')) {
    tools.push(
      toMcpTool(createSessionTool),
      toMcpTool(updateSessionTool),
      toMcpTool(readSessionTool),
      toMcpTool(openDashboardTool)
    );
  }

  // Build handler map from selected edition
  const handlers: Record<string, WrappedToolHandler> = { ...workflowEdition.handlers };

  // Session handlers only when session tools are enabled (capability-based)
  if (ctx.featureFlags.isEnabled('sessionTools')) {
    handlers.create_session = createHandler(createSessionTool.inputSchema, handleCreateSession);
    handlers.update_session = createHandler(updateSessionTool.inputSchema, handleUpdateSession);
    handlers.read_session = createHandler(readSessionTool.inputSchema, handleReadSession);
    handlers.open_dashboard = createHandler(openDashboardTool.inputSchema, handleOpenDashboard);
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
