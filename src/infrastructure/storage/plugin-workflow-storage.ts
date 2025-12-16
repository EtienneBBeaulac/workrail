import { IWorkflowStorage } from '../../types/storage';
import { 
  Workflow, 
  WorkflowSummary,
  WorkflowDefinition,
  WorkflowSource,
  createWorkflow,
  toWorkflowSummary,
  createPluginSource
} from '../../types/workflow';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { 
  sanitizeId, 
  assertWithinBase, 
  validateFileSize,
  validateSecurityOptions
} from '../../utils/storage-security';
import { StorageError, InvalidWorkflowError, SecurityError } from '../../core/error-handler';

export interface WorkflowPlugin {
  name: string;
  version: string;
  workflows: Workflow[];
  metadata?: {
    author?: string;
    description?: string;
    homepage?: string;
    repository?: string;
  };
}

export interface PluginWorkflowConfig {
  pluginPaths?: string[];
  scanInterval?: number;
  maxFileSize?: number;
  maxFiles?: number;
  maxPlugins?: number;
}

export interface ValidatedPluginWorkflowConfig extends Required<PluginWorkflowConfig> {
  pluginPaths: string[];
  scanInterval: number;
  maxFileSize: number;
  maxFiles: number;
  maxPlugins: number;
}

/**
 * Plugin-based workflow storage that loads workflows from npm packages.
 */
