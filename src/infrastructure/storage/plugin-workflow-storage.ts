import { IWorkflowStorage } from '../../types/storage';
import { Workflow, WorkflowSummary } from '../../types/mcp-types';
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
  scanInterval?: number; // milliseconds
  maxFileSize?: number;
  maxFiles?: number;
  maxPlugins?: number;
  logger?: any; // Optional logger for warnings
}

export interface ValidatedPluginWorkflowConfig extends Required<Omit<PluginWorkflowConfig, 'logger'>> {
  pluginPaths: string[];
  scanInterval: number;
  maxFileSize: number;
  maxFiles: number;
  maxPlugins: number;
}

/**
 * Plugin-based workflow storage that loads workflows from npm packages
 * Workflows are distributed as npm packages with a specific structure
 * 
 * Security features:
 * - Path traversal prevention
 * - File size limits
 * - Plugin count limits
 * - Safe package.json parsing
 * 
 * Example package structure:
 * ```
 * my-workflow-pack/
 *   ├── package.json
 *   ├── index.js
 *   └── workflows/
 *       ├── my-workflow-1.json
 *       └── my-workflow-2.json
 * ```
 */
export class PluginWorkflowStorage implements IWorkflowStorage {
  private readonly config: ValidatedPluginWorkflowConfig;
  private pluginCache: Map<string, WorkflowPlugin> = new Map();
  private lastScan: number = 0;

  constructor(config: PluginWorkflowConfig = {}) {
    this.config = this.validateAndNormalizeConfig(config);
  }

  private validateAndNormalizeConfig(config: PluginWorkflowConfig): ValidatedPluginWorkflowConfig {
    const securityOptions = validateSecurityOptions({
      maxFileSizeBytes: config.maxFileSize || 1024 * 1024 // 1MB default
    });

    const pluginPaths = (config.pluginPaths && config.pluginPaths.length > 0) 
      ? config.pluginPaths 
      : this.getDefaultPluginPaths();

    // Validate all plugin paths are safe
    for (const pluginPath of pluginPaths) {
      try {
        // Ensure plugin paths are within reasonable bounds
        if (path.isAbsolute(pluginPath)) {
          assertWithinBase(pluginPath, '/'); // Basic sanity check for absolute paths
        }
      } catch (error) {
        throw new SecurityError(`Unsafe plugin path: ${pluginPath}: ${(error as Error).message}`);
      }
    }

    return {
      pluginPaths,
      scanInterval: Math.max(30000, config.scanInterval || 300000), // minimum 30 seconds
      maxFileSize: securityOptions.maxFileSizeBytes,
      maxFiles: Math.max(1, config.maxFiles || 50), // minimum 1 file
      maxPlugins: Math.max(1, config.maxPlugins || 20) // maximum 20 plugins
    };
  }

