import type { Workflow, WorkflowDefinition } from '../../types/workflow.js';
import type { ValidationResult } from '../../types/validation.js';
import type { ValidationOutcomePhase1a } from '../services/workflow-validation-pipeline.js';
import { validateWorkflowPhase1a, type ValidationPipelineDepsPhase1a } from '../services/workflow-validation-pipeline.js';

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export type ValidateWorkflowFileResult =
  | { kind: 'file_not_found'; filePath: string }
  | { kind: 'read_error'; filePath: string; message: string; code?: string }
  | { kind: 'json_parse_error'; filePath: string; message: string }
  | { kind: 'schema_invalid'; filePath: string; errors: readonly string[] }
  | {
      kind: 'valid';
      filePath: string;
      warnings?: readonly string[];
      info?: readonly string[];
      suggestions?: readonly string[];
    }
  | {
      kind: 'structural_invalid';
      filePath: string;
      issues: readonly string[];
      warnings?: readonly string[];
      info?: readonly string[];
      suggestions?: readonly string[];
    }
  | {
      kind: 'v1_compilation_failed';
      filePath: string;
      message: string;
    }
  | {
      kind: 'normalization_failed';
      filePath: string;
      message: string;
    }
  | {
      kind: 'executable_compilation_failed';
      filePath: string;
      message: string;
    };

export interface ValidateWorkflowFileDeps {
  readonly resolvePath: (filePath: string) => string;
  readonly existsSync: (resolvedPath: string) => boolean;
  readonly readFileSyncUtf8: (resolvedPath: string) => string;
  readonly parseJson: (content: string) => unknown;
  readonly schemaValidate: (definition: WorkflowDefinition) => SchemaValidationResult;
  readonly makeRuntimeWorkflow: (definition: WorkflowDefinition, resolvedPath: string) => Workflow;
  readonly validateRuntimeWorkflow: (workflow: Workflow) => ValidationResult;
}

/**
 * Extended dependencies that support Phase 1a pipeline validation.
 * Extends the base ValidateWorkflowFileDeps with pipeline-specific dependencies.
 */
export interface ValidateWorkflowFileDepsPipeline extends ValidateWorkflowFileDeps {
  readonly validationPipelineDeps?: ValidationPipelineDepsPhase1a;
}

export function createValidateWorkflowFileUseCase(deps: ValidateWorkflowFileDeps) {
  return function validateWorkflowFile(filePath: string): ValidateWorkflowFileResult {
    const resolvedPath = deps.resolvePath(filePath);

    if (!deps.existsSync(resolvedPath)) {
      return { kind: 'file_not_found', filePath };
    }

    let content: string;
    try {
      content = deps.readFileSyncUtf8(resolvedPath);
    } catch (err: any) {
      return {
        kind: 'read_error',
        filePath,
        message: err?.message ?? String(err),
        code: err?.code,
      };
    }

    let parsed: unknown;
    try {
      parsed = deps.parseJson(content);
    } catch (err: any) {
      return { kind: 'json_parse_error', filePath, message: err?.message ?? String(err) };
    }

    const definition = parsed as WorkflowDefinition;

    const schemaResult = deps.schemaValidate(definition);
    if (!schemaResult.valid) {
      return { kind: 'schema_invalid', filePath, errors: schemaResult.errors };
    }

    const runtimeWorkflow = deps.makeRuntimeWorkflow(definition, resolvedPath);
    const structural = deps.validateRuntimeWorkflow(runtimeWorkflow);

    if (structural.valid) {
      const warnings = structural.warnings?.length ? structural.warnings : undefined;
      const info = structural.info?.length ? structural.info : undefined;
      const suggestions = structural.suggestions.length ? structural.suggestions : undefined;

      return {
        kind: 'valid',
        filePath,
        warnings,
        info,
        suggestions,
      };
    }

    return {
      kind: 'structural_invalid',
      filePath,
      issues: structural.issues,
      warnings: structural.warnings,
      info: structural.info,
      suggestions: structural.suggestions.length ? structural.suggestions : undefined,
    };
  };
}

/**
 * Phase 1a pipeline-aware validation.
 * Extends the legacy validateWorkflowFile with full pipeline support.
 */
export function createValidateWorkflowFileUseCasePipeline(deps: ValidateWorkflowFileDepsPipeline) {
  return function validateWorkflowFilePipeline(filePath: string): ValidateWorkflowFileResult {
    const resolvedPath = deps.resolvePath(filePath);

    if (!deps.existsSync(resolvedPath)) {
      return { kind: 'file_not_found', filePath };
    }

    let content: string;
    try {
      content = deps.readFileSyncUtf8(resolvedPath);
    } catch (err: any) {
      return {
        kind: 'read_error',
        filePath,
        message: err?.message ?? String(err),
        code: err?.code,
      };
    }

    let parsed: unknown;
    try {
      parsed = deps.parseJson(content);
    } catch (err: any) {
      return { kind: 'json_parse_error', filePath, message: err?.message ?? String(err) };
    }

    const definition = parsed as WorkflowDefinition;
    const runtimeWorkflow = deps.makeRuntimeWorkflow(definition, resolvedPath);

    // If pipeline deps are available, use the full Phase 1a pipeline
    if (deps.validationPipelineDeps) {
      const outcome = validateWorkflowPhase1a(runtimeWorkflow, deps.validationPipelineDeps);

      switch (outcome.kind) {
        case 'schema_failed':
          return {
            kind: 'schema_invalid',
            filePath,
            errors: outcome.errors.map(e => e.message || `Schema error at ${e.instancePath}`),
          };

        case 'structural_failed':
          return {
            kind: 'structural_invalid',
            filePath,
            issues: outcome.issues,
          };

        case 'v1_compilation_failed':
          return {
            kind: 'v1_compilation_failed',
            filePath,
            message: outcome.cause.message,
          };

        case 'normalization_failed':
          return {
            kind: 'normalization_failed',
            filePath,
            message: outcome.cause.message,
          };

        case 'executable_compilation_failed':
          return {
            kind: 'executable_compilation_failed',
            filePath,
            message: outcome.cause.message,
          };

        case 'phase1a_valid':
          return {
            kind: 'valid',
            filePath,
          };
      }
    }

    // Fall back to legacy validation (for backward compatibility)
    const schemaResult = deps.schemaValidate(definition);
    if (!schemaResult.valid) {
      return { kind: 'schema_invalid', filePath, errors: schemaResult.errors };
    }

    const structural = deps.validateRuntimeWorkflow(runtimeWorkflow);

    if (structural.valid) {
      const warnings = structural.warnings?.length ? structural.warnings : undefined;
      const info = structural.info?.length ? structural.info : undefined;
      const suggestions = structural.suggestions.length ? structural.suggestions : undefined;

      return {
        kind: 'valid',
        filePath,
        warnings,
        info,
        suggestions,
      };
    }

    return {
      kind: 'structural_invalid',
      filePath,
      issues: structural.issues,
      warnings: structural.warnings,
      info: structural.info,
      suggestions: structural.suggestions.length ? structural.suggestions : undefined,
    };
  };
}
