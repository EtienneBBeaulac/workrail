import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { EnhancedErrorService } from './services/enhanced-error-service';

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