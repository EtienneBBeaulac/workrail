import { IWorkflowStorage } from '../../types/storage';
import { Workflow, WorkflowSummary } from '../../types/mcp-types';
import { 
  validateSecureUrl, 
  sanitizeId, 
  validateSecurityOptions,
  StorageSecurityOptions
} from '../../utils/storage-security';
import { SecurityError, StorageError, InvalidWorkflowError } from '../../core/error-handler';
import type { Logger } from '../../core/logging/index.js';

export interface RemoteWorkflowRegistryConfig extends StorageSecurityOptions {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retryAttempts?: number;
  userAgent?: string;
  logger?: Logger;
}

interface RegistryResponse<T> {
  data?: T;
  workflows?: Workflow[];
  summaries?: WorkflowSummary[];
  message?: string;
  error?: string;
}

/**
 * Remote workflow storage that fetches workflows from a community registry.
 * Implements security best practices and proper error handling.
 * Similar to npm registry but for workflows.
 */
export class RemoteWorkflowStorage implements IWorkflowStorage {
  private readonly config: Required<Omit<RemoteWorkflowRegistryConfig, 'logger'>>;
  private readonly securityOptions: Required<StorageSecurityOptions>;
  private readonly logger?: Logger;

  constructor(config: RemoteWorkflowRegistryConfig) {
    // Validate and secure the configuration
    this.validateConfig(config);
    this.securityOptions = validateSecurityOptions(config);
    this.logger = config.logger;
    
    this.config = {
      ...this.securityOptions,
      baseUrl: config.baseUrl.replace(/\/$/, ''), // Remove trailing slash
      apiKey: config.apiKey || '',
      timeout: config.timeout || 10000,
      retryAttempts: config.retryAttempts || 3,
      userAgent: config.userAgent || 'workrail-mcp-server/1.0'
    };
  }

