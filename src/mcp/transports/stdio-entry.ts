/**
 * stdio transport entry point for WorkRail MCP server.
 * 
 * This is the existing IDE/Firebender use case — connects to the agent
 * over stdin/stdout. Supports workspace roots via MCP roots/list protocol.
 */

import { createTransportClose, drainBeforeTerminate } from './transport-lifetime.js';
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

  const composed = await composeServer();
  const { server, ctx, closeRequests, closeDomain } = composed;
  let entry: import('@modelcontextprotocol/server/stdio').StdioServerHandle | undefined;

  const close = createTransportClose({
    closeRequests,
    stopListener: async () => { process.stdin.pause(); },
    closeProtocol: async () => { await entry?.close(); await server.close(); },
    drainBackground: () => ctx.backgroundWork.close(new AbortController().signal),
    drainDomain: () => closeDomain(new AbortController().signal),
  });
  const shutdown = () => drainBeforeTerminate(close, AbortSignal.timeout(3000));
  registerGracefulShutdown(shutdown);
  wireShutdownHooks({ onBeforeTerminate: shutdown });
  wireStdinShutdown();

  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  wireStdoutShutdown();
  entry = serveStdio(({ era }) => {
    const unit = composed.createProtocolUnit();
    if (era === 'legacy') {
      const updateRoots = async () => {
        try {
          const result = await fetchInitialRootsWithTimeout(unit.server);
          if (result !== null) unit.rootsManager.updateRootUris(result.roots.map(root => root.uri));
        } catch {
          try { process.stderr.write('[Roots] Client roots unavailable; workspace context will use server CWD fallback\n'); } catch { /* reporting is best-effort */ }
        }
      };
      unit.server.oninitialized = () => { void updateRoots(); };
      unit.server.setNotificationHandler('notifications/roots/list_changed', updateRoots);
    }
    return unit.server;
  }, { maxSubscriptions: 0, onerror: error => { try { process.stderr.write(`[Transport] ${error.message}\n`); } catch { /* reporting is best-effort */ } } });
  try { process.stderr.write('[Transport] WorkRail MCP Server running on stdio\n'); } catch { /* reporting is best-effort */ }
}
