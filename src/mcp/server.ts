/**
 * MCP Server Composition Root
 *
 * This module is the entry point for the WorkRail MCP server.
 * It wires together:
 * - McpServer from the SDK
 * - Tool definitions
 * - Handler functions
 * - DI container
 *
 * Implementation pending Phase 4.
 */

import type { ToolContext } from './types.js';

/**
 * Create the tool context from DI container.
 * This provides dependencies to all handlers.
 */
export function createToolContext(): ToolContext {
  throw new Error('Not implemented - Phase 4');
}

/**
 * Start the MCP server.
 * This is the main entry point.
 */
export async function startServer(): Promise<void> {
  throw new Error('Not implemented - Phase 4');
}
