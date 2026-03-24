/**
 * stdio transport entry point for WorkRail MCP server.
 * 
 * This is the existing IDE/Firebender use case — connects to the agent
 * over stdin/stdout. Supports workspace roots via MCP roots/list protocol.
 */

import { composeServer } from '../server.js';
import { container } from '../../di/container.js';
import { DI } from '../../di/tokens.js';
import type { ShutdownEvents } from '../../runtime/ports/shutdown-events.js';
import type { ProcessSignals } from '../../runtime/ports/process-signals.js';
import type { ProcessTerminator } from '../../runtime/ports/process-terminator.js';

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
  // Shutdown hooks
  // -------------------------------------------------------------------------
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);
  const processSignals = container.resolve<ProcessSignals>(DI.Runtime.ProcessSignals);
  const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);

  // Signal handlers: standard for long-running processes
  processSignals.on('SIGINT', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGINT' }));
  processSignals.on('SIGTERM', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGTERM' }));
  processSignals.on('SIGHUP', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' }));

  // stdio-specific: Shut down when stdin closes (IDE disconnect).
  // The MCP SDK's StdioServerTransport does not listen for stdin 'end',
  // so server.onclose never fires on disconnect. Without this, the HTTP
  // server keeps the process alive after stdin EOF, blocking client restart.
  process.stdin.on('end', () => {
    console.error('[MCP] stdin closed, initiating shutdown');
    shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });

  // Shutdown handler
  let shutdownStarted = false;
  shutdownEvents.onShutdown((event) => {
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
