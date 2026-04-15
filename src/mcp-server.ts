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
 *
 * Zombie-bridge guard: when an MCP client uses `type: http` with a `command`
 * field, Claude Code spawns the command to auto-start the server but then
 * communicates via HTTP — stdin of the command process stays empty. Without
 * the guard, those processes would start in bridge mode and hold idle HTTP
 * sessions against the primary, overloading it with N concurrent sessions.
 * The guard probes stdin briefly before committing to bridge mode: processes
 * that receive no MCP data exit cleanly instead of becoming zombie bridges.
 */

import { resolveTransportMode } from './mcp/transports/transport-mode.js';
import { startStdioServer } from './mcp/transports/stdio-entry.js';
import { startHttpServer } from './mcp/transports/http-entry.js';
import {
  startBridgeServer,
  detectHealthyPrimary,
} from './mcp/transports/bridge-entry.js';
import { assertNever } from './runtime/assert-never.js';

// Public API: transport entry points
export { startStdioServer } from './mcp/transports/stdio-entry.js';
export { startHttpServer } from './mcp/transports/http-entry.js';
export { startBridgeServer, detectHealthyPrimary } from './mcp/transports/bridge-entry.js';
export { composeServer } from './mcp/server.js';

/** Default MCP HTTP transport port. */
const DEFAULT_MCP_PORT = 3100;

/**
 * How long to wait for stdin data before concluding there is no real MCP
 * client connected to this process (ms). A real stdio MCP client sends its
 * `initialize` request within ~50ms; 150ms gives comfortable margin.
 */
const STDIO_CLIENT_PROBE_MS = 150;

/**
 * Wait up to `timeoutMs` for `stdin` to become readable without consuming data.
 *
 * Uses the `readable` event so the stream stays paused — bytes remain in the
 * buffer for the MCP transport to read once it starts. Returns true if data
 * arrives within the window, false on timeout.
 *
 * `timeoutMs` and `stdin` are explicit parameters (not hardcoded globals) so
 * tests can pass 0ms and a fake stream without real-time delays or process
 * coupling. Production callers use STDIO_CLIENT_PROBE_MS and process.stdin.
 */
export function waitForStdinReadable(
  timeoutMs: number,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<boolean> {
  return new Promise((resolve) => {
    stdin.pause(); // prevent accidental drain while probing

    const timer = setTimeout(() => {
      stdin.removeListener('readable', onReadable);
      resolve(false);
    }, timeoutMs);

    const onReadable = () => {
      clearTimeout(timer);
      stdin.removeListener('readable', onReadable);
      resolve(true);
    };

    stdin.once('readable', onReadable);
  });
}

async function main(): Promise<void> {
  const mode = resolveTransportMode(process.env);

  // Auto-bridge: stdio instances yield to a running primary rather than
  // starting a competing full server.
  if (mode.kind === 'stdio') {
    const primaryPort = await detectHealthyPrimary(DEFAULT_MCP_PORT);
    if (primaryPort != null) {
      // Zombie-bridge guard: probe stdin before starting the bridge.
      // A real stdio client (Claude Code stdio, firebender) sends MCP data
      // immediately. An HTTP-type `command` helper never writes to stdin.
      // Without this check, N command helpers become N idle bridges and
      // overload the primary.
      const hasClient = await waitForStdinReadable(STDIO_CLIENT_PROBE_MS, process.stdin);
      if (!hasClient) {
        console.error(
          `[Startup] Primary on :${primaryPort}, no stdio client within ${STDIO_CLIENT_PROBE_MS}ms — exiting`,
        );
        process.exit(0);
      }

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
