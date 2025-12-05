import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateWorkflow } from '../../src/application/validation';

const validPath = path.resolve(__dirname, '../../spec/examples/valid-workflow.json');
const invalidPath = path.resolve(__dirname, '../../spec/examples/invalid-workflow.json');

describe('Workflow Validation', () => {
  it('should validate a valid workflow as valid', () => {
    const data = JSON.parse(fs.readFileSync(validPath, 'utf-8'));
    const result = validateWorkflow(data);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should validate an invalid workflow as invalid', () => {
    const data = JSON.parse(fs.readFileSync(invalidPath, 'utf-8'));
    const result = validateWorkflow(data);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should handle non-object input as invalid', () => {
    const result = validateWorkflow(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
}); 