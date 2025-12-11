import { IWorkflowStorage, ICompositeWorkflowStorage, isCompositeStorage } from '../../types/storage';
import { Workflow, WorkflowSummary, WorkflowDefinition, WorkflowSource } from '../../types/workflow';

const deepClone = <T>(obj: T): T => {
  // Use structuredClone if available (Node 17+), otherwise fallback to JSON
  if (typeof (globalThis as unknown as { structuredClone?: typeof structuredClone }).structuredClone === 'function') {
    return (globalThis as unknown as { structuredClone: typeof structuredClone }).structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
};

interface Cached<T> {
  value: T;
  timestamp: number;
}

/**
 * Decorator that adds simple in-memory TTL caching to any IWorkflowStorage.
 * 
 * IMPORTANT: This decorator now properly delegates to the inner storage
 * and preserves all workflow metadata including source information.
 * It caches workflows and summaries separately for efficiency.
 */
export class CachingWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  
  private workflowCache: Cached<readonly Workflow[]> | null = null;
  private summaryCache: Cached<readonly WorkflowSummary[]> | null = null;
  private stats = { hits: 0, misses: 0 };

  constructor(
    private readonly inner: IWorkflowStorage,
    private readonly ttlMs: number
  ) {}

  /**
   * The source from the inner storage.
   */
  get source(): WorkflowSource {
    return this.inner.source;
  }

  public getCacheStats() {
    return { ...this.stats };
  }

  public clearCache(): void {
    this.workflowCache = null;
    this.summaryCache = null;
  }

  private isFresh<T>(cache: Cached<T> | null): cache is Cached<T> {
    return cache !== null && Date.now() - cache.timestamp < this.ttlMs;
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    if (this.isFresh(this.workflowCache)) {
      this.stats.hits += 1;
      return deepClone(this.workflowCache.value);
    }
    
    this.stats.misses += 1;
    const workflows = await this.inner.loadAllWorkflows();
    this.workflowCache = { value: workflows, timestamp: Date.now() };
    
    // Also invalidate summary cache since workflows changed
    this.summaryCache = null;
    
    return deepClone(workflows);
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    // Try to find in cached workflows first
    if (this.isFresh(this.workflowCache)) {
      const wf = this.workflowCache.value.find((w) => w.definition.id === id);
      if (wf) {
        this.stats.hits += 1;
        return deepClone(wf);
      }
    }
    
    // Fall through to inner storage
    this.stats.misses += 1;
    const workflow = await this.inner.getWorkflowById(id);
    return workflow ? deepClone(workflow) : null;
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    // Use separate summary cache for efficiency
    if (this.isFresh(this.summaryCache)) {
      this.stats.hits += 1;
      return deepClone(this.summaryCache.value);
    }
    
    this.stats.misses += 1;
    
    // Delegate to inner storage - it handles summary creation with proper source info
    const summaries = await this.inner.listWorkflowSummaries();
    this.summaryCache = { value: summaries, timestamp: Date.now() };
    
    return deepClone(summaries);
  }

  async save(definition: WorkflowDefinition): Promise<void> {
    if (typeof this.inner.save === 'function') {
      await this.inner.save(definition);
      // Invalidate caches after save
      this.clearCache();
    }
  }
}

/**
 * Create a caching wrapper for composite storage.
 * This version exposes getSources() from the inner storage.
 */
export class CachingCompositeWorkflowStorage implements ICompositeWorkflowStorage {
  public readonly kind = 'composite' as const;
  
  private workflowCache: Cached<readonly Workflow[]> | null = null;
  private summaryCache: Cached<readonly WorkflowSummary[]> | null = null;
  private stats = { hits: 0, misses: 0 };
  
  constructor(
    private readonly inner: ICompositeWorkflowStorage,
    private readonly ttlMs: number
  ) {}
  
  private isFresh<T>(cache: Cached<T> | null): cache is Cached<T> {
    return cache !== null && Date.now() - cache.timestamp < this.ttlMs;
  }

  getSources(): readonly WorkflowSource[] {
    return this.inner.getSources();
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    if (this.isFresh(this.workflowCache)) {
      this.stats.hits += 1;
      return deepClone(this.workflowCache.value);
    }
    
    this.stats.misses += 1;
    const workflows = await this.inner.loadAllWorkflows();
    this.workflowCache = { value: workflows, timestamp: Date.now() };
    this.summaryCache = null;
    
    return deepClone(workflows);
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    if (this.isFresh(this.workflowCache)) {
      const wf = this.workflowCache.value.find((w) => w.definition.id === id);
      if (wf) {
        this.stats.hits += 1;
        return deepClone(wf);
      }
    }
    
    this.stats.misses += 1;
    const workflow = await this.inner.getWorkflowById(id);
    return workflow ? deepClone(workflow) : null;
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    if (this.isFresh(this.summaryCache)) {
      this.stats.hits += 1;
      return deepClone(this.summaryCache.value);
    }
    
    this.stats.misses += 1;
    const summaries = await this.inner.listWorkflowSummaries();
    this.summaryCache = { value: summaries, timestamp: Date.now() };
    
    return deepClone(summaries);
  }

  async save(definition: WorkflowDefinition): Promise<void> {
    if (typeof this.inner.save === 'function') {
      await this.inner.save(definition);
      this.workflowCache = null;
      this.summaryCache = null;
    }
  }

  getCacheStats() {
    return { ...this.stats };
  }

  clearCache(): void {
    this.workflowCache = null;
    this.summaryCache = null;
  }
}
