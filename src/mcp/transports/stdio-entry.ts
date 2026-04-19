/**
 * stdio transport entry point for WorkRail MCP server.
 * 
 * This is the existing IDE/Firebender use case — connects to the agent
 * over stdin/stdout. Supports workspace roots via MCP roots/list protocol.
 */

import { composeServer } from '../server.js';
import { wireShutdownHooks, wireStdinShutdown, wireStdoutShutdown } from './shutdown-hooks.js';
import { registerFatalHandlers, logStartup, registerGracefulShutdown } from './fatal-exit.js';

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
  // Register last-resort fatal handlers early — before any async work —
  // so that exceptions thrown during startup are caught and the process exits
  // cleanly rather than spinning in an infinite loop. See fatal-exit.ts.
  registerFatalHandlers('stdio');
  logStartup('stdio');

  const { server, ctx, rootsManager } = await composeServer();

  // Register graceful shutdown callback. The MCP stdio server owns no HTTP
  // infrastructure, so there is nothing to stop on fatal exit.
  registerGracefulShutdown(async () => {});

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
      try { process.stderr.write(`[Roots] Updated workspace roots: ${result.roots.map((r: { uri: string }) => r.uri).join(', ') || '(none)'}\n`); } catch { /* ignore */ }
    } catch {
      try { process.stderr.write('[Roots] Failed to fetch updated roots after change notification\n'); } catch { /* ignore */ }
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

  try { process.stderr.write('[Transport] WorkRail MCP Server running on stdio\n'); } catch { /* ignore */ }

  // -------------------------------------------------------------------------
  // stdio-specific: Fetch initial workspace roots from the IDE client
  // -------------------------------------------------------------------------
  void fetchInitialRootsWithTimeout(server)
    .then((result) => {
      if (result == null) {
        try { process.stderr.write('[Roots] Initial roots probe timed out; workspace context will use server CWD fallback\n'); } catch { /* ignore */ }
        return;
      }

      rootsManager.updateRootUris(result.roots.map((r: { uri: string }) => r.uri));
      try { process.stderr.write(`[Roots] Initial workspace roots: ${result.roots.map((r: { uri: string }) => r.uri).join(', ') || '(none)'}\n`); } catch { /* ignore */ }
    })
    .catch(() => {
      try { process.stderr.write('[Roots] Client does not support roots/list; workspace context will use server CWD fallback\n'); } catch { /* ignore */ }
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
      // The MCP stdio server owns no HTTP infrastructure; nothing to stop here.
    },
  });
}