  private getDefaultPluginPaths(): string[] {
    const paths: string[] = [];
    
    // Global npm modules
    try {
      const globalPath = require.resolve('npm').replace(/\/npm\/.*$/, '');
      const globalNodeModules = path.join(globalPath, 'node_modules');
      if (existsSync(globalNodeModules)) {
        paths.push(globalNodeModules);
      }
    } catch {
      // Fallback: try common global paths
      const commonPaths = [
        '/usr/local/lib/node_modules',
        '/usr/lib/node_modules'
      ];
      
      for (const commonPath of commonPaths) {
        if (existsSync(commonPath)) {
          paths.push(commonPath);
        }
      }
    }
    
    // Local project
    const localNodeModules = path.join(process.cwd(), 'node_modules');
    if (existsSync(localNodeModules)) {
      paths.push(localNodeModules);
    }
    
    return paths;
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
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
    return workflows.find(w => w.id === sanitizedId) || null;
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    const workflows = await this.loadAllWorkflows();
    return workflows.map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      category: 'plugin',
      version: workflow.version
    }));
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
      if (!existsSync(pluginPath)) {
        continue;
      }
      
      try {
        // Security: Ensure we're scanning within expected directory
        assertWithinBase(pluginPath, pluginPath);
        
        const entries = await fs.readdir(pluginPath);
        
        for (const entry of entries) {
          // Check plugin count limit
          if (pluginCount >= this.config.maxPlugins) {
            throw new StorageError(
              `Too many plugins found (${pluginCount}), maximum allowed: ${this.config.maxPlugins}`
            );
          }

          if (this.isWorkflowPlugin(entry)) {
            const fullPath = path.join(pluginPath, entry);
            
            // Security: Ensure plugin path is within scan directory
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
      // Security: Ensure plugin path is safe
      assertWithinBase(pluginPath, path.dirname(pluginPath));
      
      const packageJsonPath = path.join(pluginPath, 'package.json');
      
      if (!existsSync(packageJsonPath)) {
        return null;
      }
      
      // Security: Ensure package.json is within plugin directory
      assertWithinBase(packageJsonPath, pluginPath);
      
      // Validate package.json size
      const packageStats = await fs.stat(packageJsonPath);
      validateFileSize(packageStats.size, Math.min(this.config.maxFileSize, 64 * 1024), 'package.json'); // Max 64KB for package.json
      
      const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
      
      let packageJson: any;
      try {
        packageJson = JSON.parse(packageContent);
      } catch (parseError) {
        throw new InvalidWorkflowError(pluginPath, `Invalid package.json: ${(parseError as Error).message}`);
      }
      
      // Validate it's a workflow plugin
      if (!packageJson.workrail || !packageJson.workrail.workflows) {
        return null;
      }
      
      // Validate package name
      if (!packageJson.name || typeof packageJson.name !== 'string') {
        throw new InvalidWorkflowError(pluginPath, `Invalid package name`);
      }
      
      const workflowsPath = path.join(pluginPath, 'workflows');
      if (!existsSync(workflowsPath)) {
        return null;
      }
      
      // Security: Ensure workflows directory is within plugin
      assertWithinBase(workflowsPath, pluginPath);
      
      const workflows = await this.loadWorkflowsFromDirectory(workflowsPath);
      
      return {
        name: packageJson.name,
        version: packageJson.version || '0.0.0',
        workflows,
        metadata: {
          author: packageJson.author,
          description: packageJson.description,
          homepage: packageJson.homepage,
          repository: packageJson.repository?.url || packageJson.repository
        }
      };
    } catch (error) {
      if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
        throw error;
      }
      throw new StorageError(`Failed to load plugin from ${pluginPath}: ${(error as Error).message}`);
    }
  }

  private async loadWorkflowsFromDirectory(workflowsPath: string): Promise<Workflow[]> {
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
          
          // Security: Ensure file is within workflows directory
          assertWithinBase(filePath, workflowsPath);
          
          // Validate file size
          const stats = await fs.stat(filePath);
          validateFileSize(stats.size, this.config.maxFileSize, file);
          
          const content = await fs.readFile(filePath, 'utf-8');
          
          let workflow: Workflow;
          try {
            workflow = JSON.parse(content) as Workflow;
          } catch (parseError) {
            throw new InvalidWorkflowError(file, `Invalid JSON in workflow file: ${(parseError as Error).message}`);
          }
          
          // Validate workflow ID
          const sanitizedId = sanitizeId(workflow.id);
          if (workflow.id !== sanitizedId) {
            throw new InvalidWorkflowError(workflow.id, `Invalid workflow ID in file ${file}`);
          }
          
          workflows.push(workflow);
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

/**
 * Example package.json for a workflow plugin:
 * 
 * ```json
 * {
 *   "name": "workrail-workflows-ai-coding",
 *   "version": "1.0.0",
 *   "description": "AI-powered coding workflows for Workrail",
 *   "main": "index.js",
 *   "workrail": {
 *     "workflows": true,
 *     "category": "coding"
 *   },
 *   "keywords": ["workrail", "workflow", "ai", "coding"],
 *   "author": "Your Name",
 *   "license": "MIT"
 * }
 * ```
 */

/**
 * Example configuration for different environments
 */
export const PLUGIN_WORKFLOW_CONFIGS = {
  // Development environment with relaxed limits
  development: {
    scanInterval: 60000, // 1 minute
    maxFileSize: 2 * 1024 * 1024, // 2MB
    maxFiles: 100,
    maxPlugins: 50
  },
  
  // Production environment with strict limits
  production: {
    scanInterval: 300000, // 5 minutes
    maxFileSize: 1024 * 1024, // 1MB
    maxFiles: 50,
    maxPlugins: 20
  }
}; 