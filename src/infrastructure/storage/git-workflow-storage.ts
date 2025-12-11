import { IWorkflowStorage } from '../../types/storage';
import { 
  Workflow, 
  WorkflowSummary,
  WorkflowDefinition,
  WorkflowSource,
  createWorkflow,
  toWorkflowSummary,
  createGitRepositorySource
} from '../../types/workflow';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import { 
  sanitizeId, 
  assertWithinBase, 
  validateFileSize,
  validateSecurityOptions
} from '../../utils/storage-security';
import { StorageError, InvalidWorkflowError, SecurityError } from '../../core/error-handler';
import { createLogger } from '../../utils/logger';

const execAsync = promisify(exec);
const logger = createLogger('GitWorkflowStorage');

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

export interface ValidatedGitWorkflowConfig extends Required<Omit<GitWorkflowConfig, 'skipSandboxCheck'>> {
  maxFileSize: number;
  maxFiles: number;
  skipSandboxCheck?: boolean;
}

/**
 * Git-based workflow storage that clones/pulls workflows from a Git repository.
 */
export class GitWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  public readonly source: WorkflowSource;
  
  private readonly config: ValidatedGitWorkflowConfig;
  private readonly localPath: string;
  private lastSync: number = 0;
  private isCloning: boolean = false;

  constructor(config: GitWorkflowConfig, source?: WorkflowSource) {
    this.config = this.validateAndNormalizeConfig(config);
    this.localPath = this.config.localPath;
    
    // Use provided source or create one from config
    this.source = source ?? createGitRepositorySource(
      this.config.repositoryUrl,
      this.config.branch,
      this.localPath
    );
    
    logger.info('Git workflow storage initialized', {
      repositoryUrl: this.config.repositoryUrl,
      branch: this.config.branch,
      localPath: this.localPath
    });
  }

  private validateAndNormalizeConfig(config: GitWorkflowConfig): ValidatedGitWorkflowConfig {
    if (!config.repositoryUrl?.trim()) {
      throw new StorageError('Repository URL is required for Git workflow storage');
    }

    if (!this.isValidGitUrl(config.repositoryUrl)) {
      throw new SecurityError('Invalid or potentially unsafe repository URL');
    }

    const securityOptions = validateSecurityOptions({
      maxFileSizeBytes: config.maxFileSize || 1024 * 1024
    });

    const defaultCacheDir = path.join(os.homedir(), '.workrail', 'cache');
    const localPath = config.localPath || path.join(defaultCacheDir, 'community-workflows');
    
    if (!config.skipSandboxCheck) {
      try {
        const safeBaseDir = config.localPath 
          ? path.dirname(path.dirname(config.localPath))
          : path.join(os.homedir(), '.workrail');
        assertWithinBase(localPath, safeBaseDir);
      } catch (error) {
        throw new SecurityError(`Local path outside safe boundaries: ${(error as Error).message}`);
      }
    }

    return {
      repositoryUrl: config.repositoryUrl.trim(),
      branch: this.sanitizeGitRef(config.branch || 'main'),
      localPath,
      syncInterval: config.syncInterval !== undefined ? Math.max(0, config.syncInterval) : 60,
      authToken: config.authToken || '',
      maxFileSize: securityOptions.maxFileSizeBytes,
      maxFiles: config.maxFiles || 100
    };
  }

  private isValidGitUrl(url: string): boolean {
    const sshPattern = /^git@[\w.-]+:[\w\/-]+\.git$/;
    if (sshPattern.test(url)) return true;
    if (url.startsWith('ssh://')) return true;
    if (url.startsWith('/') || url.startsWith('file://')) return true;
    
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'git:') {
        const hostname = parsed.hostname;
        const pathname = parsed.pathname;
        if (!hostname || hostname.length === 0) return false;
        if (!pathname || pathname === '/') return false;
        if (hostname.includes('..') || pathname.includes('..')) return false;
        return true;
      }
      if (parsed.protocol === 'file:') return true;
      return false;
    } catch {
      return url.startsWith('/');
    }
  }
  
  private isSshUrl(url: string): boolean {
    return url.startsWith('git@') || url.startsWith('ssh://');
  }

  private sanitizeGitRef(ref: string): string {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(ref)) {
      throw new SecurityError('Git reference contains unsafe characters');
    }
    return ref;
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    try {
      logger.debug('Loading workflows from Git repository');
      await this.ensureRepository();
      
      const workflowsPath = path.join(this.localPath, 'workflows');
      if (!existsSync(workflowsPath)) {
        logger.warn('Workflows directory not found in repository', { workflowsPath });
        return [];
      }

      const files = await fs.readdir(workflowsPath);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      if (jsonFiles.length > this.config.maxFiles) {
        throw new StorageError(
          `Too many workflow files (${jsonFiles.length}), maximum allowed: ${this.config.maxFiles}`
        );
      }
      
      const workflows: Workflow[] = [];
      
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(workflowsPath, file);
          assertWithinBase(filePath, workflowsPath);
          
          const stats = await fs.stat(filePath);
          validateFileSize(stats.size, this.config.maxFileSize, file);
          
          const content = await fs.readFile(filePath, 'utf-8');
          const definition = JSON.parse(content) as WorkflowDefinition;
          
          const expectedFilename = `${sanitizeId(definition.id)}.json`;
          if (file !== expectedFilename) {
            throw new InvalidWorkflowError(
              definition.id,
              `Workflow ID '${definition.id}' doesn't match filename '${file}'`
            );
          }
          
          workflows.push(createWorkflow(definition, this.source));
        } catch (error) {
          if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
            throw error;
          }
          throw new StorageError(`Failed to load workflow from ${file}: ${(error as Error).message}`);
        }
      }
      
      logger.info('Successfully loaded workflows from Git repository', {
        repositoryUrl: this.config.repositoryUrl,
        count: workflows.length
      });
      
      return workflows;
    } catch (error) {
      logger.error('Failed to load workflows from Git repository', error);
      if (error instanceof StorageError || error instanceof SecurityError || error instanceof InvalidWorkflowError) {
        throw error;
      }
      throw new StorageError(`Failed to load workflows from Git repository: ${(error as Error).message}`);
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

  async save(definition: WorkflowDefinition): Promise<void> {
    try {
      const sanitizedId = sanitizeId(definition.id);
      if (definition.id !== sanitizedId) {
        throw new InvalidWorkflowError(definition.id, `Invalid workflow ID: ${definition.id}`);
      }

      await this.ensureRepository();
      
      const workflowsPath = path.join(this.localPath, 'workflows');
      await fs.mkdir(workflowsPath, { recursive: true });
      
      const filename = `${sanitizedId}.json`;
      const filePath = path.join(workflowsPath, filename);
      assertWithinBase(filePath, workflowsPath);
      
      const content = JSON.stringify(definition, null, 2);
      validateFileSize(Buffer.byteLength(content, 'utf-8'), this.config.maxFileSize, definition.id);
      
      await fs.writeFile(filePath, content);
      await this.gitCommitAndPush(definition);
    } catch (error) {
      if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
        throw error;
      }
      throw new StorageError(`Failed to save workflow to Git repository: ${(error as Error).message}`);
    }
  }

  private async ensureRepository(): Promise<void> {
    if (this.isCloning) {
      let attempts = 0;
      const maxAttempts = 60;
      
      while (this.isCloning && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }
      
      if (this.isCloning) {
        throw new StorageError('Repository clone operation timed out');
      }
      return;
    }

    const shouldSync = !existsSync(this.localPath) || 
      (Date.now() - this.lastSync) > (this.config.syncInterval * 60 * 1000);
    
    if (!shouldSync) return;

    this.isCloning = true;
    
    try {
      if (!existsSync(this.localPath)) {
        await this.cloneRepository();
      } else {
        await this.pullRepository();
      }
      this.lastSync = Date.now();
    } catch (error) {
      throw new StorageError(`Failed to ensure Git repository: ${(error as Error).message}`);
    } finally {
      this.isCloning = false;
    }
  }

  private async cloneRepository(): Promise<void> {
    logger.info('Cloning Git repository', {
      repositoryUrl: this.config.repositoryUrl,
      branch: this.config.branch
    });
    
    const parentDir = path.dirname(this.localPath);
    await fs.mkdir(parentDir, { recursive: true });
    
    let cloneUrl = this.config.repositoryUrl;
    if (cloneUrl.startsWith('/')) {
      cloneUrl = `file://${cloneUrl}`;
    }
    
    if (!this.isSshUrl(this.config.repositoryUrl) && this.config.authToken && cloneUrl.startsWith('https://')) {
      cloneUrl = cloneUrl.replace('https://', `https://${this.config.authToken}@`);
    }
    
    const escapedUrl = this.escapeShellArg(cloneUrl);
    const escapedBranch = this.escapeShellArg(this.config.branch);
    const escapedPath = this.escapeShellArg(this.localPath);
    
    let command = `git clone --branch ${escapedBranch} ${escapedUrl} ${escapedPath}`;
    
    try {
      await execAsync(command, { timeout: 60000 });
      logger.info('Successfully cloned repository', { branch: this.config.branch });
    } catch (error) {
      const errorMsg = (error as Error).message;
      
      if (errorMsg.includes('Remote branch') && errorMsg.includes('not found')) {
        command = `git clone ${escapedUrl} ${escapedPath}`;
        
        try {
          await execAsync(command, { timeout: 60000 });
          const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: this.localPath });
          this.config.branch = stdout.trim();
        } catch (fallbackError) {
          throw new StorageError(`Failed to clone workflow repository: ${(fallbackError as Error).message}`);
        }
      } else {
        throw new StorageError(`Failed to clone workflow repository: ${errorMsg}`);
      }
    }
  }

  private async pullRepository(): Promise<void> {
    const escapedPath = this.escapeShellArg(this.localPath);
    const escapedBranch = this.escapeShellArg(this.config.branch);
    
    try {
      await execAsync(`cd ${escapedPath} && git fetch origin ${escapedBranch}`, { timeout: 30000 });
      await execAsync(`cd ${escapedPath} && git reset --hard origin/${escapedBranch}`, { timeout: 30000 });
    } catch {
      try {
        await execAsync(`cd ${escapedPath} && git pull origin ${escapedBranch}`, { timeout: 30000 });
      } catch (pullError) {
        logger.warn('Git pull failed, using cached version', pullError);
      }
    }
  }

  private async gitCommitAndPush(definition: WorkflowDefinition): Promise<void> {
    const escapedPath = this.escapeShellArg(this.localPath);
    const escapedFilename = this.escapeShellArg(`workflows/${definition.id}.json`);
    const escapedMessage = this.escapeShellArg(`Add/update workflow: ${definition.name}`);
    const escapedBranch = this.escapeShellArg(this.config.branch);
    
    const command = [
      `cd ${escapedPath}`,
      `git add ${escapedFilename}`,
      `git commit -m ${escapedMessage}`,
      `git push origin ${escapedBranch}`
    ].join(' && ');
    
    try {
      await execAsync(command, { timeout: 60000 });
    } catch (error) {
      throw new StorageError(`Failed to push workflow to repository: ${(error as Error).message}`);
    }
  }

  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
  }
}
