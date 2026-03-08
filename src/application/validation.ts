import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { EnhancedErrorService } from './services/enhanced-error-service';
import type { Workflow } from '../types/workflow.js';
import type { SchemaError } from './services/workflow-validation-pipeline.js';
import { ok, err, type Result } from 'neverthrow';

const schemaPath = path.resolve(__dirname, '../../spec/workflow.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWorkflow(workflow: unknown): WorkflowValidationResult {
  const ok = validate(workflow);
  return {
    valid: Boolean(ok),
    errors: ok ? [] : EnhancedErrorService.enhanceErrors(validate.errors || [])
  };
}

/**
 * Validate workflow against JSON schema (for pipeline integration).
 *
 * This is the pipeline-compatible wrapper around the AJV validator.
 * Returns Result<Workflow, SchemaError[]> where SchemaError is the
 * discriminated union type for schema validation failures.
 */
export function validateWorkflowSchema(workflow: Workflow): Result<Workflow, readonly SchemaError[]> {
  const result = validateWorkflow(workflow);
  if (result.valid) {
    return ok(workflow);
  }
  // Map AJV errors to SchemaError[]
  // Note: the AJV schema is already compiled and validated, so we trust
  // that validate.errors is an array of StandardSchemaObject errors
  const ajvErrors = validate.errors || [];
  const errors: SchemaError[] = ajvErrors.map(e => ({
    instancePath: e.instancePath ?? '',
    message: e.message,
    keyword: e.keyword,
    params: e.params,
  }));
  return err(errors);
} 