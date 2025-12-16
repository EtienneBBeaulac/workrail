/**
 * CLI Output Formatter
 *
 * Presentation layer for CLI output.
 * Converts CliResult/CliOutput to formatted strings with chalk.
 */

import chalk from 'chalk';
import type { CliResult, CliOutput } from './types/cli-result.js';

/**
 * Format a CliOutput structure to a styled string.
 */
export function formatOutput(output: CliOutput, isError: boolean = false): string {
  const lines: string[] = [];

  // Main message
  if (isError) {
    lines.push(chalk.red(`❌ ${output.message}`));
  } else {
    lines.push(chalk.green(`✅ ${output.message}`));
  }

  // Details
  if (output.details && output.details.length > 0) {
    lines.push('');
    output.details.forEach(detail => {
      lines.push(chalk.white(`  • ${detail}`));
    });
  }

  // Warnings
  if (output.warnings && output.warnings.length > 0) {
    lines.push('');
    lines.push(chalk.yellow('⚠️  Warnings:'));
    output.warnings.forEach(warning => {
      lines.push(chalk.yellow(`  • ${warning}`));
    });
  }

  // Suggestions
  if (output.suggestions && output.suggestions.length > 0) {
    lines.push('');
    lines.push(chalk.gray('💡 Suggestions:'));
    output.suggestions.forEach(suggestion => {
      lines.push(chalk.gray(`  • ${suggestion}`));
    });
  }

  return lines.join('\n');
}

/**
 * Format a CliResult to a styled string.
 */
export function formatResult(result: CliResult): string {
  switch (result.kind) {
    case 'success':
      return result.output ? formatOutput(result.output, false) : '';

    case 'failure':
      return formatOutput(result.output, true);
  }
}

/**
 * Print a CliResult to console.
 */
export function printResult(result: CliResult): void {
  const formatted = formatResult(result);
  if (formatted) {
    if (result.kind === 'failure') {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }
}

/**
 * Format an info message (blue).
 */
export function formatInfo(message: string): string {
  return chalk.blue(message);
}

/**
 * Format a section header.
 */
export function formatHeader(title: string): string {
  return chalk.blue(`📋 ${title}`);
}

/**
 * Format a list item.
 */
export function formatListItem(index: number, name: string, description?: string): string {
  const lines = [chalk.green(`${index}. ${name}`)];
  if (description) {
    lines.push(chalk.gray(`   ${description}`));
  }
  return lines.join('\n');
}

/**
 * Format a key-value pair.
 */
export function formatKeyValue(key: string, value: string): string {
  return chalk.white(`   ${key}: ${value}`);
}

/**
 * Format a path or directory.
 */
export function formatPath(path: string): string {
  return chalk.cyan(path);
}

/**
 * Format a workflow source entry.
 */
export function formatSourceEntry(
  index: number,
  name: string,
  path: string,
  exists: boolean,
  description: string,
  workflowCount?: number
): string {
  const icon = exists ? '✅' : '❌';
  const status = exists ? 'Found' : 'Not found';

  const lines = [
    chalk.white(`${index}. ${name} ${icon}`),
    chalk.gray(`   Path: ${path}`),
    chalk.gray(`   Status: ${status}`),
    chalk.gray(`   ${description}`),
  ];

  if (exists && workflowCount !== undefined) {
    lines.push(chalk.cyan(`   Workflows: ${workflowCount} files`));
  }

  return lines.join('\n');
}
