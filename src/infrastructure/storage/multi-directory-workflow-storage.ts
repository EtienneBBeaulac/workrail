/**
 * Multi-Directory Workflow Provider
 * 
 * Orchestrates multiple FileWorkflowProviders.
 * Merges workflows from bundled, user, and project directories.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { Result, ok, err } from 'neverthrow';
import type { WorkflowId, Workflow } from '../../types/schemas.js';
import type { IWorkflowProvider } from '../../types/repository.js';
import type { AppError } from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';
import { FileWorkflowProvider } from './file-workflow-storage.js';
import type { Logger } from '../../core/logging/index.js';

export interface MultiDirectoryOptions {
  includeBundled?: boolean;
  includeUser?: boolean;
  includeProject?: boolean;
  customPaths?: string[];
  projectPath?: string;
  userPath?: string;
  logger?: Logger;
  fileStorageOptions?: any;
}

/**
 * Combines workflows from multiple directories.
 * Later directories override earlier ones (by ID).
 */
export class MultiDirectoryWorkflowProvider implements IWorkflowProvider {
  private providers: FileWorkflowProvider[] = [];
  private readonly logger?: Logger;

  constructor(options: MultiDirectoryOptions = {}) {
    this.logger = options.logger;
    const directories = this.resolveDirectories(options);
    
    this.providers = directories.map(dir => 
      new FileWorkflowProvider(dir, { ...options.fileStorageOptions, logger: this.logger })
    );
  }

  async fetchAll(): Promise<Result<readonly Workflow[], AppError>> {
    const results = await Promise.allSettled(
      this.providers.map(p => p.fetchAll())
    );
    
    // Collect all workflows (graceful degradation)
    const allWorkflows: Workflow[] = [];
    const seenIds = new Set<any>();  // TODO: Set<WorkflowId>
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.isOk()) {
        for (const wf of result.value.value) {
          if (seenIds.has(wf.id as any)) {
            // Later source overrides earlier
            const index = allWorkflows.findIndex(w => w.id === wf.id);
            if (index >= 0) allWorkflows[index] = wf;
          } else {
            allWorkflows.push(wf);
            seenIds.add(wf.id as any);
          }
        }
      }
    }
    
    return ok(allWorkflows);
  }

  async fetchById(id: WorkflowId): Promise<Result<Workflow, AppError>> {
    // Search in reverse (later sources take precedence)
    for (let i = this.providers.length - 1; i >= 0; i--) {
      const result = await this.providers[i]!.fetchById(id);
      if (result.isOk()) return result;
    }
    
    return err(Err.workflowNotFound(id as any as string, [], 0, []));
  }
  
  private resolveDirectories(options: MultiDirectoryOptions): string[] {
    const dirs: string[] = [];
    
    if (options.includeBundled !== false) {
      const bundled = path.resolve(__dirname, '../../../workflows');
      if (existsSync(bundled)) dirs.push(bundled);
    }
    
    if (options.includeUser !== false) {
      const user = options.userPath || path.join(os.homedir(), '.workrail', 'workflows');
      if (existsSync(user)) dirs.push(user);
    }
    
    if (options.customPaths) {
      for (const custom of options.customPaths) {
        if (existsSync(custom)) dirs.push(custom);
      }
    }
    
    if (options.includeProject !== false) {
      const project = options.projectPath || path.join(process.cwd(), 'workflows');
      if (existsSync(project)) dirs.push(project);
    }
    
    return dirs;
  }
}

// Alias
export const MultiDirectoryWorkflowStorage = MultiDirectoryWorkflowProvider;

export async function initializeUserWorkflowDirectory(): Promise<string> {
  const userDir = path.join(os.homedir(), '.workrail', 'workflows');
  await fs.mkdir(userDir, { recursive: true });
  
  const samplePath = path.join(userDir, 'example.json');
  if (!existsSync(samplePath)) {
    await fs.writeFile(samplePath, JSON.stringify({
      id: 'example-workflow',
      name: 'Example Workflow',
      version: '1.0.0',
      description: 'Sample workflow to get you started',
      steps: [{
        id: 'step-1',
        title: 'First Step',
        prompt: 'Do something'
      }]
    }, null, 2));
  }
  
  return userDir;
}

export function createMultiDirectoryWorkflowStorage(options?: MultiDirectoryOptions): MultiDirectoryWorkflowProvider {
  return new MultiDirectoryWorkflowProvider(options);
}
