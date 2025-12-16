/**
 * List Command
 *
 * Lists all available workflows from all sources.
 * Pure function with dependency injection.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';
import type { WorkflowSummary } from '../../types/workflow.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ListCommandDeps {
  readonly listWorkflowSummaries: () => Promise<readonly WorkflowSummary[]>;
}

export interface ListCommandOptions {
  readonly verbose?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the list command.
 */
export async function executeListCommand(
  deps: ListCommandDeps,
  options: ListCommandOptions = {}
): Promise<CliResult> {
  try {
    const workflows = await deps.listWorkflowSummaries();

    if (workflows.length === 0) {
      return success({
        message: 'No workflows found',
        suggestions: ['Run "workrail init" to create your first workflow'],
      });
    }

    const details = workflows.flatMap((workflow, index) => {
      const lines = [
        `${index + 1}. ${workflow.name}`,
        `   ID: ${workflow.id}`,
        `   ${workflow.description}`,
      ];

      if (options.verbose) {
        lines.push(`   Version: ${workflow.version}`);
      }

      return lines;
    });

    details.push(``, `Total: ${workflows.length} workflows`);

    return success({
      message: 'Available workflows',
      details,
    });
  } catch (error) {
    return failure(
      `Failed to list workflows: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
