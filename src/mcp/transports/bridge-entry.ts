/**
 * Bridge transport entry point for WorkRail MCP server.
 *
 * When a healthy primary WorkRail server is already running on the MCP HTTP
 * port, secondary instances (firebender worktrees, additional Claude Code
 * sessions, any other IDE integration) start in bridge mode rather than
 * spinning up a full second server.
 *
 * The bridge is a thin, stateless stdio↔HTTP proxy:
 *   IDE/firebender (stdio) ←→ WorkRail bridge ←→ primary WorkRail (:3100)
 *
 * This gives true single-instance semantics: one server handles all workflow
 * sessions regardless of how many clients connect or which transport they use.
 * No lock contention, no kill races, no competing instances.
 *
 * Implementation: wire StdioServerTransport and StreamableHTTPClientTransport
 * together at the Transport interface level. Each side's onmessage routes to
 * the other side's send(). The SDK handles framing, SSE, and retries.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Milliseconds to wait for an HTTP response from the primary before logging a warning. */
const FORWARD_TIMEOUT_MS = 30_000;

export async function startBridgeServer(primaryPort: number): Promise<void> {
  const primaryUrl = new URL(`http://localhost:${primaryPort}/mcp`);
  console.error(`[Bridge] Forwarding stdio → ${primaryUrl.href}`);

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  const stdioTransport = new StdioServerTransport();
  const httpTransport = new StreamableHTTPClientTransport(primaryUrl);

  // ---- Error / close handlers ------------------------------------------------

  stdioTransport.onerror = (err) => {
    console.error('[Bridge] Stdio error:', err);
  };

  httpTransport.onerror = (err) => {
    console.error('[Bridge] HTTP error:', err);
  };

  httpTransport.onclose = () => {
    console.error('[Bridge] Primary closed connection, shutting down bridge');
    process.exit(0);
  };

  // ---- Message routing -------------------------------------------------------

  // IDE → primary
  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    const timer = setTimeout(() => {
      console.error('[Bridge] Warning: no response from primary after', FORWARD_TIMEOUT_MS, 'ms');
    }, FORWARD_TIMEOUT_MS);

    void httpTransport.send(msg)
      .catch((err) => console.error('[Bridge] Forward to primary failed:', err))
      .finally(() => clearTimeout(timer));
  };

  // Primary → IDE
  httpTransport.onmessage = (msg: JSONRPCMessage) => {
    void stdioTransport.send(msg).catch((err) => {
      console.error('[Bridge] Forward to IDE failed:', err);
    });
  };

  // ---- Connect ---------------------------------------------------------------

  // Connect to the primary first so we are ready to forward before accepting
  // messages from the IDE client.
  await httpTransport.start();
  console.error('[Bridge] Connected to primary');

  // Guard stdout before wiring stdio (same rationale as stdio-entry.ts).
  process.stdout.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      console.error('[Bridge] stdout pipe broken, shutting down');
    } else {
      console.error('[Bridge] stdout error:', err);
    }
    void httpTransport.close().finally(() => process.exit(0));
  });

  await stdioTransport.start();
  console.error('[Bridge] WorkRail MCP bridge running on stdio');

  // ---- Shutdown hooks --------------------------------------------------------
  // Bridge is intentionally lightweight — no DI container, no HttpServer.
  // Simple signal and stdin-EOF handling is sufficient.

  process.stdin.once('end', () => {
    console.error('[Bridge] stdin closed, shutting down');
    void httpTransport.close().finally(() => process.exit(0));
  });

  const shutdown = (signal: string) => {
    console.error(`[Bridge] Received ${signal}, shutting down`);
    void httpTransport.close().finally(() => process.exit(0));
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));
}
