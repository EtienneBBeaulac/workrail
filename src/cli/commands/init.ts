/**
 * Init Command
 *
 * Initializes the user workflow directory with sample workflows,
 * or (with --config flag) generates a ~/.workrail/config.json template.
 * Pure functions with dependency injection.
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

export interface InitConfigCommandDeps {
  readonly mkdir: (path: string, options: { recursive: boolean }) => Promise<string | undefined>;
  readonly readFile: (path: string) => Promise<string>;
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

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG FILE TEMPLATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Template written by `workrail init --config`.
 *
 * All entries are commented out with their default values shown.
 * Users uncomment and set the keys they want to override.
 */
const CONFIG_FILE_TEMPLATE = `{
  "_comment": "WorkRail configuration file. Uncomment any key to override its default.",
  "_docs": "Full reference: https://github.com/exaudeus/workrail/blob/main/docs/configuration.md",

  "CACHE_TTL": "300000",
  "WORKRAIL_WORKFLOWS_DIR": "",
  "WORKRAIL_DISABLE_UNIFIED_DASHBOARD": "0",
  "WORKRAIL_DISABLE_AUTO_OPEN": "0",
  "WORKRAIL_DASHBOARD_PORT": "3456",

  "WORKRAIL_ENABLE_SESSION_TOOLS": "true",
  "WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS": "false",
  "WORKRAIL_VERBOSE_LOGGING": "false",
  "WORKRAIL_ENABLE_AGENTIC_ROUTINES": "true",
  "WORKRAIL_ENABLE_LEAN_WORKFLOWS": "false",
  "WORKRAIL_AUTHORITATIVE_DESCRIPTIONS": "false",
  "WORKRAIL_ENABLE_V2_TOOLS": "true",
  "WORKRAIL_CLEAN_RESPONSE_FORMAT": "false",

  "WORKFLOW_STORAGE_PATH": "",
  "WORKFLOW_GIT_REPOS": "",
  "WORKFLOW_GIT_REPO_URL": "",
  "WORKFLOW_GIT_REPO_BRANCH": "main",
  "WORKFLOW_GIT_SYNC_INTERVAL": "60",

  "WORKRAIL_LOG_LEVEL": "SILENT",
  "WORKRAIL_LOG_FORMAT": "human",
  "WORKRAIL_DATA_DIR": "",
  "WORKRAIL_CACHE_DIR": "",

  "WORKRAIL_JSON_RESPONSES": "false"
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the `init --config` subcommand.
 *
 * - If ~/.workrail/config.json does not exist, write the template and report.
 * - If it already exists, print its current contents and exit without overwriting.
 */
export async function executeInitConfigCommand(deps: InitConfigCommandDeps): Promise<CliResult> {
  const configDir = deps.joinPath(deps.homedir(), '.workrail');
  const configPath = deps.joinPath(configDir, 'config.json');

  // Check if the file already exists by attempting to read it.
  try {
    const existing = await deps.readFile(configPath);
    return success({
      message: `Config file already exists at ${configPath}`,
      details: [
        'Current contents:',
        existing,
        '(File was not modified. Delete it and re-run to regenerate the template.)',
      ],
    });
  } catch {
    // File does not exist (or is not readable) -- write the template.
  }

  try {
    await deps.mkdir(configDir, { recursive: true });
    await deps.writeFile(configPath, CONFIG_FILE_TEMPLATE);
    return success({
      message: `Config file written to ${configPath}`,
      details: [
        'Edit the file to set your preferred defaults.',
        'Environment variables always override values in this file.',
        'Sensitive values (tokens, keys) must still be set as environment variables.',
      ],
      suggestions: [
        `Edit: ${configPath}`,
        'Documentation: workrail docs configuration',
      ],
    });
  } catch (error) {
    return failure(
      `Failed to write config file: ${error instanceof Error ? error.message : String(error)}`,
      {
        suggestions: ['Check that you have write permissions to your home directory'],
      }
    );
  }
}
