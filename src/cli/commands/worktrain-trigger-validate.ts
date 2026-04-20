/**
 * WorkTrain Trigger Validate Command
 *
 * `worktrain trigger validate` -- static analysis of triggers.yml without running anything.
 * Prints a per-trigger health report with named issues. Exits 1 if any error-severity issues.
 *
 * Design invariants:
 * - STATIC ANALYSIS INVARIANT: this command NEVER dispatches sessions, makes network calls,
 *   or modifies the config file. It only reads and validates.
 * - All I/O is injected via WorktrainTriggerValidateDeps. Zero direct fs/fetch imports.
 * - Exit 0 if no error-severity issues (warnings and info are OK).
 * - Exit 1 if any error-severity issues.
 */

import * as path from 'node:path';
import type { TriggerConfig, TriggerDefinition, TriggerValidationIssue } from '../../trigger/types.js';
import type { TriggerStoreError } from '../../trigger/trigger-store.js';
import { validateTriggerStrict } from '../../trigger/trigger-store.js';
import type { Result } from '../../runtime/result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Injected dependencies for the trigger validate command.
 * All real I/O is behind these interfaces for full testability.
 */
export interface WorktrainTriggerValidateDeps {
  /**
   * Load the trigger config from the given directory path.
   * The function appends 'triggers.yml' to the directory path internally.
   * Returns a TriggerConfig or a TriggerStoreError.
   * WHY injectable: allows tests to inject any trigger config without real files.
   */
  readonly loadTriggerConfigFromFile: (dirPath: string) => Promise<Result<TriggerConfig, TriggerStoreError>>;
  /**
   * Write to stdout.
   * WHY injectable: allows tests to capture all output for assertion.
   */
  readonly stdout: { write(s: string): void };
  /**
   * Write to stderr (errors).
   * WHY injectable: allows tests to capture error output separately.
   */
  readonly stderr: { write(s: string): void };
  /**
   * Exit the process with the given code.
   * WHY injectable: allows tests to capture the exit code instead of killing the process.
   */
  readonly exit: (code: number) => never;
  /**
   * The resolved path to the triggers.yml file.
   * The command will pass path.dirname(configFilePath) to loadTriggerConfigFromFile.
   */
  readonly configFilePath: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the trigger validate command.
 *
 * Loads the config, validates all triggers, prints the per-trigger health report,
 * and exits with the appropriate code.
 * Exit 0 = no error-severity issues (warnings/info are OK).
 * Exit 1 = any error-severity issues, OR config file not found, OR parse error.
 */
export async function executeWorktrainTriggerValidateCommand(
  deps: WorktrainTriggerValidateDeps,
): Promise<void> {
  const configFilePath = deps.configFilePath;
  const configDirPath = path.dirname(configFilePath);

  deps.stdout.write(`WorkTrain Trigger Validation\n`);
  deps.stdout.write(`Config: ${configFilePath}\n`);
  deps.stdout.write(`\n`);

  // ---- Load config ----
  const configResult = await deps.loadTriggerConfigFromFile(configDirPath);
  if (configResult.kind === 'err') {
    const e = configResult.error;
    const msg = e.kind === 'file_not_found'
      ? `Error: triggers.yml not found at ${e.filePath}`
      : e.kind === 'io_error'
      ? `Error: IO error reading triggers.yml: ${e.message}`
      : `Error: Failed to parse triggers.yml: ${JSON.stringify(e)}`;
    deps.stderr.write(`${msg}\n`);
    deps.exit(1);
  }

  const config = configResult.value;
  const triggers = config.triggers;

  if (triggers.length === 0) {
    deps.stdout.write(`No triggers found in config.\n`);
    deps.stdout.write(`\n`);
    deps.stdout.write(`Summary: 0 triggers  0 errors  0 warnings\n`);
    deps.stdout.write(`Exit code: 0 (no errors)\n`);
    deps.exit(0);
  }

  // ---- Validate each trigger and print report ----
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const trigger of triggers) {
    const issues = validateTriggerStrict(trigger);
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning' || i.severity === 'info').length;
    totalErrors += errorCount;
    totalWarnings += warningCount;

    deps.stdout.write(formatTriggerBlock(trigger, issues));
  }

