/**
 * In-Memory Workflow Provider
 * 
 * Lightweight, non-persistent storage for tests.
 * Workflows injected at construction.
 */

import { Result, ok, err } from 'neverthrow';
import type { WorkflowId, Workflow } from '../../types/schemas.js';
import type { IWorkflowProvider } from '../../types/repository.js';
import type { AppError, WorkflowNotFoundError } from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';

export class InMemoryWorkflowProvider implements IWorkflowProvider {
  private workflows: Workflow[];

  constructor(workflows: Workflow[] = []) {
    this.workflows = workflows.map(wf => Object.freeze(wf));
  }

  setWorkflows(workflows: Workflow[]): void {
    this.workflows = workflows.map(wf => Object.freeze(wf));
  }

  async fetchAll(): Promise<Result<readonly Workflow[], never>> {
    return ok([...this.workflows]);
  }

  async fetchById(id: WorkflowId): Promise<Result<Workflow, WorkflowNotFoundError>> {
    const workflow = this.workflows.find(wf => wf.id === id);
    
    if (!workflow) {
      const allIds = this.workflows.map(w => w.id as any as string);
      const suggestions = this.findSimilar(id as any as string, allIds);
      return err(Err.workflowNotFound(id as any as string, suggestions, allIds.length, []));
    }
    
    return ok(workflow);
  }
  
  private findSimilar(target: string, candidates: string[]): string[] {
    // Simple prefix matching for in-memory (fast)
    return candidates
      .filter(c => c.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(c.toLowerCase()))
      .slice(0, 3);
  }
}

// Alias for backward compatibility in tests
export const InMemoryWorkflowStorage = InMemoryWorkflowProvider;
