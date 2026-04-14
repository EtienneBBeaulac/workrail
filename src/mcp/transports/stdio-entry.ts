/**
 * stdio transport entry point for WorkRail MCP server.
 * 
 * This is the existing IDE/Firebender use case — connects to the agent
 * over stdin/stdout. Supports workspace roots via MCP roots/list protocol.
 */

import { composeServer } from '../server.js';
import { wireShutdownHooks, wireStdinShutdown, wireStdoutShutdown } from './shutdown-hooks.js';

const INITIAL_ROOTS_TIMEOUT_MS = 1000;

async function fetchInitialRootsWithTimeout(server: {
  listRoots: () => Promise<{ roots: Array<{ uri: string }> }>;
}): Promise<{ roots: Array<{ uri: string }> } | null> {
  return Promise.race([
    server.listRoots(),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), INITIAL_ROOTS_TIMEOUT_MS);
    }),
  ]);
}

export async function startStdioServer(): Promise<void> {
  // Last-resort logging: surface unhandled errors to stderr before Node.js
  // terminates. Without these, crashes are silent (exit code 1, no message).
  // Note: wireStdoutShutdown() handles the primary EPIPE crash path;
  // these handlers catch anything else that slips through.
  process.on('uncaughtException', (err) => {
    console.error('[MCP] Uncaught exception -- process will exit:', err);
    // Do not call process.exit() here: let the default Node.js behavior
    // handle termination so the exit code is correct.
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[MCP] Unhandled promise rejection:', reason);
    // Node.js v15+: registering this handler suppresses the runtime's default
    // exit-on-unhandled-rejection behavior. Explicitly exit so the process
    // does not silently continue in an undefined state.
    process.exit(1);
  });

  const { server, ctx, rootsManager } = await composeServer();

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const {
    RootsListChangedNotificationSchema,
  } = await import('@modelcontextprotocol/sdk/types.js');

  // -------------------------------------------------------------------------
  // stdio-specific: Handle root change notifications from the IDE client
  // -------------------------------------------------------------------------
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    try {
      const result = await server.listRoots();
      rootsManager.updateRootUris(result.roots.map((r: { uri: string }) => r.uri));
      console.error(`[Roots] Updated workspace roots: ${result.roots.map((r: { uri: string }) => r.uri).join(', ') || '(none)'}`);
    } catch {
      console.error('[Roots] Failed to fetch updated roots after change notification');
    }
  });

  // -------------------------------------------------------------------------
  // stdio-specific: Guard stdout against EPIPE before connecting transport.
  //
  // The MCP SDK's StdioServerTransport only registers error listeners on
  // stdin. If the client disconnects while a write is in-flight, stdout emits
  // EPIPE with no listener -- Node.js converts this to an uncaught exception
  // and the process crashes. wireStdoutShutdown() registers the listener
  // *before* server.connect() so no write can occur without the guard in place.
  // -------------------------------------------------------------------------
  wireStdoutShutdown();

  // -------------------------------------------------------------------------
  // stdio-specific: Connect transport
  // -------------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[Transport] WorkRail MCP Server running on stdio');

  // -------------------------------------------------------------------------
  // stdio-specific: Fetch initial workspace roots from the IDE client
  // -------------------------------------------------------------------------
  void fetchInitialRootsWithTimeout(server)
    .then((result) => {
      if (result == null) {
        console.error('[Roots] Initial roots probe timed out; workspace context will use server CWD fallback');
        return;
      }

      rootsManager.updateRootUris(result.roots.map((r: { uri: string }) => r.uri));
      console.error(`[Roots] Initial workspace roots: ${result.roots.map((r: { uri: string }) => r.uri).join(', ') || '(none)'}`);
    })
    .catch(() => {
      console.error('[Roots] Client does not support roots/list; workspace context will use server CWD fallback');
    });

  // -------------------------------------------------------------------------
  // Shutdown hooks -- canonical pattern shared with http-entry.ts
  // -------------------------------------------------------------------------

  // stdio-specific: shut down when stdin closes (IDE disconnect).
  // The MCP SDK's StdioServerTransport does not listen for stdin 'end',
  // so server.onclose never fires on disconnect. Without this, the HTTP
  // server keeps the process alive after stdin EOF, blocking client restart.
  wireStdinShutdown();

  wireShutdownHooks({
    onBeforeTerminate: async () => {
      await ctx.httpServer?.stop();
    },
  });
}