  // ---- Summary ----
  const hasErrors = totalErrors > 0;
  deps.stdout.write(
    `Summary: ${triggers.length} trigger${triggers.length !== 1 ? 's' : ''}  ` +
    `${totalErrors} error${totalErrors !== 1 ? 's' : ''}  ` +
    `${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''}\n`,
  );
  if (hasErrors) {
    deps.stdout.write(`Exit code: 1 (errors found)\n`);
    deps.exit(1);
  } else {
    deps.stdout.write(`Exit code: 0 (no errors)\n`);
    deps.exit(0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format the per-trigger health report block.
 * Returns a multi-line string for one trigger.
 */
function formatTriggerBlock(
  trigger: TriggerDefinition,
  issues: readonly TriggerValidationIssue[],
): string {
  const lines: string[] = [];

  lines.push(`Trigger: ${trigger.id} (${trigger.provider})`);

  // Delivery line
  const autoCommit = trigger.autoCommit ? 'true' : 'false';
  const autoOpenPR = trigger.autoOpenPR ? 'true' : 'false';
  lines.push(`  Delivery:     autoCommit=${autoCommit}  autoOpenPR=${autoOpenPR}`);

  // Branch line
  const branchLine = formatBranchLine(trigger);
  lines.push(`  Branch:       ${branchLine}`);

  // Concurrency line
  lines.push(`  Concurrency:  ${trigger.concurrencyMode}`);

  // Limits line
  const limitsLine = formatLimitsLine(trigger);
  lines.push(`  Limits:       ${limitsLine}`);

  // Goal line
  const goalLine = formatGoalLine(trigger);
  lines.push(`  Goal:         ${goalLine}`);

  // Status line
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warning' || i.severity === 'info').length;
  if (issues.length === 0) {
    lines.push(`  Status:       OK`);
  } else if (errorCount > 0) {
    lines.push(`  Status:       ERROR (${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''})`);
  } else {
    lines.push(`  Status:       WARNING (${warnCount})`);
  }

  // Issue list
  for (const issue of issues) {
    const tag = issue.severity === 'error' ? '[E]' : issue.severity === 'warning' ? '[W]' : '[I]';
    lines.push(`  - ${tag} ${issue.rule}: ${issue.message}`);
  }

  lines.push(``);
  return lines.join('\n') + '\n';
}

function formatBranchLine(trigger: TriggerDefinition): string {
  if (trigger.branchStrategy === 'worktree') {
    const prefix = trigger.branchPrefix ?? 'worktrain/';
    const base = trigger.baseBranch ?? 'main';
    return `worktree -> ${prefix}<sessionId> off ${base}`;
  }
  if (trigger.branchStrategy === 'none') {
    return `none (read-only or explicit opt-out)`;
  }
  // branchStrategy absent = no isolation
  return `none (read-only)`;
}

function formatLimitsLine(trigger: TriggerDefinition): string {
  const parts: string[] = [];
  if (trigger.agentConfig?.maxSessionMinutes) {
    parts.push(`maxSessionMinutes=${trigger.agentConfig.maxSessionMinutes}`);
  } else {
    parts.push(`[maxSessionMinutes not set]`);
  }
  if (trigger.agentConfig?.maxTurns) {
    parts.push(`maxTurns=${trigger.agentConfig.maxTurns}`);
  }
  return parts.join('  ');
}

function formatGoalLine(trigger: TriggerDefinition): string {
  if (trigger.goalTemplate) {
    const preview = trigger.goalTemplate.length > 40
      ? trigger.goalTemplate.slice(0, 37) + '...'
      : trigger.goalTemplate;
    return `from payload (goalTemplate=${preview})`;
  }
  if (trigger.goal && trigger.goal !== 'Autonomous task') {
    return `static: "${trigger.goal}"`;
  }
  return `[not set -- will use "Autonomous task" fallback]`;
}
