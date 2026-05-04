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
import { InvalidWorkflowError, MCPError } from '../../core/error-handler';
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

interface AjvError {
  readonly instancePath?: string;
  readonly keyword?: string;
  readonly message?: string;
  readonly params?: unknown;
}

/**
 * Extract human-readable schema error strings from a caught validation error.
 *
 * InvalidWorkflowError stores raw AJV errors as JSON in data.details.
 * Parsing them here produces actionable messages like
 * "additionalProperties: 'tags' not allowed at root" instead of
 * the generic "Invalid workflow: <id>" from err.message.
 */
function extractValidationErrors(err: unknown): string[] {
  if (err instanceof MCPError && typeof (err.data as Record<string, unknown>)?.details === 'string') {
    try {
      const ajvErrors = JSON.parse((err.data as Record<string, unknown>).details as string) as AjvError[];
      if (Array.isArray(ajvErrors) && ajvErrors.length > 0) {
        return ajvErrors.map((e) => {
          const location = e.instancePath ? `at '${e.instancePath}'` : 'at root';
          const detail = (() => {
            if (e.keyword === 'additionalProperties' && e.params && typeof e.params === 'object') {
              const prop = (e.params as Record<string, unknown>).additionalProperty;
              return `additional property '${String(prop)}' is not allowed`;
            }
            return e.message ?? e.keyword ?? 'unknown error';
          })();
          return `${location}: ${detail}`;
        });
      }
    } catch {
      // Fall through to generic message if JSON.parse fails
    }
  }
  return [err instanceof Error ? err.message : String(err)];
}

// ---------------------------------------------------------------------------
// Validation warning types
//
// These are exposed for consumers that want structured error data from
// loadAllWorkflowsWithWarnings(). The HasValidationWarnings interface enables
// compile-time-safe duck-typing in the handler without touching IWorkflowStorage.
// ---------------------------------------------------------------------------

/** A structured record of a workflow that failed schema validation during loading. */
export interface ValidationWarning {
  readonly workflowId: string;
  readonly sourceKind: string;
  readonly errors: string[];
}

/**
 * Compile-time-safe interface for type-narrowing in callers that want validation
 * diagnostics alongside the loaded workflows.
 *
 * Only the concrete validating wrappers implement this -- IWorkflowStorage does not.
 * The handler type-narrows to this interface so the duck-typing check has a named,
 * stable contract rather than an inline property-access string.
 */
export interface HasValidationWarnings {
  loadAllWorkflowsWithWarnings(): Promise<{
    readonly workflows: readonly Workflow[];
    readonly warnings: readonly ValidationWarning[];
  }>;
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
export class SchemaValidatingWorkflowStorage implements IWorkflowStorage, HasValidationWarnings {
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

  /**
   * Load all workflows, returning valid ones alongside structured diagnostics for failures.
   *
   * Call-scoped: each call creates a fresh warnings array -- no instance-level state.
   * Bundled workflow failures are excluded from `warnings` (pre-validated by CI; should never
   * fail). All failures still log to stderr via reportValidationFailure() so monitoring is not
   * regressed.
   */
  async loadAllWorkflowsWithWarnings(): Promise<{
    readonly workflows: readonly Workflow[];
    readonly warnings: readonly ValidationWarning[];
  }> {
    const workflows = await this.inner.loadAllWorkflows();
    const validWorkflows: Workflow[] = [];
    const warnings: ValidationWarning[] = [];

    for (const workflow of workflows) {
      try {
        if (this.validateDefinition(workflow.definition, workflow.source.kind)) {
          validWorkflows.push(workflow);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        reportValidationFailure(workflow.definition.id, workflow.source.kind, errorMessage);
        // Bundled workflows are pre-validated by CI and should never fail at runtime.
        // If they do, log to stderr (above) but do not surface to the caller -- bundled
        // failures indicate a product bug, not a user-fixable authoring error.
        if (workflow.source.kind !== 'bundled') {
          warnings.push({
            workflowId: workflow.definition.id,
            sourceKind: workflow.source.kind,
            errors: extractValidationErrors(err),
          });
        }
      }
    }

    return { workflows: validWorkflows, warnings };
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
export class SchemaValidatingCompositeWorkflowStorage implements ICompositeWorkflowStorage, HasValidationWarnings {
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

  /**
   * Load all workflows, returning valid ones alongside structured diagnostics for failures.
   *
   * Call-scoped: each call creates a fresh warnings array -- no instance-level state.
   * Bundled workflow failures are excluded from `warnings` (pre-validated by CI; should never
   * fail). All failures still log to stderr via reportValidationFailure() so monitoring is not
   * regressed.
   */
  async loadAllWorkflowsWithWarnings(): Promise<{
    readonly workflows: readonly Workflow[];
    readonly warnings: readonly ValidationWarning[];
  }> {
    const workflows = await this.inner.loadAllWorkflows();
    const validWorkflows: Workflow[] = [];
    const warnings: ValidationWarning[] = [];

    for (const workflow of workflows) {
      try {
        if (this.validateDefinition(workflow.definition, workflow.source.kind)) {
          validWorkflows.push(workflow);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        reportValidationFailure(workflow.definition.id, workflow.source.kind, errorMessage);
        // Bundled workflows are pre-validated by CI and should never fail at runtime.
        // If they do, log to stderr (above) but do not surface to the caller -- bundled
        // failures indicate a product bug, not a user-fixable authoring error.
        if (workflow.source.kind !== 'bundled') {
          warnings.push({
            workflowId: workflow.definition.id,
            sourceKind: workflow.source.kind,
            errors: extractValidationErrors(err),
          });
        }
      }
    }

    return { workflows: validWorkflows, warnings };
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
