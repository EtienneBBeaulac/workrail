import { Workflow, WorkflowSummary } from '../../types/mcp-types';
import { IWorkflowStorage } from '../../types/storage';

/**
 * Very lightweight, non-persistent storage implementation for unit tests
 * or ephemeral execution. Workflows are injected at construction time.
 */
export class InMemoryWorkflowStorage implements IWorkflowStorage {
  private workflows: Workflow[];

  constructor(workflows: Workflow[] = []) {
    this.workflows = [...workflows];
  }

  /** Replace the internal workflow list (useful for tests). */
  public setWorkflows(workflows: Workflow[]): void {
    this.workflows = [...workflows];
  }

  public async loadAllWorkflows(): Promise<Workflow[]> {
    return [...this.workflows];
  }

  public async getWorkflowById(id: string): Promise<Workflow | null> {
    return this.workflows.find((wf) => wf.id === id) || null;
  }

  public async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    return this.workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      category: 'default',
      version: workflow.version
    }));
  }

  public async save(workflow: Workflow): Promise<void> {
    const index = this.workflows.findIndex((w) => w.id === workflow.id);
    if (index >= 0) {
      this.workflows[index] = workflow;
    } else {
      this.workflows.push(workflow);
    }
  }
} 