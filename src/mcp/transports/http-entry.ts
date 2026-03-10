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
import { createHttpListener } from './http-listener.js';
import { container } from '../../di/container.js';
import { DI } from '../../di/tokens.js';
import type { ShutdownEvents } from '../../runtime/ports/shutdown-events.js';
import type { ProcessSignals } from '../../runtime/ports/process-signals.js';
import type { ProcessTerminator } from '../../runtime/ports/process-terminator.js';
import * as crypto from 'crypto';
import express from 'express';

export async function startHttpServer(port: number): Promise<void> {
  const { server, ctx } = await composeServer();
  const listener = createHttpListener(port);

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
  listener.app.use(express.json());
  listener.app.post('/mcp', (req, res) => transport.handleRequest(req, res, req.body));
  listener.app.get('/mcp', (req, res) => transport.handleRequest(req, res));
  listener.app.delete('/mcp', (req, res) => transport.handleRequest(req, res));

  await listener.start();
  await server.connect(transport);

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
  // Shutdown hooks (long-running server, like stdio)
  // -------------------------------------------------------------------------
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);
  const processSignals = container.resolve<ProcessSignals>(DI.Runtime.ProcessSignals);
  const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);

  // Signal handlers: standard for long-running processes
  processSignals.on('SIGINT', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGINT' }));
  processSignals.on('SIGTERM', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGTERM' }));
  processSignals.on('SIGHUP', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' }));

  // Shutdown handler
  let shutdownStarted = false;
  shutdownEvents.onShutdown((event) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    void (async () => {
      try {
        console.error(`[Shutdown] Requested by ${event.signal}. Stopping services...`);
        await listener.stop();
        await ctx.httpServer?.stop();
        terminator.terminate({ kind: 'success' });
      } catch (err) {
        console.error('[Shutdown] Error while stopping services:', err);
        terminator.terminate({ kind: 'failure' });
      }
    })();
  });
}
