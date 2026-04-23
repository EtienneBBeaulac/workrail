import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { EnhancedErrorService } from './services/enhanced-error-service';
import type { Workflow } from '../types/workflow.js';
import type { SchemaError } from './services/workflow-validation-pipeline.js';
import { ok, err, type Result } from 'neverthrow';

const schemaPath = path.resolve(__dirname, '../../spec/workflow.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true });
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
 * The AJV schema validates the WorkflowDefinition shape (id, name, steps, etc.),
 * not the Workflow wrapper. We pass workflow.definition to the validator.
 *
 * Returns Result<Workflow, SchemaError[]> where SchemaError is the
 * discriminated union type for schema validation failures.
 */
export function validateWorkflowSchema(workflow: Workflow): Result<Workflow, readonly SchemaError[]> {
  const result = validateWorkflow(workflow.definition);
  if (result.valid) {
    return ok(workflow);
  }
  const ajvErrors = validate.errors || [];
  const errors: SchemaError[] = ajvErrors.map(e => ({
    instancePath: e.instancePath ?? '',
    message: e.message,
    keyword: e.keyword,
    params: e.params,
  }));
  return err(errors);
} 