#!/usr/bin/env node
/**
 * MCP Server Entry Point
 *
 * Resolves transport mode from environment and starts the appropriate server.
 * 
 * Environment:
 * - WORKRAIL_TRANSPORT: 'stdio' (default) | 'http'
 * - WORKRAIL_HTTP_PORT: port for HTTP mode (default: 3100)
 */

import { resolveTransportMode } from './mcp/transports/transport-mode.js';
import { startStdioServer } from './mcp/transports/stdio-entry.js';
import { startHttpServer } from './mcp/transports/http-entry.js';
import { assertNever } from './runtime/assert-never.js';

// Public API: transport entry points
export { startStdioServer } from './mcp/transports/stdio-entry.js';
export { startHttpServer } from './mcp/transports/http-entry.js';
export { composeServer } from './mcp/server.js';

// Resolve transport mode and start
const mode = resolveTransportMode(process.env);

switch (mode.kind) {
  case 'stdio':
    startStdioServer().catch((error) => {
      console.error('[stdio] Fatal error:', error);
      process.exit(1);
    });
    break;

  case 'http':
    startHttpServer(mode.port).catch((error) => {
      console.error('[http] Fatal error:', error);
      process.exit(1);
    });
    break;

  default:
    assertNever(mode);
}
