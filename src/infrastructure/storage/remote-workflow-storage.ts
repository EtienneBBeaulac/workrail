import { IWorkflowStorage } from '../../types/storage';
import { 
  Workflow, 
  WorkflowSummary,
  WorkflowDefinition,
  WorkflowSource,
  createWorkflow,
  toWorkflowSummary,
  createRemoteRegistrySource
} from '../../types/workflow';
import { 
  validateSecureUrl, 
  sanitizeId, 
  validateSecurityOptions,
  StorageSecurityOptions
} from '../../utils/storage-security';
import { SecurityError, StorageError, InvalidWorkflowError } from '../../core/error-handler';

export interface RemoteWorkflowRegistryConfig extends StorageSecurityOptions {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retryAttempts?: number;
  userAgent?: string;
}

interface RegistryResponse<T> {
  data?: T;
  workflows?: WorkflowDefinition[];
  summaries?: Array<{ id: string; name: string; description: string; version: string }>;
  message?: string;
  error?: string;
}

/**
 * Remote workflow storage that fetches workflows from an HTTP registry.
 */
export class RemoteWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  public readonly source: WorkflowSource;
  
  private readonly config: Required<RemoteWorkflowRegistryConfig>;
  private readonly securityOptions: Required<StorageSecurityOptions>;

  constructor(config: RemoteWorkflowRegistryConfig, source?: WorkflowSource) {
    this.validateConfig(config);
    this.securityOptions = validateSecurityOptions(config);
    
    this.config = {
      ...this.securityOptions,
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      apiKey: config.apiKey || '',
      timeout: config.timeout || 10000,
      retryAttempts: config.retryAttempts || 3,
      userAgent: config.userAgent || 'workrail-mcp-server/1.0'
    };
    
    this.source = source ?? createRemoteRegistrySource(this.config.baseUrl);
  }

  private validateConfig(config: RemoteWorkflowRegistryConfig): void {
    if (!config.baseUrl) {
      throw new SecurityError('baseUrl is required for remote storage', 'config-validation');
    }
    validateSecureUrl(config.baseUrl);

    if (config.timeout && (config.timeout < 100 || config.timeout > 60000)) {
      throw new SecurityError('timeout must be between 100ms and 60000ms', 'config-validation');
    }

    if (config.retryAttempts && (config.retryAttempts < 0 || config.retryAttempts > 10)) {
      throw new SecurityError('retryAttempts must be between 0 and 10', 'config-validation');
    }
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    try {
      const response = await this.fetchWithRetry('/workflows');
      const data = await this.parseResponse<RegistryResponse<WorkflowDefinition[]>>(response);
      
      const definitions = data.workflows || data.data || [];
      const validDefinitions = this.validateDefinitions(definitions);
      
      return validDefinitions.map(def => createWorkflow(def, this.source));
    } catch (error) {
      if (error instanceof SecurityError || error instanceof StorageError) {
        throw error;
      }
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
        if (response.status === 404) return null;
        throw new StorageError(
          `Remote registry returned ${response.status}: ${response.statusText}`,
          'remote-fetch'
        );
      }
      
      const definition = await this.parseResponse<WorkflowDefinition>(response);
      
      if (definition.id !== sanitizedId) {
        throw new InvalidWorkflowError(
          sanitizedId,
          `Registry returned workflow with mismatched ID: ${definition.id}`
        );
      }
      
      return createWorkflow(definition, this.source);
    } catch (error) {
      if (error instanceof SecurityError || error instanceof StorageError || error instanceof InvalidWorkflowError) {
        throw error;
      }
      throw new StorageError(
        `Failed to load workflow ${id} from remote registry: ${(error as Error).message}`,
        'remote-fetch'
      );
    }
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    const workflows = await this.loadAllWorkflows();
    return workflows.map(toWorkflowSummary);
  }

  async save(definition: WorkflowDefinition): Promise<void> {
    try {
      if (!definition.id || !definition.name || !definition.steps) {
        throw new InvalidWorkflowError(
          definition.id || 'unknown',
          'Workflow must have id, name, and steps'
        );
      }
      
      const sanitizedId = sanitizeId(definition.id);
      const sanitizedDefinition = { ...definition, id: sanitizedId };
      
      const response = await this.fetchWithRetry('/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
        },
        body: JSON.stringify(sanitizedDefinition)
      });

      if (!response.ok) {
        const errorData = await this.parseResponse<RegistryResponse<never>>(response);
        throw new StorageError(
          `Failed to publish workflow: ${errorData.message || errorData.error || 'Unknown error'}`,
          'remote-save'
        );
      }
    } catch (error) {
      if (error instanceof SecurityError || error instanceof StorageError || error instanceof InvalidWorkflowError) {
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
        if (attempt === this.config.retryAttempts) break;
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
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        `Failed to parse response from remote registry: ${(error as Error).message}`,
        'parse-error'
      );
    }
  }

  private validateDefinitions(definitions: unknown[]): WorkflowDefinition[] {
    if (!Array.isArray(definitions)) {
      throw new StorageError('Remote registry returned invalid workflows data', 'validation-error');
    }
    
    return definitions.filter((def) => {
      try {
        if (!def || typeof def !== 'object') return false;
        const d = def as Record<string, unknown>;
        if (!d['id'] || !d['name'] || !d['steps']) return false;
        sanitizeId(d['id'] as string);
        return true;
      } catch {
        return false;
      }
    }) as WorkflowDefinition[];
  }
}
