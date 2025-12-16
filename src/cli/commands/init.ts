/**
 * Init Command
 *
 * Initializes the user workflow directory with sample workflows.
 * Pure function with dependency injection.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════════

export interface InitCommandDeps {
  readonly mkdir: (path: string, options: { recursive: boolean }) => Promise<string | undefined>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly homedir: () => string;
  readonly joinPath: (...paths: string[]) => string;
}

// ═══════════════════════════════════════════════════════════════════════════
// SAMPLE WORKFLOW
// ═══════════════════════════════════════════════════════════════════════════

const SAMPLE_WORKFLOW = {
  id: 'my-custom-workflow',
  name: 'My Custom Workflow',
  description: 'A template for creating custom workflows',
  version: '1.0.0',
  steps: [
    {
      id: 'step-1',
      title: 'First Step',
      prompt: 'Replace this with your custom step',
      agentRole: 'You are helping the user with their custom workflow',
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the init command.
 */
export async function executeInitCommand(deps: InitCommandDeps): Promise<CliResult> {
  const userDir = deps.joinPath(deps.homedir(), '.workrail', 'workflows');

  try {
    // Create directory
    await deps.mkdir(userDir, { recursive: true });

    // Check if empty
    const entries = await deps.readdir(userDir);

    if (entries.length === 0) {
      // Write sample workflow
      const samplePath = deps.joinPath(userDir, 'my-custom-workflow.json');
      await deps.writeFile(samplePath, JSON.stringify(SAMPLE_WORKFLOW, null, 2));
    }

    return success({
      message: 'User workflow directory initialized',
      details: [
        `Directory: ${userDir}`,
        entries.length === 0
          ? 'Created sample workflow: my-custom-workflow.json'
          : `Found ${entries.length} existing file(s)`,
      ],
      suggestions: [
        'Edit the sample workflow in the directory above',
        'Create new workflow JSON files following the schema',
        'Run "workrail list" to see your workflows',
        'Use "workrail validate <file>" to check your workflow syntax',
      ],
    });
  } catch (error) {
    return failure(
      `Failed to initialize user workflow directory: ${error instanceof Error ? error.message : String(error)}`,
      {
        suggestions: ['Check that you have write permissions to your home directory'],
      }
    );
  }
}
