/**
 * Cleanup Command
 *
 * Cleans up orphaned workrail processes and frees up ports.
 * Pure function with dependency injection.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CleanupCommandDeps {
  readonly fullCleanup: () => Promise<number>;
}

export interface CleanupCommandOptions {
  readonly force?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the cleanup command.
 */
export async function executeCleanupCommand(
  deps: CleanupCommandDeps,
  _options: CleanupCommandOptions = {}
): Promise<CliResult> {
  try {
    const count = await deps.fullCleanup();

    if (count > 0) {
      return success({
        message: `Cleaned up ${count} orphaned process(es)`,
      });
    }

    return success({
      message: 'No orphaned processes found',
    });
  } catch (error) {
    return failure(
      `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