export class PluginWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  public readonly source: WorkflowSource;
  
  private readonly config: ValidatedPluginWorkflowConfig;
  private pluginCache: Map<string, WorkflowPlugin> = new Map();
  private lastScan: number = 0;

  constructor(config: PluginWorkflowConfig = {}, source?: WorkflowSource) {
    this.config = this.validateAndNormalizeConfig(config);
    this.source = source ?? createPluginSource('plugins', '1.0.0');
  }

  private validateAndNormalizeConfig(config: PluginWorkflowConfig): ValidatedPluginWorkflowConfig {
    const securityOptions = validateSecurityOptions({
      maxFileSizeBytes: config.maxFileSize || 1024 * 1024
    });

    const pluginPaths = (config.pluginPaths && config.pluginPaths.length > 0) 
      ? config.pluginPaths 
      : this.getDefaultPluginPaths();

    for (const pluginPath of pluginPaths) {
      try {
        if (path.isAbsolute(pluginPath)) {
          assertWithinBase(pluginPath, '/');
        }
      } catch (error) {
        throw new SecurityError(`Unsafe plugin path: ${pluginPath}: ${(error as Error).message}`);
      }
    }

    return {
      pluginPaths,
      scanInterval: Math.max(30000, config.scanInterval || 300000),
      maxFileSize: securityOptions.maxFileSizeBytes,
      maxFiles: Math.max(1, config.maxFiles || 50),
      maxPlugins: Math.max(1, config.maxPlugins || 20)
    };
  }

  private getDefaultPluginPaths(): string[] {
    const paths: string[] = [];
    
    try {
      const globalPath = require.resolve('npm').replace(/\/npm\/.*$/, '');
      const globalNodeModules = path.join(globalPath, 'node_modules');
      if (existsSync(globalNodeModules)) {
        paths.push(globalNodeModules);
      }
    } catch {
      const commonPaths = ['/usr/local/lib/node_modules', '/usr/lib/node_modules'];
      for (const commonPath of commonPaths) {
        if (existsSync(commonPath)) {
          paths.push(commonPath);
        }
      }
    }
    
    const localNodeModules = path.join(process.cwd(), 'node_modules');
    if (existsSync(localNodeModules)) {
      paths.push(localNodeModules);
    }
    
    return paths;
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    try {
      await this.scanPlugins();
      
      const workflows: Workflow[] = [];
      for (const plugin of this.pluginCache.values()) {
        workflows.push(...plugin.workflows);
      }
      
      return workflows;
    } catch (error) {
      if (error instanceof StorageError || error instanceof SecurityError || error instanceof InvalidWorkflowError) {
        throw error;
      }
      throw new StorageError(`Failed to load plugin workflows: ${(error as Error).message}`);
    }
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    const sanitizedId = sanitizeId(id);
    const workflows = await this.loadAllWorkflows();
    return workflows.find(w => w.definition.id === sanitizedId) || null;
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    const workflows = await this.loadAllWorkflows();
    return workflows.map(toWorkflowSummary);
  }

  async save(): Promise<void> {
    throw new StorageError('Plugin-based storage is read-only. Publish workflows as npm packages instead.');
  }

  private async scanPlugins(): Promise<void> {
    const now = Date.now();
    if (now - this.lastScan < this.config.scanInterval) {
      return;
    }

    this.pluginCache.clear();
    let pluginCount = 0;
    
    for (const pluginPath of this.config.pluginPaths) {
      if (!existsSync(pluginPath)) continue;
      
      try {
        assertWithinBase(pluginPath, pluginPath);
        const entries = await fs.readdir(pluginPath);
        
        for (const entry of entries) {
          if (pluginCount >= this.config.maxPlugins) {
            throw new StorageError(
              `Too many plugins found (${pluginCount}), maximum allowed: ${this.config.maxPlugins}`
            );
          }

          if (this.isWorkflowPlugin(entry)) {
            const fullPath = path.join(pluginPath, entry);
            assertWithinBase(fullPath, pluginPath);
            
            const plugin = await this.loadPlugin(fullPath);
            if (plugin) {
              this.pluginCache.set(plugin.name, plugin);
              pluginCount++;
            }
          }
        }
      } catch (error) {
        if (error instanceof SecurityError || error instanceof StorageError) {
          throw error;
        }
        throw new StorageError(`Failed to scan plugin directory ${pluginPath}: ${(error as Error).message}`);
      }
    }
    
    this.lastScan = now;
  }

  private isWorkflowPlugin(entry: string): boolean {
    return entry.startsWith('workrail-workflows-') || entry.startsWith('@workrail/workflows-');
  }

  private async loadPlugin(pluginPath: string): Promise<WorkflowPlugin | null> {
    try {
      assertWithinBase(pluginPath, path.dirname(pluginPath));
      
      const packageJsonPath = path.join(pluginPath, 'package.json');
      if (!existsSync(packageJsonPath)) return null;
      
      assertWithinBase(packageJsonPath, pluginPath);
      
      const packageStats = await fs.stat(packageJsonPath);
      validateFileSize(packageStats.size, Math.min(this.config.maxFileSize, 64 * 1024), 'package.json');
      
      const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
      
      let packageJson: Record<string, unknown>;
      try {
        packageJson = JSON.parse(packageContent);
      } catch (parseError) {
        throw new InvalidWorkflowError(pluginPath, `Invalid package.json: ${(parseError as Error).message}`);
      }
      
      if (!packageJson['workrail'] || !(packageJson['workrail'] as Record<string, unknown>)['workflows']) {
        return null;
      }
      
      if (!packageJson['name'] || typeof packageJson['name'] !== 'string') {
        throw new InvalidWorkflowError(pluginPath, 'Invalid package name');
      }
      
      const workflowsPath = path.join(pluginPath, 'workflows');
      if (!existsSync(workflowsPath)) return null;
      
      assertWithinBase(workflowsPath, pluginPath);
      
      // Create source for this specific plugin
      const pluginSource = createPluginSource(
        packageJson['name'] as string,
        (packageJson['version'] as string) || '0.0.0'
      );
      
      const workflows = await this.loadWorkflowsFromDirectory(workflowsPath, pluginSource);
      
      return {
        name: packageJson['name'] as string,
        version: (packageJson['version'] as string) || '0.0.0',
        workflows,
        metadata: {
          author: packageJson['author'] as string | undefined,
          description: packageJson['description'] as string | undefined,
          homepage: packageJson['homepage'] as string | undefined,
          repository: (packageJson['repository'] as Record<string, unknown>)?.['url'] as string || packageJson['repository'] as string | undefined
        }
      };
    } catch (error) {
      if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
        throw error;
      }
      throw new StorageError(`Failed to load plugin from ${pluginPath}: ${(error as Error).message}`);
    }
  }

  private async loadWorkflowsFromDirectory(workflowsPath: string, pluginSource: WorkflowSource): Promise<Workflow[]> {
    const workflows: Workflow[] = [];
    
    try {
      const files = await fs.readdir(workflowsPath);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      if (jsonFiles.length > this.config.maxFiles) {
        throw new StorageError(
          `Too many workflow files in ${workflowsPath} (${jsonFiles.length}), maximum allowed: ${this.config.maxFiles}`
        );
      }
      
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(workflowsPath, file);
          assertWithinBase(filePath, workflowsPath);
          
          const stats = await fs.stat(filePath);
          validateFileSize(stats.size, this.config.maxFileSize, file);
          
          const content = await fs.readFile(filePath, 'utf-8');
          
          let definition: WorkflowDefinition;
          try {
            definition = JSON.parse(content) as WorkflowDefinition;
          } catch (parseError) {
            throw new InvalidWorkflowError(file, `Invalid JSON in workflow file: ${(parseError as Error).message}`);
          }
          
          const sanitizedId = sanitizeId(definition.id);
          if (definition.id !== sanitizedId) {
            throw new InvalidWorkflowError(definition.id, `Invalid workflow ID in file ${file}`);
          }
          
          workflows.push(createWorkflow(definition, pluginSource));
        } catch (error) {
          if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
            throw error;
          }
          throw new StorageError(`Failed to load workflow from ${file}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      if (error instanceof StorageError || error instanceof SecurityError || error instanceof InvalidWorkflowError) {
        throw error;
      }
      throw new StorageError(`Failed to read workflows directory ${workflowsPath}: ${(error as Error).message}`);
    }
    
    return workflows;
  }

  public getLoadedPlugins(): WorkflowPlugin[] {
    return Array.from(this.pluginCache.values());
  }

  public getConfig(): ValidatedPluginWorkflowConfig {
    return { ...this.config };
  }
}
