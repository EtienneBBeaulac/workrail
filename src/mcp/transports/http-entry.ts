/**
 * HTTP transport entry point for WorkRail MCP server.
 * 
 * This is the bot service use case — connects over HTTP using the MCP SDK's
 * StreamableHTTPServerTransport. No workspace roots (bot passes explicit
 * workspacePath on start_workflow).
 * 
 * Philosophy:
 * - Determinism: enableJsonResponse=true for simple request/response
 * - Fail-fast: port conflict throws immediately
 * - Validate at boundaries: HTTP and stdio use same composeServer()
 */

import { composeServer } from '../server.js';
import { bindWithPortFallback } from './http-listener.js';
import { wireShutdownHooks } from './shutdown-hooks.js';
import { registerFatalHandlers, logStartup, registerGracefulShutdown } from './fatal-exit.js';
import * as crypto from 'crypto';
import express from 'express';

/** Inclusive upper bound for the HTTP port scan range. Scan starts at the requested port. */
const HTTP_PORT_SCAN_END = 3199;

export async function startHttpServer(port: number): Promise<void> {
  // Register early — before composeServer() — so startup failures exit cleanly.
  registerFatalHandlers('http');
  logStartup('http', { port });

  const { server, ctx } = await composeServer();

  // Scan from the requested port up to HTTP_PORT_SCAN_END so a second
  // concurrent WorkRail instance can bind to a different port rather than
  // failing hard. createHttpListener() itself stays fail-fast; the scan
  // policy lives here at the transport entry point where it belongs.
  const scanEnd = Math.max(port, HTTP_PORT_SCAN_END);
  const listener = await bindWithPortFallback(port, scanEnd);

  // Register graceful shutdown so that fatalExit() stops the MCP HTTP listener
  // cleanly before calling process.exit(1). The 3s timeout guarantees exit within a bounded window.
  registerGracefulShutdown(async () => {
    await listener.stop();
  });

  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true, // Simple request/response, not SSE streaming
  });

  // -------------------------------------------------------------------------
  // Mount MCP protocol handlers at /mcp
  // -------------------------------------------------------------------------
  // The SDK's handleRequest takes (req, res, parsedBody).
  // Express body-parser makes the parsed body available on req.body.
  // Routes are registered on the Express app after the port is bound.
  // Express dispatches by app-level routing, not by listen order, so
  // registering routes on an already-started server is safe.
  listener.app.use(express.json());
  listener.app.post('/mcp', (req, res) => transport.handleRequest(req, res, req.body));
  listener.app.get('/mcp', (req, res) => transport.handleRequest(req, res));
  listener.app.delete('/mcp', (req, res) => transport.handleRequest(req, res));

  await server.connect(transport);

  // Health endpoint — registered AFTER server.connect() so it only becomes
  // available once the MCP transport is fully ready.
  listener.app.get('/workrail-health', (_req, res) => {
    res.json({ service: 'workrail', pid: process.pid });
  });

  const boundPort = listener.getBoundPort();
  console.error('[Transport] WorkRail MCP Server running on HTTP');
  console.error(`[Transport] MCP endpoint: http://localhost:${boundPort}/mcp`);

  // -------------------------------------------------------------------------
  // HTTP mode: no workspace roots
  // Bot services pass explicit workspacePath on start_workflow.
  // The existing fallback chain (workspacePath > MCP roots > server CWD)
  // handles this correctly.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Shutdown hooks (shared)
  // -------------------------------------------------------------------------
  wireShutdownHooks({
    onBeforeTerminate: async () => {
      await listener.stop();
    },
  });
}
