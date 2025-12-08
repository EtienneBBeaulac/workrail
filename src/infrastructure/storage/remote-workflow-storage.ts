/**
 * Remote Workflow Provider
 * 
 * Fetches workflows from HTTP registries.
 * Result-based with retry logic.
 */

import { Result, ok, err } from 'neverthrow';
import type { WorkflowId, Workflow } from '../../types/schemas.js';
import { WorkflowSchema } from '../../types/schemas.js';
import type { IWorkflowProvider } from '../../types/repository.js';
import type { AppError } from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';
import { validateJSONLoad } from '../../core/errors/index.js';

export interface RemoteWorkflowRegistryConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retryAttempts?: number;
  logger?: any;
}

/**
 * Fetches workflows from remote HTTP registry.
 */
export class RemoteWorkflowProvider implements IWorkflowProvider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly retryAttempts: number;
  private readonly logger: any;

  constructor(config: RemoteWorkflowRegistryConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 10000;
    this.retryAttempts = config.retryAttempts || 3;
    this.logger = config.logger;
  }

  async fetchAll(): Promise<Result<readonly Workflow[], AppError>> {
    const url = `${this.baseUrl}/workflows`;
    
    try {
      const response = await this.fetchWithRetry(url);
      const data = await response.json();
      
      if (!Array.isArray(data.workflows)) {
        return err(Err.unexpectedError('remote fetch', new Error('Invalid response format')));
      }
      
      // Validate each workflow
      const workflows: Workflow[] = [];
      for (const wf of data.workflows) {
        const validated = WorkflowSchema.safeParse(wf);
        if (validated.success) {
          workflows.push(validated.data);
        } else {
          this.logger?.warn({ err: validated.error }, 'Invalid workflow from registry');
        }
      }
      
      return ok(workflows);
    } catch (error) {
      return err(Err.unexpectedError('remote fetchAll', error as Error));
    }
  }

  async fetchById(id: WorkflowId): Promise<Result<Workflow, AppError>> {
    const url = `${this.baseUrl}/workflows/${id}`;
    
    try {
      const response = await this.fetchWithRetry(url);
      
      if (response.status === 404) {
        return err(Err.workflowNotFound(id as any as string, [], 0, []));
      }
      
      const data = await response.json();
      
      const validated = validateJSONLoad(WorkflowSchema, data, url);
      if (!validated.isOk()) {
        return err(validated.error);
      }
      
      return ok(validated.value as any);  // TODO: fix typing
    } catch (error) {
      return err(Err.unexpectedError('remote fetchById', error as Error));
    }
  }
  
  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const headers: Record<string, string> = {};
        if (this.apiKey) {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(this.timeout),
        });
        
        return response;
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.retryAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }
    
    throw lastError!;
  }
}

/**
 * Community workflows storage (combines remote + local).
 */
export class CommunityWorkflowStorage implements IWorkflowProvider {
  constructor(
    private readonly sources: IWorkflowProvider[]
  ) {}

  async fetchAll(): Promise<Result<readonly Workflow[], AppError>> {
    const results = await Promise.allSettled(
      this.sources.map(s => s.fetchAll())
    );
    
    const workflows = results
      .filter((r): r is PromiseFulfilledResult<Result<readonly Workflow[], AppError>> => 
        r.status === 'fulfilled' && r.value.isOk()
      )
      .flatMap(r => (r.value as any).value);
    
    return ok(workflows);
  }

  async fetchById(id: WorkflowId): Promise<Result<Workflow, AppError>> {
    for (const source of this.sources) {
      const result = await source.fetchById(id);
      if (result.isOk()) return result;
    }
    
    return err(Err.workflowNotFound(id as any as string, [], 0, []));
  }
}

// Aliases
export const RemoteWorkflowStorage = RemoteWorkflowProvider;
