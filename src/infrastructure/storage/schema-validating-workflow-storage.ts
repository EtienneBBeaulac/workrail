import fs from 'fs';
import path from 'path';
import Ajv, { ValidateFunction } from 'ajv';
import { IWorkflowStorage } from '../../types/storage';
import { Workflow } from '../../types/mcp-types';
import { InvalidWorkflowError } from '../../core/error-handler';

/**
 * Decorator that filters or throws when underlying storage returns workflows
 * that do not conform to the JSON schema.
 */
export class SchemaValidatingWorkflowStorage implements IWorkflowStorage {
  private validator: ValidateFunction;

  constructor(private readonly inner: IWorkflowStorage) {
    const schemaPath = path.resolve(__dirname, '../../../spec/workflow.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    this.validator = ajv.compile(schema);
  }

  private ensureValid(workflow: Workflow): boolean {
    const isValid = this.validator(workflow as any);
    if (!isValid) {
      throw new InvalidWorkflowError(
        (workflow as any).id ?? 'unknown',
        JSON.stringify(this.validator.errors)
      );
    }
    return true;
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    const raw = await this.inner.loadAllWorkflows();
    return raw.filter((wf) => {
      try {
        return this.ensureValid(wf);
      } catch (err) {
        console.error(`[SchemaValidation] Workflow '${wf.id}' failed validation:`, 
          err instanceof Error ? err.message : err);
        return false; // Skip invalid workflows
      }
    });
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    const wf = await this.inner.getWorkflowById(id);
    if (!wf) return null;
    try {
      this.ensureValid(wf);
      return wf;
    } catch (err) {
      console.error(`[SchemaValidation] Workflow '${id}' failed validation:`, 
        err instanceof Error ? err.message : err);
      return null;
    }
  }

  async listWorkflowSummaries() {
    const workflows = await this.loadAllWorkflows();
    return workflows.map((wf) => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      category: 'default',
      version: wf.version
    }));
  }

  async save?(workflow: Workflow): Promise<void> {
    if (typeof this.inner.save === 'function') {
      return this.inner.save(workflow);
    }
  }
} 