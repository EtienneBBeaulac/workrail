/**
 * Plugin-Based Workflow Provider
 * 
 * Loads workflows from npm packages.
 * Result-based, graceful degradation.
 */

import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { Result, ok, err } from 'neverthrow';
import type { WorkflowId, Workflow } from '../../types/schemas.js';
import { WorkflowSchema } from '../../types/schemas.js';
import type { IWorkflowProvider } from '../../types/repository.js';
import type { AppError } from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';
import { validateJSONLoad } from '../../core/errors/index.js';

export interface PluginWorkflowConfig {
  pluginPaths?: string[];
  maxFileSize?: number;
  logger?: any;
}

/**
 * Loads workflows from npm package plugins.
 */
export class PluginWorkflowProvider implements IWorkflowProvider {
  private readonly pluginPaths: string[];
  private readonly maxFileSize: number;
  private readonly logger: any;

  constructor(config: PluginWorkflowConfig) {
    this.pluginPaths = config.pluginPaths || [];
    this.maxFileSize = config.maxFileSize || 1024 * 1024;
    this.logger = config.logger;
  }

  async fetchAll(): Promise<Result<readonly Workflow[], AppError>> {
    const allWorkflows: Workflow[] = [];
    
    for (const pluginPath of this.pluginPaths) {
      try {
        const workflows = await this.loadFromPlugin(pluginPath);
        allWorkflows.push(...workflows);
      } catch (error) {
        this.logger?.warn({ err: error, pluginPath }, 'Failed to load plugin');
        // Continue with other plugins (graceful degradation)
      }
    }
    
    return ok(allWorkflows);
  }

  async fetchById(id: WorkflowId): Promise<Result<Workflow, AppError>> {
    const allResult = await this.fetchAll();
    if (allResult.isErr()) return err(allResult.error);
    
    const workflow = allResult.value.find(w => w.id === id);
    if (!workflow) {
      const allIds = allResult.value.map(w => w.id as any as string);
      return err(Err.workflowNotFound(id as any as string, [], allIds.length, []));
    }
    
    return ok(workflow);
  }
  
  private async loadFromPlugin(pluginPath: string): Promise<Workflow[]> {
    const workflowsDir = path.join(pluginPath, 'workflows');
    if (!existsSync(workflowsDir)) return [];
    
    const files = await fs.readdir(workflowsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    const workflows: Workflow[] = [];
    
    for (const file of jsonFiles) {
      const filePath = path.join(workflowsDir, file);
      const stats = await fs.stat(filePath);
      
      if (stats.size > this.maxFileSize) continue;
      
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      
      const validated = validateJSONLoad(WorkflowSchema, parsed, filePath);
      if (!validated.isOk()) {
        this.logger?.warn({ file, err: validated.error }, 'Invalid plugin workflow');
        continue;
      }
      
      workflows.push(validated.value as any);  // TODO: fix typing
    }
    
    return workflows;
  }
}

// Alias
export const PluginWorkflowStorage = PluginWorkflowProvider;
