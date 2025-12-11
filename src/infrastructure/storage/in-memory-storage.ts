import { 
  Workflow, 
  WorkflowSummary, 
  WorkflowDefinition,
  WorkflowSource,
  createWorkflow,
  toWorkflowSummary,
  createBundledSource
} from '../../types/workflow';
import { IWorkflowStorage } from '../../types/storage';

/**
 * Very lightweight, non-persistent storage implementation for unit tests
 * or ephemeral execution. Workflows are injected at construction time.
 */
export class InMemoryWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  public readonly source: WorkflowSource;
  private workflows: Workflow[];

  constructor(
    definitions: readonly WorkflowDefinition[] = [],
    source: WorkflowSource = createBundledSource()
  ) {
    this.source = source;
    this.workflows = definitions.map(def => createWorkflow(def, source));
  }

  /** 
   * Replace the internal workflow list (useful for tests).
   * Creates new Workflow objects with the storage's source.
   */
  public setWorkflows(definitions: readonly WorkflowDefinition[]): void {
    this.workflows = definitions.map(def => createWorkflow(def, this.source));
  }

  /**
   * Add workflows directly (for advanced test scenarios where source matters).
   */
  public setWorkflowsRaw(workflows: readonly Workflow[]): void {
    this.workflows = [...workflows];
  }

  public async loadAllWorkflows(): Promise<readonly Workflow[]> {
    return [...this.workflows];
  }

  public async getWorkflowById(id: string): Promise<Workflow | null> {
    return this.workflows.find((wf) => wf.definition.id === id) || null;
  }

  public async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    return this.workflows.map(toWorkflowSummary);
  }

  public async save(definition: WorkflowDefinition): Promise<void> {
    const index = this.workflows.findIndex((w) => w.definition.id === definition.id);
    const workflow = createWorkflow(definition, this.source);
    
    if (index >= 0) {
      this.workflows[index] = workflow;
    } else {
      this.workflows.push(workflow);
    }
  }
}

/**
 * Factory for creating test storage with sample workflows.
 */
export function createTestStorage(
  definitions: readonly WorkflowDefinition[] = [],
  source?: WorkflowSource
): InMemoryWorkflowStorage {
  return new InMemoryWorkflowStorage(definitions, source);
}
