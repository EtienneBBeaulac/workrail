import { IWorkflowStorage } from '../../types/storage';
import { Workflow, WorkflowSummary } from '../../types/mcp-types';

const deepClone = <T>(obj: T): T => {
  // Use structuredClone if available (Node 17+), otherwise fallback to JSON
  if (typeof (global as any).structuredClone === 'function') {
    return (global as any).structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
};

interface Cached<T> {
  value: T;
  timestamp: number;
}

/**
 * Decorator that adds simple in-memory TTL caching to any IWorkflowStorage.
 */
export class CachingWorkflowStorage implements IWorkflowStorage {
  private cache: Cached<Workflow[]> | null = null;
  private stats = { hits: 0, misses: 0 };

  constructor(private readonly inner: IWorkflowStorage, private readonly ttlMs: number) {}

  public getCacheStats() {
    return { ...this.stats };
  }

  private isFresh(): boolean {
    return this.cache !== null && Date.now() - this.cache.timestamp < this.ttlMs;
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    if (this.isFresh()) {
      this.stats.hits += 1;
      return deepClone(this.cache!.value);
    }
    this.stats.misses += 1;
    const workflows = await this.inner.loadAllWorkflows();
    this.cache = { value: workflows, timestamp: Date.now() };
    return deepClone(workflows);
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    const workflows = await this.loadAllWorkflows();
    const wf = workflows.find((wf) => wf.id === id);
    return wf ? deepClone(wf) : null;
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
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