  private validateConfig(config: RemoteWorkflowRegistryConfig): void {
    if (!config.baseUrl) {
      throw new SecurityError('baseUrl is required for remote storage', 'config-validation');
    }

    // Validate URL security
    validateSecureUrl(config.baseUrl);

    // Validate timeout and retry settings (allow shorter timeouts for testing)
    if (config.timeout && (config.timeout < 100 || config.timeout > 60000)) {
      throw new SecurityError('timeout must be between 100ms and 60000ms', 'config-validation');
    }

    if (config.retryAttempts && (config.retryAttempts < 0 || config.retryAttempts > 10)) {
      throw new SecurityError('retryAttempts must be between 0 and 10', 'config-validation');
    }
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    try {
      const response = await this.fetchWithRetry('/workflows');
      const data = await this.parseResponse<RegistryResponse<Workflow[]>>(response);
      
      // Handle different response formats
      const workflows = data.workflows || data.data || [];
      return this.validateWorkflows(workflows);
    } catch (error) {
      if (error instanceof SecurityError || error instanceof StorageError) {
        throw error; // Re-throw known errors
      }
      
      // Transform unknown errors to storage errors for graceful degradation
      throw new StorageError(
        `Failed to load workflows from remote registry: ${(error as Error).message}`,
        'remote-fetch'
      );
    }
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    try {
      const sanitizedId = sanitizeId(id);
      const response = await this.fetchWithRetry(`/workflows/${encodeURIComponent(sanitizedId)}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          return null; // Workflow not found
        }
        throw new StorageError(
          `Remote registry returned ${response.status}: ${response.statusText}`,
          'remote-fetch'
        );
      }
      
      const workflow = await this.parseResponse<Workflow>(response);
      
      // Verify the returned workflow ID matches what we requested
      if (workflow.id !== sanitizedId) {
        throw new InvalidWorkflowError(
          sanitizedId,
          `Registry returned workflow with mismatched ID: ${workflow.id}`
        );
      }
      
      return workflow;
    } catch (error) {
      if (error instanceof SecurityError || 
          error instanceof StorageError || 
          error instanceof InvalidWorkflowError) {
        throw error;
      }
      
      throw new StorageError(
        `Failed to load workflow ${id} from remote registry: ${(error as Error).message}`,
        'remote-fetch'
      );
    }
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    try {
      const response = await this.fetchWithRetry('/workflows/summaries');
      const data = await this.parseResponse<RegistryResponse<WorkflowSummary[]>>(response);
      
      const summaries = data.summaries || data.data || [];
      return this.validateSummaries(summaries);
    } catch (error) {
      if (error instanceof SecurityError || error instanceof StorageError) {
        throw error;
      }
      
      throw new StorageError(
        `Failed to load workflow summaries from remote registry: ${(error as Error).message}`,
        'remote-fetch'
      );
    }
  }

  async save(workflow: Workflow): Promise<void> {
    try {
      const sanitizedWorkflow = this.validateWorkflowForSave(workflow);
      
      const response = await this.fetchWithRetry('/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
        },
        body: JSON.stringify(sanitizedWorkflow)
      });

      if (!response.ok) {
        const errorData = await this.parseResponse<RegistryResponse<never>>(response);
        throw new StorageError(
          `Failed to publish workflow: ${errorData.message || errorData.error || 'Unknown error'}`,
          'remote-save'
        );
      }
    } catch (error) {
      if (error instanceof SecurityError || 
          error instanceof StorageError || 
          error instanceof InvalidWorkflowError) {
        throw error;
      }
      
      throw new StorageError(
        `Failed to save workflow to remote registry: ${(error as Error).message}`,
        'remote-save'
      );
    }
  }

  private async fetchWithRetry(path: string, options?: RequestInit): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
        
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'User-Agent': this.config.userAgent,
            'Accept': 'application/json',
            ...options?.headers
          }
        });
        
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === this.config.retryAttempts) {
          break; // Don't wait after the last attempt
        }
        
        // Exponential backoff with jitter
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw new StorageError(
      `Failed to fetch ${url} after ${this.config.retryAttempts} attempts: ${lastError?.message}`,
      'network-timeout'
    );
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    try {
      const text = await response.text();
      
      if (!text) {
        throw new StorageError('Empty response from remote registry', 'parse-error');
      }
      
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      
      throw new StorageError(
        `Failed to parse response from remote registry: ${(error as Error).message}`,
        'parse-error'
      );
    }
  }

  private validateWorkflows(workflows: unknown[]): Workflow[] {
    if (!Array.isArray(workflows)) {
      throw new StorageError('Remote registry returned invalid workflows data', 'validation-error');
    }
    
    return workflows.filter((workflow) => {
      try {
        // Basic validation - detailed validation should be handled by schema validator decorator
        if (!workflow || typeof workflow !== 'object') {
          return false;
        }
        
        const wf = workflow as any;
        if (!wf.id || !wf.name || !wf.steps) {
          return false;
        }
        
        // Validate the ID is safe
        sanitizeId(wf.id);
        return true;
      } catch {
        return false; // Skip invalid workflows
      }
    }) as Workflow[];
  }

  private validateSummaries(summaries: unknown[]): WorkflowSummary[] {
    if (!Array.isArray(summaries)) {
      throw new StorageError('Remote registry returned invalid summaries data', 'validation-error');
    }
    
    return summaries.filter((summary) => {
      try {
        if (!summary || typeof summary !== 'object') {
          return false;
        }
        
        const s = summary as any;
        if (!s.id || !s.name) {
          return false;
        }
        
        // Validate the ID is safe
        sanitizeId(s.id);
        return true;
      } catch {
        return false;
      }
    }) as WorkflowSummary[];
  }

  private validateWorkflowForSave(workflow: Workflow): Workflow {
    if (!workflow || typeof workflow !== 'object') {
      throw new InvalidWorkflowError('unknown', 'Workflow must be a valid object');
    }
    
    if (!workflow.id || !workflow.name || !workflow.steps) {
      throw new InvalidWorkflowError(
        workflow.id || 'unknown',
        'Workflow must have id, name, and steps'
      );
    }
    
    // Sanitize the ID
    const sanitizedId = sanitizeId(workflow.id);
    
    return {
      ...workflow,
      id: sanitizedId
    };
  }
}

/**
 * Multi-source workflow storage that combines bundled, local, and remote workflows.
 * Uses composition to cleanly separate concerns.
 */
export class CommunityWorkflowStorage implements IWorkflowStorage {
  private readonly sources: IWorkflowStorage[];
  private readonly remoteStorage: RemoteWorkflowStorage;
  private readonly logger?: Logger;
  
  constructor(
    bundledStorage: IWorkflowStorage,
    localStorage: IWorkflowStorage,
    remoteConfig: RemoteWorkflowRegistryConfig,
    logger?: Logger,
  ) {
    this.logger = logger;
    this.remoteStorage = new RemoteWorkflowStorage({ ...remoteConfig, logger });
    this.sources = [bundledStorage, localStorage, this.remoteStorage];
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    const allWorkflows: Workflow[] = [];
    const seenIds = new Set<string>();
    
    // Load from all sources, with later sources taking precedence
    for (const source of this.sources) {
      try {
        const workflows = await source.loadAllWorkflows();
        
        for (const workflow of workflows) {
          if (seenIds.has(workflow.id)) {
            // Replace existing workflow with same ID
            const existingIndex = allWorkflows.findIndex(wf => wf.id === workflow.id);
            if (existingIndex >= 0) {
              allWorkflows[existingIndex] = workflow;
            }
          } else {
            allWorkflows.push(workflow);
            seenIds.add(workflow.id);
          }
        }
      } catch (error) {
        // For storage sources, we want to continue even if one fails
        // This is intentional graceful degradation behavior
        if (error instanceof StorageError) {
          this.logger?.warn({ err: error }, 'Storage source failed (graceful degradation)');
        } else {
          this.logger?.warn({ err: error }, 'Unexpected error from storage source');
        }
      }
    }
    
    return allWorkflows;
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    try {
      const sanitizedId = sanitizeId(id);
      
      // Search in reverse order (later sources take precedence)
      for (let i = this.sources.length - 1; i >= 0; i--) {
        try {
          const workflow = await this.sources[i]!.getWorkflowById(sanitizedId);
          if (workflow) {
            return workflow;
          }
        } catch (error) {
          // Continue searching other sources if one fails
          if (error instanceof StorageError) {
            this.logger?.warn({ err: error, workflowId: sanitizedId }, 'Storage source failed for workflow');
          } else {
            this.logger?.warn({ err: error, workflowId: sanitizedId }, 'Unexpected error from storage source');
          }
        }
      }
      
      return null;
    } catch (error) {
      if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
        throw error; // Don't continue with invalid IDs
      }
      
      throw new StorageError(
        `Failed to retrieve workflow ${id}: ${(error as Error).message}`,
        'multi-source-error'
      );
    }
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    // Reuse loadAllWorkflows for consistency and caching benefits
    const workflows = await this.loadAllWorkflows();
    return workflows.map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      category: 'community',
      version: workflow.version
    }));
  }

  async save(workflow: Workflow): Promise<void> {
    // Delegate to remote storage for publishing
    return this.remoteStorage.save(workflow);
  }
} 