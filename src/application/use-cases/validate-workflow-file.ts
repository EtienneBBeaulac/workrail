import type { Workflow, WorkflowDefinition } from '../../types/workflow.js';
import type { ValidationResult } from '../../types/validation.js';

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
