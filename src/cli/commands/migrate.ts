/**
 * Workflow Migration Command
 *
 * Migrates workflows from v0.0.1 to v0.1.0.
 * Pure functions with discriminated union results.
 */

import type { WorkflowDefinition } from '../../types/workflow-definition.js';
import type { CliResult } from '../types/cli-result.js';
import { failure, success } from '../types/cli-result.js';
import { validateWorkflow } from '../../application/validation.js';
import semver from 'semver';

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION RESULT TYPE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of a workflow migration operation.
 * Discriminated union - no booleans.
 *
 * Note: Uses WorkflowDefinition (the raw JSON structure), not Workflow (runtime type).
 */
export type MigrationResult =
  | {
      kind: 'migrated';
      originalVersion: string;
      targetVersion: string;
      changes: readonly string[];
      warnings: readonly string[];
      workflow: WorkflowDefinition;
    }
  | {
      kind: 'already_current';
      version: string;
      workflow: WorkflowDefinition;
    }
  | {
      kind: 'cannot_downgrade';
      originalVersion: string;
      targetVersion: string;
    }
  | {
      kind: 'invalid_workflow';
      errors: readonly string[];
    }
  | {
      kind: 'migration_error';
      message: string;
    };

/**
 * Result of a file migration operation.
 */
export type FileMigrationResult =
  | {
      kind: 'file_migrated';
      migration: Extract<MigrationResult, { kind: 'migrated' }>;
      outputPath: string;
      backupPath?: string;
    }
  | {
      kind: 'file_already_current';
      migration: Extract<MigrationResult, { kind: 'already_current' }>;
    }
  | {
      kind: 'dry_run';
      migration: Extract<MigrationResult, { kind: 'migrated' | 'already_current' }>;
    }
  | {
      kind: 'file_read_error';
      message: string;
    }
  | {
      kind: 'file_parse_error';
      message: string;
    }
  | {
      kind: 'file_write_error';
      message: string;
    }
  | {
      kind: 'backup_error';
      message: string;
    }
  | {
      kind: 'migration_failed';
      migration: Exclude<MigrationResult, { kind: 'migrated' | 'already_current' }>;
    };

// ═══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

const TARGET_VERSION = '0.1.0';

/**
 * Detect the version of a workflow.
 */
export function detectWorkflowVersion(workflow: unknown): string {
  if (typeof workflow !== 'object' || workflow === null) {
    return '0.0.1';
  }

  const w = workflow as Record<string, unknown>;

  // Explicit version
  if (typeof w.version === 'string') {
    return w.version;
  }

  // Check for loop features (v0.1.0+)
  if (Array.isArray(w.steps)) {
    const hasLoop = w.steps.some(
      (step: unknown) =>
        typeof step === 'object' &&
        step !== null &&
        (step as Record<string, unknown>).type === 'loop'
    );
    if (hasLoop) {
      return '0.1.0';
    }
  }

  // Default to v0.0.1
  return '0.0.1';
}

/**
 * Migrate a workflow from v0.0.1 to v0.1.0.
 * Pure function - no side effects.
 */
