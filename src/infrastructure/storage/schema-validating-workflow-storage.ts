import fs from 'fs';
import path from 'path';
import Ajv, { ValidateFunction } from 'ajv';
import { IWorkflowStorage } from '../../types/storage';
import { Workflow } from '../../types/mcp-types';
import { InvalidWorkflowError } from '../../core/error-handler';
import type { Logger } from '../../core/logging/index.js';

/**
 * Decorator that filters or throws when underlying storage returns workflows
 * that do not conform to the JSON schema.
 */
export class SchemaValidatingWorkflowStorage implements IWorkflowStorage {
  private validator: ValidateFunction;
  private readonly logger?: Logger;

  constructor(private readonly inner: IWorkflowStorage, logger?: Logger) {
    this.logger = logger;
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
        this.logger?.error({ err, workflowId: wf.id }, 'Workflow failed validation');
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
      this.logger?.error({ err, workflowId: id }, 'Workflow failed validation');
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