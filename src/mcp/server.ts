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
import type { ToolContext, V2Dependencies } from './types.js';
import { assertNever } from '../runtime/assert-never.js';
import { unsafeTokenCodecPorts } from '../v2/durable-core/tokens/token-codec-ports.js';
import { validateWorkflowSchema } from '../application/validation.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../v2/read-only/v1-to-v2-shim.js';
import type { WorkflowCompiler } from '../application/services/workflow-compiler.js';
import type { ValidationEngine } from '../application/services/validation-engine.js';
import { LocalWorkspaceAnchorV2 } from '../v2/infra/local/workspace-anchor/index.js';
import { WorkspaceRootsManager, type RootsReader } from './workspace-roots-manager.js';
import { LocalDirectoryListingV2 } from '../v2/infra/local/directory-listing/index.js';
import { LocalSessionSummaryProviderV2 } from '../v2/infra/local/session-summary-provider/index.js';

import { createToolFactory, type ToolAnnotations, type ToolDefinition } from './tool-factory.js';
import { isDevMode } from './dev-mode.js';
import {
  DEFAULT_RING_BUFFER_CAPACITY,
  ToolCallTimingRingBuffer,
  composeSinks,
  createDevPerfSink,
  createRingBufferSink,
  withToolCallTiming,
  type ToolCallTimingSink,
} from './tool-call-timing.js';
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
      const entropy = container.resolve<any>(DI.V2.RandomEntropy);
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

      const dataDir = container.resolve<any>(DI.V2.DataDir);
      const fsPort = container.resolve<any>(DI.V2.FileSystem);
      const directoryListing = new LocalDirectoryListingV2(fsPort);

      // Construct Phase 1a validation pipeline deps (same pattern as CLI and validate-workflow-json)
      const validationEngine = container.resolve<ValidationEngine>(DI.Infra.ValidationEngine);
      const compiler = container.resolve<WorkflowCompiler>(DI.Services.WorkflowCompiler);
      const validationPipelineDeps = {
        schemaValidate: validateWorkflowSchema,
        structuralValidate: validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
        compiler,
        normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot,
      };

      // Resolve the token alias store from DI and load its index.
      const tokenAliasStore = container.resolve<any>(DI.V2.TokenAliasStore);
      const aliasLoadResult = await tokenAliasStore.loadIndex();
      if (aliasLoadResult.isErr()) {
        // Non-fatal: if the index file doesn't exist yet (fresh install), loadIndex()
        // treats it as an empty index. Log but don't disable v2 tools.
        console.error(`[V2Init] Token alias index load warning: ${aliasLoadResult.error.message}`);
      }

      const rememberedRootsStore = container.resolve<any>(DI.V2.RememberedRootsStore);
      const managedSourceStore = container.resolve<any>(DI.V2.ManagedSourceStore);

      v2 = {
        gate,
        sessionStore,
        snapshotStore,
        pinnedStore,
        sha256,
        crypto,
        entropy,
        idFactory,
        tokenCodecPorts,
        tokenAliasStore,
        rememberedRootsStore,
        managedSourceStore,
        validationPipelineDeps,
        // resolvedRootUris starts empty; overridden per-request at the CallTool boundary
        // with a snapshot of the current MCP client roots (see transport entry points).
        resolvedRootUris: [],
        workspaceResolver: new LocalWorkspaceAnchorV2(process.cwd()),
        dataDir,
        directoryListing,
        sessionSummaryProvider: new LocalSessionSummaryProviderV2({
          directoryListing,
          dataDir,
          sessionStore,
          snapshotStore,
        }),
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
// Server Composition (Transport-Agnostic)
// -----------------------------------------------------------------------------

/**
 * Composed MCP server — ready for transport connection.
 * 
 * Contains the MCP Server instance with all tools and handlers registered,
 * but no transport connected. Pure composition with no transport-specific
 * side effects (no stdin watchers, no roots fetching).
 */
/**
 * Read-only view exposed to consumers of composeServer().
 * Transport entry points that need write access to roots use the
 * internal ComposedServerInternal type instead.
 */
export interface ComposedServer {
  readonly server: import('@modelcontextprotocol/sdk/server/index.js').Server;
  readonly ctx: ToolContext;
  readonly rootsReader: RootsReader;
  readonly tools: readonly Tool[];
  readonly handlers: Record<string, WrappedToolHandler>;
}

/** @internal Transport entry points need write access to roots. */
export interface ComposedServerInternal extends ComposedServer {
  readonly rootsManager: WorkspaceRootsManager;
}

/**
 * Compose the MCP server from DI container.
 * 
 * Pure composition function:
 * - Bootstraps DI and creates tool context
 * - Builds tools and handlers from workflow edition
 * - Registers request handlers on the MCP Server
 * - Mounts console routes if available
 * - Returns composed server ready for transport connection
 * 
 * No transport-specific behavior (stdin watchers, roots fetching, etc).
 * Those belong in the transport-specific entry points.
 */
export async function composeServer(): Promise<ComposedServerInternal> {
  // Bootstrap DI container. No runtimeMode override -- detectRuntimeMode() in
  // container.ts is the single source of truth (reads VITEST / NODE_ENV=test).
  // Hardcoding 'production' here bypassed test isolation, causing NodeProcessSignals
  // and NodeProcessTerminator to be used in tests instead of their noop/throwing variants.
  await bootstrap();

  // Create tool context with all dependencies
  const ctx = await createToolContext();

  // ---------------------------------------------------------------------------
  // Timing ring buffer -- created here so it can be shared between the
  // CallTool handler (write side) and the console API route (read side).
  // ---------------------------------------------------------------------------
  const timingRingBuffer = new ToolCallTimingRingBuffer(DEFAULT_RING_BUFFER_CAPACITY);

  // Mount v2 Console API routes (read-only, if v2 + httpServer available)
  if (ctx.v2 && ctx.httpServer && ctx.v2.dataDir && ctx.v2.directoryListing) {
    const { ConsoleService } = await import('../v2/usecases/console-service.js');
    const { mountConsoleRoutes } = await import('../v2/usecases/console-routes.js');
    const consoleService = new ConsoleService({
      directoryListing: ctx.v2.directoryListing,
      dataDir: ctx.v2.dataDir,
      sessionStore: ctx.v2.sessionStore,
      snapshotStore: ctx.v2.snapshotStore,
      pinnedWorkflowStore: ctx.v2.pinnedStore,
    });
    ctx.httpServer.mountRoutes((app) => mountConsoleRoutes(app, consoleService, ctx.workflowService, timingRingBuffer));
    console.error('[Console] v2 Console API routes mounted at /api/v2/');
  }

  // Finalize HTTP server (install 404 handler after all routes are mounted)
  ctx.httpServer?.finalize();

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

  // Mutable roots cell — write surface held locally, read surface passed to handlers.
  const rootsManager = new WorkspaceRootsManager();

  // Dynamically import SDK modules (ESM-only)
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
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
        resources: {},
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

  // ---------------------------------------------------------------------------
  // Tool call timing sink
  //
  // Observations flow into the ring buffer created above (shared with console route).
  // When WORKRAIL_DEV=1, stderr output is composed in as a second sink.
  // ---------------------------------------------------------------------------
  const devMode = isDevMode();
  const timingSink: ToolCallTimingSink = devMode
    ? composeSinks(createRingBufferSink(timingRingBuffer), createDevPerfSink())
    : createRingBufferSink(timingRingBuffer);

  if (devMode) {
    console.error('[PerfTrace] WORKRAIL_DEV=1 -- tool call timing active');
  }

  // Register CallTool handler.
  // Snapshots workspace root URIs once at the request boundary so handlers
  // receive deterministic, immutable input for their duration.
  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => {
    const { name, arguments: args } = request.params;
    // Capture start time at the very top so unknown-tool elapsed time is accurate.
    const handlerStartMs = Date.now();
    const handlerStartHr = performance.now();

    const handler = handlers[name];
    if (!handler) {
      // Record unknown tool as a timing observation so gaps are visible in perf data
      const unknownResult = {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
      const durationMs = Math.round((performance.now() - handlerStartHr) * 100) / 100;
      try {
        timingSink({ toolName: name ?? '(unknown)', startedAtMs: handlerStartMs, durationMs, outcome: 'unknown_tool' });
      } catch {
        // Timing is observability, not correctness.
      }
      return unknownResult;
    }

    const requestCtx: ToolContext = ctx.v2
      ? { ...ctx, v2: { ...ctx.v2, resolvedRootUris: rootsManager.getCurrentRootUris() } }
      : ctx;

    return withToolCallTiming(
      name,
      () => handler(args ?? {}, requestCtx),
      timingSink,
    );
  });

  // Register ListResources handler — exposes the workrail://tags catalog resource.
  // Agents can read tag definitions without calling list_workflows at all (~500 tokens
  // vs 3-5K for the full workflow list).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'workrail://tags',
        name: 'WorkRail Tag Catalog',
        description:
          'Closed-set tag definitions for workflow discovery. ' +
          'Read this before calling list_workflows — it tells you which tags exist ' +
          'and when to use each one, so you can call list_workflows with tags=[...] ' +
          'instead of loading all 36+ workflows into context.',
        mimeType: 'application/json',
      },
    ],
  }));

  // Register ReadResource handler — serves spec/workflow-tags.json verbatim.
  server.setRequestHandler(ReadResourceRequestSchema, async (request: any): Promise<any> => {
    const uri: string = request.params?.uri ?? '';
    if (uri !== 'workrail://tags') {
      return {
        contents: [],
        isError: true,
        _meta: { error: `Unknown resource: ${uri}` },
      };
    }
    try {
      const fs = await import('fs');
      const path = await import('path');
      const tagsPath = path.resolve(__dirname, '../../spec/workflow-tags.json');
      const raw = fs.readFileSync(tagsPath, 'utf-8');
      return {
        contents: [
          {
            uri: 'workrail://tags',
            mimeType: 'application/json',
            text: raw,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        contents: [],
        isError: true,
        _meta: { error: `Failed to read tag catalog: ${message}` },
      };
    }
  });

  return { server, ctx, rootsManager, rootsReader: rootsManager, tools, handlers };
}

