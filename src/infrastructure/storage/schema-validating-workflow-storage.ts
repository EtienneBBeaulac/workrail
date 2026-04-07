import fs from 'fs';
import path from 'path';
import Ajv, { ValidateFunction } from 'ajv';
import { IWorkflowStorage, ICompositeWorkflowStorage, isCompositeStorage } from '../../types/storage';
import {
  Workflow,
  WorkflowSummary,
  WorkflowDefinition,
  WorkflowSource,
  createWorkflow,
  toWorkflowSummary
} from '../../types/workflow';
import { InvalidWorkflowError } from '../../core/error-handler';
import { validateWorkflowIdForLoad, validateWorkflowIdForSave } from '../../domain/workflow-id-policy';

// ---------------------------------------------------------------------------
// Module-level AJV singleton
//
// Compiling the schema is expensive (~10ms). Both validator classes used to
// run `new Ajv().compile(schema)` inside their constructors, which meant a
// fresh compile on every `createWorkflowReaderForRequest` call (once per MCP
// request). Moving the compiled validator here makes compilation happen once
// at module load time. AJV compiled validators are pure, stateless functions
// and are safe to share across any number of instances.
// ---------------------------------------------------------------------------
function buildModuleValidator(): ValidateFunction {
  const schemaPath = path.resolve(__dirname, '../../../spec/workflow.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

const MODULE_WORKFLOW_VALIDATOR: ValidateFunction = buildModuleValidator();

/**
 * Structured prefix for validation errors.
 * Enables grep-based monitoring and structured log parsing.
 */
const VALIDATION_ERROR_PREFIX = '[ValidationError]';

/**
 * Report a validation failure with structured context.
 * Phase 4 (Option B): runtime still filters invalid workflows, but reports them loudly.
 */
function reportValidationFailure(workflowId: string, sourceKind: string, error: string): void {
  console.error(`${VALIDATION_ERROR_PREFIX} ${sourceKind}/${workflowId}: ${error}`);
}

/**
 * Decorator that validates workflows against the JSON schema.
 * 
 * Validates the definition portion of workflows on load.
 * Invalid workflows are reported via structured logging and filtered out (graceful degradation).
 * 
 * Phase 4 (Option B — temporary containment):
 * - Runtime still filters invalid workflows for safety
 * - Every filter action is reported with workflow ID, source kind, and error
 * - listWorkflowSummaries() validates through loadAllWorkflows() (no bypass)
 * - The CI gate (Phases 2-3) is the hard failure path; runtime remains soft
 */
export class SchemaValidatingWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  // Use the module-level singleton to avoid recompiling the schema per instance.
  private readonly validator: ValidateFunction = MODULE_WORKFLOW_VALIDATOR;

  constructor(private readonly inner: IWorkflowStorage) {}

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
    validateWorkflowIdForLoad(definition.id, sourceKind);

    return true;
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
        reportValidationFailure(
          workflow.definition.id,
          workflow.source.kind,
          err instanceof Error ? err.message : String(err)
        );
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
      reportValidationFailure(
        id,
        workflow.source.kind,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    // Phase 4 fix: validate through loadAllWorkflows() and derive summaries
    // from the validated set. Previously this delegated to inner storage,
    // bypassing validation — invalid workflows appeared in the workflow list.
    const validated = await this.loadAllWorkflows();
    return validated.map(toWorkflowSummary);
  }

  async save(definition: WorkflowDefinition): Promise<void> {
    this.validateDefinition(definition, this.source.kind);
    validateWorkflowIdForSave(definition.id, this.source.kind);

    if (typeof this.inner.save === 'function') {
      return this.inner.save(definition);
    }
  }
}

/**
 * Schema validator for composite storage.
 * Same Phase 4 improvements as SchemaValidatingWorkflowStorage.
 */
export class SchemaValidatingCompositeWorkflowStorage implements ICompositeWorkflowStorage {
  public readonly kind = 'composite' as const;
  // Use the module-level singleton to avoid recompiling the schema per instance.
  private readonly validator: ValidateFunction = MODULE_WORKFLOW_VALIDATOR;

  constructor(private readonly inner: ICompositeWorkflowStorage) {}
  
  private validateDefinition(definition: WorkflowDefinition, sourceKind: WorkflowSource['kind']): boolean {
    const isValid = this.validator(definition);
    if (!isValid) {
      const id = (definition as { id?: string }).id ?? 'unknown';
      throw new InvalidWorkflowError(id, JSON.stringify(this.validator.errors));
    }

    validateWorkflowIdForLoad(definition.id, sourceKind);

    return true;
  }

  getSources(): readonly WorkflowSource[] {
    return this.inner.getSources();
  }

  getStorageInstances(): readonly IWorkflowStorage[] {
    return this.inner.getStorageInstances();
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
        reportValidationFailure(
          workflow.definition.id,
          workflow.source.kind,
          err instanceof Error ? err.message : String(err)
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
      reportValidationFailure(
        id,
        workflow.source.kind,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    // Phase 4 fix: validate through loadAllWorkflows(), then derive summaries.
    const validated = await this.loadAllWorkflows();
    return validated.map(toWorkflowSummary);
  }

  async save(definition: WorkflowDefinition): Promise<void> {
    this.validateDefinition(definition, 'project');
    validateWorkflowIdForSave(definition.id, 'project');

    if (typeof this.inner.save === 'function') {
      return this.inner.save(definition);
    }
  }
}
