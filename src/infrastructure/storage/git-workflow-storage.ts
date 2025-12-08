/**
 * Git-Based Workflow Provider
 * 
 * Clones/pulls workflows from Git repositories.
 * Result-based, no exceptions in main paths.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import { Result, ok, err } from 'neverthrow';
import type { WorkflowId, Workflow } from '../../types/schemas.js';
import { WorkflowSchema } from '../../types/schemas.js';
import type { IWorkflowProvider } from '../../types/repository.js';
import type { AppError } from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';
import { validateJSONLoad } from '../../core/errors/index.js';
import type { Logger } from '../../core/logging/index.js';

const execAsync = promisify(exec);

export interface GitWorkflowConfig {
  repositoryUrl: string;
  branch?: string;
  localPath?: string;
  syncInterval?: number;
  authToken?: string;
  maxFileSize?: number;
  maxFiles?: number;
  skipSandboxCheck?: boolean;
}

/**
 * Git-based workflow provider.
 * Clones repository, loads workflows with validation.
 */
export class GitWorkflowProvider implements IWorkflowProvider {
  private readonly config: Required<GitWorkflowConfig>;
  private readonly localPath: string;
  private lastSync: number = 0;
  private isCloning: boolean = false;

  constructor(
    config: GitWorkflowConfig,
    private readonly logger: Logger
  ) {
    this.config = {
      repositoryUrl: config.repositoryUrl,
      branch: config.branch || 'main',
      localPath: config.localPath || path.join(os.homedir(), '.workrail', 'cache', 'git-workflows'),
      syncInterval: config.syncInterval ?? 60,
      authToken: config.authToken || '',
      maxFileSize: config.maxFileSize || 1024 * 1024,
      maxFiles: config.maxFiles || 100,
      skipSandboxCheck: config.skipSandboxCheck || false,
    };
    this.localPath = this.config.localPath;
  }

  async fetchAll(): Promise<Result<readonly Workflow[], AppError>> {
    // Ensure repository is cloned/updated
    const ensureResult = await this.ensureRepository();
    if (ensureResult.isErr()) return err(ensureResult.error);
    
    const workflowsPath = path.join(this.localPath, 'workflows');
    if (!existsSync(workflowsPath)) {
      this.logger.warn({ workflowsPath }, 'Workflows directory not found');
      return ok([]);
    }
    
    try {
      const files = await fs.readdir(workflowsPath);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      if (jsonFiles.length > this.config.maxFiles) {
        return err(Err.unexpectedError('too many files', new Error(`${jsonFiles.length} files exceeds max ${this.config.maxFiles}`)));
      }
      
      // Load all workflows (parallel, graceful degradation)
      const results = await Promise.allSettled(
        jsonFiles.map(file => this.loadWorkflowFile(path.join(workflowsPath, file)))
      );
      
      const workflows = results
        .filter((r): r is PromiseFulfilledResult<Workflow | null> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter((wf): wf is Workflow => wf !== null);
      
      return ok(workflows);
    } catch (error) {
      return err(Err.unexpectedError('git fetchAll', error as Error));
    }
  }

  async fetchById(id: WorkflowId): Promise<Result<Workflow, AppError>> {
    // For Git, we fetch all and find (inefficient but simple)
    // TODO: Could optimize by loading single file
    const allResult = await this.fetchAll();
    if (allResult.isErr()) return err(allResult.error);
    
    const workflow = allResult.value.find(w => w.id === id);
    if (!workflow) {
      const allIds = allResult.value.map(w => w.id as any as string);
      return err(Err.workflowNotFound(id as any as string, [], allIds.length, []));
    }
    
    return ok(workflow);
  }
  
  // ===========================================================================
  // Private: Git Operations
  // ===========================================================================
  
  private async ensureRepository(): Promise<Result<void, AppError>> {
    if (this.isCloning) {
      // Wait for clone
      let attempts = 0;
      while (this.isCloning && attempts < 60) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }
      if (this.isCloning) {
        return err(Err.unexpectedError('clone timeout', new Error('Clone took >60s')));
      }
      return ok(undefined);
    }
    
    const shouldSync = !existsSync(this.localPath) || 
      (Date.now() - this.lastSync) > (this.config.syncInterval * 60 * 1000);
    
    if (!shouldSync) return ok(undefined);
    
    this.isCloning = true;
    
    try {
      if (!existsSync(this.localPath)) {
        await this.cloneRepository();
      } else {
        await this.pullRepository();
      }
      this.lastSync = Date.now();
      return ok(undefined);
    } catch (error) {
      return err(Err.unexpectedError('git ensure', error as Error));
    } finally {
      this.isCloning = false;
    }
  }
  
  private async cloneRepository(): Promise<void> {
    this.logger.info({ url: this.config.repositoryUrl, branch: this.config.branch }, 'Cloning repository');
    
    await fs.mkdir(path.dirname(this.localPath), { recursive: true });
    
    let cloneUrl = this.config.repositoryUrl;
    if (cloneUrl.startsWith('/')) {
      cloneUrl = `file://${cloneUrl}`;
    }
    
    const command = `git clone --branch ${this.esc(this.config.branch)} ${this.esc(cloneUrl)} ${this.esc(this.localPath)}`;
    
    try {
      await execAsync(command, { timeout: 60000 });
      this.logger.info('Repository cloned');
    } catch (error) {
      // Try without branch (use default)
      const fallbackCommand = `git clone ${this.esc(cloneUrl)} ${this.esc(this.localPath)}`;
      await execAsync(fallbackCommand, { timeout: 60000 });
      this.logger.info('Repository cloned (default branch)');
    }
  }
  
  private async pullRepository(): Promise<void> {
    try {
      const cmd = `cd ${this.esc(this.localPath)} && git fetch origin ${this.esc(this.config.branch)} && git reset --hard origin/${this.esc(this.config.branch)}`;
      await execAsync(cmd, { timeout: 30000 });
      this.logger.info('Repository updated');
    } catch (error) {
      this.logger.warn({ err: error }, 'Git pull failed, using cached version');
    }
  }
  
  // ===========================================================================
  // Private: File Loading & Security
  // ===========================================================================
  
  private async loadWorkflowFile(filePath: string): Promise<Workflow | null> {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > this.config.maxFileSize) {
        this.logger.warn({ file: filePath }, 'File too large');
        return null;
      }
      
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      
      // Validate with Zod
      const validated = validateJSONLoad(WorkflowSchema, parsed, filePath);
      if (!validated.isOk()) {
        this.logger.warn({ file: filePath, err: validated.error }, 'Invalid workflow');
        return null;
      }
      
      return validated.value as any;  // TODO: fix typing
    } catch (error) {
      this.logger.warn({ err: error, file: filePath }, 'Failed to load workflow file');
      return null;
    }
  }
  
  private esc(arg: string): string {
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
  }
}

// Alias for backward compat
export const GitWorkflowStorage = GitWorkflowProvider;
