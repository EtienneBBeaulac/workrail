/**
 * Version Command
 *
 * Prints the current WorkRail version from package.json.
 * Pure function with dependency injection.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface VersionCommandDeps {
  readonly getVersion: () => string;
  readonly print: (message: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the version command.
 * Prints "WorkRail v<version>" to stdout and returns a no-output success.
 */
export function executeVersionCommand(deps: VersionCommandDeps): CliResult {
  try {
    const version = deps.getVersion();
    deps.print(`WorkRail v${version}`);
    return success();
  } catch (error) {
    return failure(
      `Failed to read version: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
