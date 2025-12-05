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

startServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
