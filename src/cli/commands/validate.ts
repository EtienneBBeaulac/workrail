/**
 * Validate Command
 *
 * Validates a workflow file against the schema.
 * Pure function with dependency injection.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';
import type { ValidateWorkflowFileResult } from '../../application/use-cases/validate-workflow-file.js';
import { assertNever } from '../../runtime/assert-never.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ValidateCommandDeps {
  readonly validateWorkflowFile: (filePath: string) => ValidateWorkflowFileResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the validate command.
 */
export function executeValidateCommand(
  filePath: string,
  deps: ValidateCommandDeps
): CliResult {
  const result = deps.validateWorkflowFile(filePath);

  switch (result.kind) {
    case 'file_not_found':
      return failure(`File not found: ${filePath}`, {
        suggestions: ['Check the file path and try again'],
      });

    case 'read_error':
      if (result.code === 'EACCES') {
        return failure(`Permission denied: ${filePath}`, {
          suggestions: ['Check file permissions and try again'],
        });
      }
      return failure(`Error reading file: ${filePath}`, {
        details: [result.message],
      });

    case 'json_parse_error':
      return failure(`Invalid JSON syntax in ${filePath}`, {
        details: [result.message],
        suggestions: ['Check the JSON syntax and try again'],
      });

    case 'schema_invalid':
      return failure(`Workflow validation failed: ${filePath}`, {
        details: [...result.errors],
        suggestions: ['Fix the errors above and try again'],
      });

    case 'valid': {
      const hasWarnings = Boolean(result.warnings?.length);
      const hasInfo = Boolean(result.info?.length);

      return success({
        message: hasWarnings || hasInfo
          ? `Workflow is valid with warnings: ${filePath}`
          : `Workflow is valid: ${filePath}`,
        warnings: result.warnings,
        details: result.info ? [...result.info] : undefined,
        suggestions: result.suggestions ? [...result.suggestions] : undefined,
      });
    }

    case 'structural_invalid':
      return failure(`Workflow validation failed: ${filePath}`, {
        details: [
          ...result.issues,
          `Found ${result.issues.length} validation error${result.issues.length === 1 ? '' : 's'}`,
        ],
        suggestions: result.suggestions ? [...result.suggestions] : undefined,
      });

    case 'v1_compilation_failed':
      return failure(`V1 compilation failed: ${filePath}`, {
        details: [result.message],
        suggestions: ['Review the workflow definition and try again'],
      });

    case 'normalization_failed':
      return failure(`Normalization failed: ${filePath}`, {
        details: [result.message],
        suggestions: ['Review template/feature/ref definitions and try again'],
      });

    case 'executable_compilation_failed':
      return failure(`Executable compilation failed: ${filePath}`, {
        details: [result.message],
        suggestions: ['The normalized workflow has an internal conflict — ensure steps use exactly one prompt source'],
      });

    default:
      return assertNever(result);
  }
}
