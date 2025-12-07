#!/usr/bin/env node
/**
 * MCP Server Entry Point
 *
 * This file exists for backwards compatibility with the bin entry in package.json.
 * All implementation has been moved to src/mcp/server.ts.
 */

export { startServer } from './mcp/server.js';

// Re-export and run
import { startServer } from './mcp/server.js';
import { getBootstrapLogger } from './core/logging/index.js';

const logger = getBootstrapLogger();

startServer().catch((error) => {
  logger.fatal({ err: error }, 'Fatal error running server');
  process.exit(1);
});
