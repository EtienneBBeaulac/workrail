import { ServingAdmission } from './serving-admission.js';
import { createMcpHandler, isLegacyRequest, isJsonContentType } from '@modelcontextprotocol/server';
import { toWebRequest, toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
/**
 * HTTP transport entry point for WorkRail MCP server.
 * 
 * This is the bot service use case — connects over HTTP using the MCP SDK's
 * NodeStreamableHTTPServerTransport. No workspace roots (bot passes explicit
 * workspacePath on start_workflow).
 * 
 * Philosophy:
 * - Determinism: enableJsonResponse=true for simple request/response
 * - Fail-fast: port conflict throws immediately
 * - Validate at boundaries: HTTP and stdio use same composeServer()
 */

import { createTransportClose, drainBeforeTerminate } from './transport-lifetime.js';
import { composeServer } from '../server.js';
import { bindWithPortFallback } from './http-listener.js';
import { wireShutdownHooks } from './shutdown-hooks.js';
import { registerFatalHandlers, logStartup, registerGracefulShutdown } from './fatal-exit.js';
import * as crypto from 'crypto';
import express from 'express';

/** Inclusive upper bound for the HTTP port scan range. Scan starts at the requested port. */
const HTTP_PORT_SCAN_END = 3199;

export interface HttpServerHandle {
  readonly port: number;
  close(signal: AbortSignal): Promise<'closed' | 'incomplete' | 'failed'>;
}

export async function startHttpServer(port: number): Promise<HttpServerHandle> {
  // Register early — before composeServer() — so startup failures exit cleanly.
  registerFatalHandlers('http');
  logStartup('http', { port });

  const composed = await composeServer();
  const { ctx, closeRequests, closeDomain } = composed;
  const { server } = composed.createProtocolUnit();
  const admission = new ServingAdmission();
  // WorkRail exposes tools/resources, not subscription streams.
  const modern = createMcpHandler(() => composed.createProtocolUnit().server, { legacy: 'reject', maxSubscriptions: 0 });
  const modernRequest = toNodeHandler(modern);
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();

  // Scan from the requested port up to HTTP_PORT_SCAN_END so a second
  // concurrent WorkRail instance can bind to a different port rather than
  // failing hard. createHttpListener() itself stays fail-fast; the scan
  // policy lives here at the transport entry point where it belongs.
  const scanEnd = Math.max(port, HTTP_PORT_SCAN_END);
  const listener = await bindWithPortFallback(port, scanEnd);

  // Register graceful shutdown so that fatalExit() stops the MCP HTTP listener
  // cleanly before calling process.exit(1). The 3s timeout guarantees exit within a bounded window.
  const close = createTransportClose({
    closeRequests: async () => { await admission.close(); await closeRequests(); },
    stopListener: () => listener.stop(),
    closeProtocol: async () => { await modern.close(); await server.close(); },
    drainBackground: () => ctx.backgroundWork.close(new AbortController().signal),
    drainDomain: () => closeDomain(new AbortController().signal),
  });
  const shutdown = () => drainBeforeTerminate(close, AbortSignal.timeout(3000));
  registerGracefulShutdown(shutdown);
  wireShutdownHooks({ onBeforeTerminate: shutdown });

  const { NodeStreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/node'
  );

  const transport = new NodeStreamableHTTPServerTransport({
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
  listener.app.all('/mcp', async (req, res) => {
    if (req.method === 'POST' && !isJsonContentType(req.get('Content-Type'))) {
      res.status(415).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Content-Type must be application/json' } });
      return;
    }
    const outcome = await admission.serve(async () => {
      const probe = await toWebRequest(req, req.body);
      if (await isLegacyRequest(probe, req.body)) {
        await transport.handleRequest(req, res, req.body);
      } else if (validHost(req, res) && validOrigin(req, res)) {
        await modernRequest(req, res, req.body);
      }
    });
    if (outcome.kind === 'refused') {
      res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `Server unavailable: ${outcome.reason}` } });
    } else if (outcome.kind === 'failed') {
      console.error('[Transport]', outcome.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Transport request failed' } });
    }
  });

  await server.connect(transport);

  // Health endpoint — registered AFTER server.connect() so it only becomes
  // available once the MCP transport is fully ready.
  listener.app.get('/workrail-health', (_req, res) => {
    res.json({ service: 'workrail', pid: process.pid });
  });

  const boundPort = listener.getBoundPort();
  if (boundPort === null) throw new Error('MCP listener has no bound port');
  console.error('[Transport] WorkRail MCP Server running on HTTP');
  console.error(`[Transport] MCP endpoint: http://localhost:${boundPort}/mcp`);

  // -------------------------------------------------------------------------
  // HTTP mode: no workspace roots
  // Bot services pass explicit workspacePath on start_workflow.
  // The existing fallback chain (workspacePath > MCP roots > server CWD)
  // handles this correctly.
  // -------------------------------------------------------------------------

  return { close, port: boundPort };
}
