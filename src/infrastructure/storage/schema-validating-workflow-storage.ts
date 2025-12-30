import fs from 'fs';
import path from 'path';
import Ajv, { ValidateFunction } from 'ajv';
import { IWorkflowStorage, ICompositeWorkflowStorage, isCompositeStorage } from '../../types/storage';
import { 
  Workflow, 
  WorkflowSummary, 
  WorkflowDefinition,
  WorkflowSource,
  createWorkflow 
} from '../../types/workflow';
import { InvalidWorkflowError } from '../../core/error-handler';
import { validateWorkflowIdForLoad, validateWorkflowIdForSave } from '../../domain/workflow-id-policy';

/**
 * Decorator that validates workflows against the JSON schema.
 * 
 * Validates the definition portion of workflows on load.
 * Invalid workflows are logged and filtered out (graceful degradation).
 * 
 * IMPORTANT: This decorator delegates to inner storage for summaries.
 * Validation happens on loadAllWorkflows() and getWorkflowById().
 */
export class SchemaValidatingWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  private readonly validator: ValidateFunction;

  constructor(private readonly inner: IWorkflowStorage) {
    const schemaPath = path.resolve(__dirname, '../../../spec/workflow.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    this.validator = ajv.compile(schema);
  }

  /**
   * The source from the inner storage.
   */
  get source(): WorkflowSource {
    return this.inner.source;
  }

  private validateDefinition(definition: WorkflowDefinition, sourceKind: WorkflowSource['kind']): boolean {
    const isValid = this.validator(definition);
    if (!isValid) {
      const id = (definition as { id?: string }).id ?? 'unknown';
      throw new InvalidWorkflowError(id, JSON.stringify(this.validator.errors));
    }

    // v2 lock: enforce workflow ID namespace rules at load/validate time.
    // - legacy IDs are warn-only (not rejected)
    // - wr.* is reserved for bundled workflows
    validateWorkflowIdForLoad(definition.id, sourceKind);

    return true;
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    const workflows = await this.inner.loadAllWorkflows();
    
    // Filter out invalid workflows, logging errors
    const validWorkflows: Workflow[] = [];
    
    for (const workflow of workflows) {
      try {
        if (this.validateDefinition(workflow.definition, workflow.source.kind)) {
          validWorkflows.push(workflow);
        }
      } catch (err) {
        console.error(
          `[SchemaValidation] Workflow '${workflow.definition.id}' failed validation:`,
          err instanceof Error ? err.message : err
        );
        // Skip invalid workflows (graceful degradation)
      }
    }
    
    return validWorkflows;
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    const workflow = await this.inner.getWorkflowById(id);
    
    if (!workflow) {
      return null;
    }
    
    try {
      this.validateDefinition(workflow.definition, workflow.source.kind);
      return workflow;
    } catch (err) {
      console.error(
        `[SchemaValidation] Workflow '${id}' failed validation:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    // Delegate to inner storage - summaries are derived from validated workflows
    // We validate when workflows are actually loaded
    return this.inner.listWorkflowSummaries();
  }

  async save(definition: WorkflowDefinition): Promise<void> {
    // Validate before saving
    this.validateDefinition(definition, this.source.kind);
    validateWorkflowIdForSave(definition.id, this.source.kind);

    if (typeof this.inner.save === 'function') {
      return this.inner.save(definition);
    }
  }
}

/**
 * Schema validator for composite storage.
 */
export class SchemaValidatingCompositeWorkflowStorage implements ICompositeWorkflowStorage {
  public readonly kind = 'composite' as const;
  private readonly validator: ValidateFunction;

  constructor(private readonly inner: ICompositeWorkflowStorage) {
    const schemaPath = path.resolve(__dirname, '../../../spec/workflow.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    this.validator = ajv.compile(schema);
  }
  
  private validateDefinition(definition: WorkflowDefinition, sourceKind: WorkflowSource['kind']): boolean {
    const isValid = this.validator(definition);
    if (!isValid) {
      const id = (definition as { id?: string }).id ?? 'unknown';
      throw new InvalidWorkflowError(id, JSON.stringify(this.validator.errors));
    }

    // v2 lock: enforce workflow ID namespace rules at load/validate time.
    validateWorkflowIdForLoad(definition.id, sourceKind);

    return true;
  }

  getSources(): readonly WorkflowSource[] {
    return this.inner.getSources();
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    const workflows = await this.inner.loadAllWorkflows();
    
    const validWorkflows: Workflow[] = [];
    for (const workflow of workflows) {
      try {
        if (this.validateDefinition(workflow.definition, workflow.source.kind)) {
          validWorkflows.push(workflow);
        }
      } catch (err) {
        console.error(
          `[SchemaValidation] Workflow '${workflow.definition.id}' failed validation:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    
    return validWorkflows;
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    const workflow = await this.inner.getWorkflowById(id);
    
    if (!workflow) return null;
    
    try {
      this.validateDefinition(workflow.definition, workflow.source.kind);
      return workflow;
    } catch (err) {
      console.error(
        `[SchemaValidation] Workflow '${id}' failed validation:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    return this.inner.listWorkflowSummaries();
  }

  async save(definition: WorkflowDefinition): Promise<void> {
    // Lock: composite storage save delegates to highest-priority writable source.
    // We use 'project' as a conservative sourceKind for validation because:
    // - validateWorkflowIdForSave rejects legacy IDs and wr.* for ALL non-bundled sourceKinds
    // - actual save target (project/user/custom) doesn't matter; all have same restrictions
    // - this prevents needing to query inner storage for actual writable source
    this.validateDefinition(definition, 'project');
    validateWorkflowIdForSave(definition.id, 'project');

    if (typeof this.inner.save === 'function') {
      return this.inner.save(definition);
    }
  }
}
