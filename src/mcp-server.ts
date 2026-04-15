#!/usr/bin/env node
/**
 * MCP Server Entry Point
 *
 * Resolves transport mode from environment and starts the appropriate server.
 *
 * Environment:
 * - WORKRAIL_TRANSPORT: 'stdio' (default) | 'http'
 * - WORKRAIL_HTTP_PORT: port for HTTP mode (default: 3100)
 *
 * Auto-bridge: when stdio mode is requested and a healthy primary WorkRail
 * server is already running on the MCP HTTP port, this process starts in
 * bridge mode instead of spinning up a full second server. The bridge forwards
 * JSON-RPC between the IDE's stdio connection and the primary's HTTP endpoint,
 * giving true single-instance semantics across all clients and integrations.
 */

import { resolveTransportMode } from './mcp/transports/transport-mode.js';
import { startStdioServer } from './mcp/transports/stdio-entry.js';
import { startHttpServer } from './mcp/transports/http-entry.js';
import { startBridgeServer } from './mcp/transports/bridge-entry.js';
import { assertNever } from './runtime/assert-never.js';

// Public API: transport entry points
export { startStdioServer } from './mcp/transports/stdio-entry.js';
export { startHttpServer } from './mcp/transports/http-entry.js';
export { startBridgeServer } from './mcp/transports/bridge-entry.js';
export { composeServer } from './mcp/server.js';

/** Default MCP HTTP transport port. */
const DEFAULT_MCP_PORT = 3100;

/**
 * Check whether a healthy WorkRail MCP server is already accepting connections
 * on the given port. Returns the port if healthy, null otherwise.
 *
 * Uses a short-lived GET to /mcp — the StreamableHTTPServerTransport handles
 * GET requests (SSE stream setup), so a successful response with any HTTP
 * status code (including 4xx) confirms WorkRail is listening. Connection
 * refused or a network error means nothing is there.
 */
async function detectHealthyPrimary(port: number): Promise<number | null> {
  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      method: 'GET',
      signal: AbortSignal.timeout(500),
      headers: { Accept: 'application/json, text/event-stream' },
    });
    // Cancel any SSE stream immediately — we only needed the response headers.
    await response.body?.cancel().catch(() => undefined);
    // Any HTTP response means a server is listening on this port.
    return port;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const mode = resolveTransportMode(process.env);

  // Auto-bridge: stdio instances yield to a running primary rather than
  // starting a competing full server.
  if (mode.kind === 'stdio') {
    const primaryPort = await detectHealthyPrimary(DEFAULT_MCP_PORT);
    if (primaryPort != null) {
      console.error(`[Startup] Primary detected on :${primaryPort} — starting in bridge mode`);
      try {
        await startBridgeServer(primaryPort);
      } catch (error) {
        // Bridge failed to connect. Fall back to a full server so the IDE
        // client isn't left without a WorkRail connection.
        console.error('[Bridge] Fatal error, falling back to full stdio server:', error);
        await startStdioServer();
      }
      return;
    }
  }

  switch (mode.kind) {
    case 'stdio':
      await startStdioServer();
      break;

    case 'http':
      await startHttpServer(mode.port);
      break;

    default:
      assertNever(mode);
  }
}

main().catch((error) => {
  console.error('[Startup] Fatal error:', error);
  process.exit(1);
});
