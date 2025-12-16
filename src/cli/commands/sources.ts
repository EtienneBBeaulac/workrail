/**
 * Sources Command
 *
 * Shows workflow directory sources and their status.
 * Pure function with dependency injection.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkflowSource {
  readonly name: string;
  readonly path: string;
  readonly type: 'bundled' | 'user' | 'project' | 'custom';
  readonly description: string;
  readonly exists: boolean;
  readonly workflowCount?: number;
}

export interface SourcesCommandDeps {
  readonly resolvePath: (...paths: string[]) => string;
  readonly existsSync: (path: string) => boolean;
  readonly readdirSync: (path: string) => string[];
  readonly homedir: () => string;
  readonly cwd: () => string;
  readonly dirname: string;
  readonly pathDelimiter: string;
  readonly env: NodeJS.ProcessEnv;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get all workflow sources with their status.
 */
export function getWorkflowSources(deps: SourcesCommandDeps): readonly WorkflowSource[] {
  const sources: WorkflowSource[] = [
    {
      name: 'Bundled Workflows',
      path: deps.resolvePath(deps.dirname, '../workflows'),
      type: 'bundled',
      description: 'Pre-built workflows included with WorkRail',
      exists: false,
    },
    {
      name: 'User Workflows',
      path: deps.resolvePath(deps.homedir(), '.workrail', 'workflows'),
      type: 'user',
      description: 'Your personal workflow collection',
      exists: false,
    },
    {
      name: 'Project Workflows',
      path: deps.resolvePath(deps.cwd(), 'workflows'),
      type: 'project',
      description: 'Project-specific workflows',
      exists: false,
    },
  ];

  // Add custom paths from environment
  const envPaths = deps.env['WORKFLOW_STORAGE_PATH'];
  if (envPaths) {
    const customPaths = envPaths.split(deps.pathDelimiter);
    customPaths.forEach((customPath, index) => {
      sources.push({
        name: `Custom Path ${index + 1}`,
        path: deps.resolvePath(customPath.trim()),
        type: 'custom',
        description: 'Custom workflow directory',
        exists: false,
      });
    });
  }

  // Check existence and count workflows
  return sources.map((source) => {
    const exists = deps.existsSync(source.path);
    let workflowCount: number | undefined;

    if (exists) {
      try {
        const files = deps.readdirSync(source.path).filter((f) => f.endsWith('.json'));
        workflowCount = files.length;
      } catch {
        // Directory not readable
      }
    }

    return { ...source, exists, workflowCount };
  });
}

/**
 * Execute the sources command.
 */
export function executeSourcesCommand(deps: SourcesCommandDeps): CliResult {
  try {
    const sources = getWorkflowSources(deps);

    const details = sources.flatMap((source, index) => {
      const icon = source.exists ? '✅' : '❌';
      const status = source.exists ? 'Found' : 'Not found';
      const lines = [
        `${index + 1}. ${source.name} ${icon}`,
        `   Path: ${source.path}`,
        `   Status: ${status}`,
        `   ${source.description}`,
      ];

      if (source.exists && source.workflowCount !== undefined) {
        lines.push(`   Workflows: ${source.workflowCount} files`);
      }

      return lines;
    });

    return success({
      message: 'Workflow directory sources',
      details,
      suggestions: [
        'Run "workrail init" to create the user workflow directory',
        'Set WORKFLOW_STORAGE_PATH to add custom directories',
        'Use colon-separated paths for multiple custom directories',
      ],
    });
  } catch (error) {
    return failure(
      `Failed to check workflow sources: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
