import { IWorkflowStorage } from '../../src/types/storage.js';
import { Workflow, WorkflowSummary } from '../../src/types/mcp-types.js';

/**
 * In-memory storage with call tracking for assertions.
 */
export class MockStorage implements IWorkflowStorage {
  private data = new Map<string, Workflow>();

  readonly calls = {
    getWorkflowById: [] as string[],
    listWorkflowSummaries: 0,
    loadAllWorkflows: 0,
  };

  // Setup
  addWorkflow(workflow: Workflow): this {
    this.data.set(workflow.id, workflow);
    return this;
  }

  // IWorkflowStorage
  async getWorkflowById(id: string): Promise<Workflow | null> {
    this.calls.getWorkflowById.push(id);
    return this.data.get(id) ?? null;
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    this.calls.listWorkflowSummaries++;
    return Array.from(this.data.values()).map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      version: w.version,
      category: 'test',
    }));
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    this.calls.loadAllWorkflows++;
    return Array.from(this.data.values());
  }

  async save(workflow: Workflow): Promise<void> {
    this.data.set(workflow.id, workflow);
  }

  // Assertions
  assertCalled(method: keyof typeof this.calls): void {
    const count = Array.isArray(this.calls[method])
      ? this.calls[method].length
      : this.calls[method];
    if (count === 0) {
      throw new Error(`Expected ${method} to be called`);
    }
  }

  reset(): void {
    this.data.clear();
    this.calls.getWorkflowById = [];
    this.calls.listWorkflowSummaries = 0;
    this.calls.loadAllWorkflows = 0;
  }
}