export function migrateWorkflow(workflow: unknown): MigrationResult {
  const originalVersion = detectWorkflowVersion(workflow);

  // Check if migration is needed
  if (semver.eq(originalVersion, TARGET_VERSION)) {
    return {
      kind: 'already_current',
      version: TARGET_VERSION,
      workflow: workflow as WorkflowDefinition,
    };
  }

  if (semver.gt(originalVersion, TARGET_VERSION)) {
    return {
      kind: 'cannot_downgrade',
      originalVersion,
      targetVersion: TARGET_VERSION,
    };
  }

  try {
    // Create a deep copy
    const migrated = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;

    const changes: string[] = [];
    const warnings: string[] = [];

    // Apply v0.0.1 to v0.1.0 migration
    if (originalVersion === '0.0.1') {
      // Add version field
      if (!migrated.version) {
        migrated.version = TARGET_VERSION;
        changes.push(`Added version field: ${TARGET_VERSION}`);
      }

      // Check for potential loop-like patterns
      if (Array.isArray(migrated.steps)) {
        (migrated.steps as Array<Record<string, unknown>>).forEach((step) => {
          const stepId = String(step.id ?? 'unknown');
          const loopKeywords = ['repeat', 'iterate', 'loop', 'while', 'until', 'for each', 'foreach'];
          const prompt = String(step.prompt ?? '').toLowerCase();
          const guidanceText = Array.isArray(step.guidance)
            ? (step.guidance as string[]).join(' ').toLowerCase()
            : String(step.guidance ?? '').toLowerCase();

          const hasLoopKeyword = loopKeywords.some(
            (keyword) => prompt.includes(keyword) || guidanceText.includes(keyword)
          );

          if (hasLoopKeyword) {
            warnings.push(
              `Step '${stepId}' contains loop-related keywords. ` +
                `Consider refactoring to use the new loop feature.`
            );
          }

          // Look for manual iteration patterns
          const iterationPattern = /step\s+\d+\s+of\s+\d+/i;
          if (iterationPattern.test(prompt) || iterationPattern.test(guidanceText)) {
            warnings.push(
              `Step '${stepId}' appears to implement manual iteration. ` +
                `This could be simplified using a 'for' or 'forEach' loop.`
            );
          }
        });
      }

      // Ensure required fields
      const errors: string[] = [];
      if (!migrated.id) errors.push('Workflow must have an id');
      if (!migrated.name) errors.push('Workflow must have a name');
      if (!migrated.steps || !Array.isArray(migrated.steps)) {
        errors.push('Workflow must have a steps array');
      }

      if (errors.length > 0) {
        return { kind: 'invalid_workflow', errors };
      }
    }

    // Validate the migrated workflow
    const validation = validateWorkflow(migrated);
    if (!validation.valid) {
      return { kind: 'invalid_workflow', errors: validation.errors };
    }

    return {
      kind: 'migrated',
      originalVersion,
      targetVersion: TARGET_VERSION,
      changes,
      warnings,
      workflow: migrated as unknown as WorkflowDefinition,
    };
  } catch (error) {
    return {
      kind: 'migration_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE OPERATIONS (with dependency injection)
// ═══════════════════════════════════════════════════════════════════════════

export interface MigrateFileDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly copyFile: (src: string, dest: string) => Promise<void>;
}

export interface MigrateFileOptions {
  readonly outputPath?: string;
  readonly dryRun?: boolean;
  readonly backup?: boolean;
}

/**
 * Migrate a workflow file.
 */
export async function migrateWorkflowFile(
  inputPath: string,
  options: MigrateFileOptions,
  deps: MigrateFileDeps
): Promise<FileMigrationResult> {
  // Read file
  let content: string;
  try {
    content = await deps.readFile(inputPath);
  } catch (error) {
    return {
      kind: 'file_read_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Parse JSON
  let workflow: unknown;
  try {
    workflow = JSON.parse(content);
  } catch (error) {
    return {
      kind: 'file_parse_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Migrate
  const migration = migrateWorkflow(workflow);

  // Handle non-success migrations
  if (migration.kind === 'cannot_downgrade' ||
      migration.kind === 'invalid_workflow' ||
      migration.kind === 'migration_error') {
    return { kind: 'migration_failed', migration };
  }

  // Handle dry run
  if (options.dryRun) {
    return { kind: 'dry_run', migration };
  }

  // Already current - no write needed
  if (migration.kind === 'already_current') {
    return { kind: 'file_already_current', migration };
  }

  // Determine output path
  const finalOutputPath = options.outputPath ?? inputPath;

  // Create backup if needed
  let backupPath: string | undefined;
  if (options.backup && finalOutputPath === inputPath) {
    backupPath = `${inputPath}.backup.${Date.now()}`;
    try {
      await deps.copyFile(inputPath, backupPath);
    } catch (error) {
      return {
        kind: 'backup_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Write migrated file
  try {
    const output = JSON.stringify(migration.workflow, null, 2);
    await deps.writeFile(finalOutputPath, output);
  } catch (error) {
    return {
      kind: 'file_write_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    kind: 'file_migrated',
    migration,
    outputPath: finalOutputPath,
    backupPath,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI COMMAND
// ═══════════════════════════════════════════════════════════════════════════

export interface MigrateCommandOptions {
  readonly output?: string;
  readonly dryRun?: boolean;
  readonly backup?: boolean;
}

/**
 * Execute the migrate command.
 * Returns CliResult for composition root to interpret.
 */
export async function executeMigrateCommand(
  filePath: string,
  options: MigrateCommandOptions,
  deps: MigrateFileDeps
): Promise<CliResult> {
  const result = await migrateWorkflowFile(
    filePath,
    {
      outputPath: options.output,
      dryRun: options.dryRun,
      backup: options.backup,
    },
    deps
  );

  switch (result.kind) {
    case 'file_migrated': {
      const m = result.migration;
      const details = [
        `Original version: ${m.originalVersion}`,
        `Target version: ${m.targetVersion}`,
        ...m.changes.map((c) => `Change: ${c}`),
        `Output: ${result.outputPath}`,
      ];
      if (result.backupPath) {
        details.push(`Backup: ${result.backupPath}`);
      }
      return success({
        message: 'Migration completed successfully',
        details,
        warnings: m.warnings.length > 0 ? m.warnings : undefined,
      });
    }

    case 'file_already_current':
      return success({
        message: `Workflow is already at version ${result.migration.version}`,
      });

    case 'dry_run': {
      const m = result.migration;
      if (m.kind === 'already_current') {
        return success({
          message: `[DRY RUN] Workflow is already at version ${m.version}`,
        });
      }
      return success({
        message: '[DRY RUN] Migration would succeed',
        details: [
          `Original version: ${m.originalVersion}`,
          `Target version: ${m.targetVersion}`,
          ...m.changes.map((c) => `Would change: ${c}`),
        ],
        warnings: m.warnings.length > 0 ? m.warnings : undefined,
      });
    }

    case 'file_read_error':
      return failure(`Failed to read file: ${result.message}`, {
        suggestions: ['Check that the file exists and is readable'],
      });

    case 'file_parse_error':
      return failure(`Invalid JSON: ${result.message}`, {
        suggestions: ['Check the JSON syntax in the file'],
      });

    case 'file_write_error':
      return failure(`Failed to write file: ${result.message}`, {
        suggestions: ['Check file permissions and disk space'],
      });

    case 'backup_error':
      return failure(`Failed to create backup: ${result.message}`, {
        suggestions: ['Check file permissions'],
      });

    case 'migration_failed': {
      const m = result.migration;
      switch (m.kind) {
        case 'cannot_downgrade':
          return failure(
            `Cannot downgrade from version ${m.originalVersion} to ${m.targetVersion}`
          );

        case 'invalid_workflow':
          return failure('Workflow validation failed', {
            details: m.errors,
          });

        case 'migration_error':
          return failure(`Migration failed: ${m.message}`);
      }
    }
  }
}
