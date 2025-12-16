/**
 * Start Command
 *
 * Starts the MCP server.
 * Pure function with dependency injection.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface RpcServer {
  start(): Promise<void>;
}

export interface StartCommandDeps {
  readonly createServer: () => RpcServer;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the start command.
 * Note: This starts a long-running server, so it doesn't return success in the normal flow.
 */
export async function executeStartCommand(deps: StartCommandDeps): Promise<CliResult> {
  try {
    const server = deps.createServer();
    await server.start();

    // Server is running - this won't be reached in normal operation
    // as the server keeps running until terminated
    return success({
      message: 'MCP server started',
    });
  } catch (error) {
    return failure(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
