import { IWorkflowStorage } from '../../types/storage';
import { Workflow, WorkflowSummary } from '../../types/mcp-types';
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
  syncInterval?: number; // minutes
  authToken?: string;
  maxFileSize?: number;
  maxFiles?: number;
  skipSandboxCheck?: boolean; // For testing only - allows arbitrary paths
}

export interface ValidatedGitWorkflowConfig extends Required<Omit<GitWorkflowConfig, 'skipSandboxCheck'>> {
  maxFileSize: number;
  maxFiles: number;
  skipSandboxCheck?: boolean;
}

/**
 * Git-based workflow storage that clones/pulls workflows from a Git repository
 * Perfect for community-driven workflow contributions via GitHub/GitLab
 * 
 * Security features:
 * - Git command injection protection
 * - Path traversal prevention  
 * - File size limits
 * - Repository URL validation
 */
export class GitWorkflowStorage implements IWorkflowStorage {
  private readonly config: ValidatedGitWorkflowConfig;
  private readonly localPath: string;
  private lastSync: number = 0;
  private isCloning: boolean = false;

  constructor(config: GitWorkflowConfig) {
    this.config = this.validateAndNormalizeConfig(config);
    this.localPath = this.config.localPath;
    
    logger.info('Git workflow storage initialized', {
      repositoryUrl: this.config.repositoryUrl,
      branch: this.config.branch,
      localPath: this.localPath,
      syncInterval: this.config.syncInterval
    });
  }

  private validateAndNormalizeConfig(config: GitWorkflowConfig): ValidatedGitWorkflowConfig {
    if (!config.repositoryUrl?.trim()) {
      throw new StorageError('Repository URL is required for Git workflow storage');
    }

    // Validate repository URL format and security
    if (!this.isValidGitUrl(config.repositoryUrl)) {
      throw new SecurityError('Invalid or potentially unsafe repository URL');
    }

    const securityOptions = validateSecurityOptions({
      maxFileSizeBytes: config.maxFileSize || 1024 * 1024 // 1MB default
    });

    // Use home directory for cache by default (more predictable than process.cwd() when running via MCP/npx)
    const defaultCacheDir = path.join(os.homedir(), '.workrail', 'cache');
    const localPath = config.localPath || 
      path.join(defaultCacheDir, 'community-workflows');
    
    // Ensure local path is within safe boundaries (skip for tests)
    // For Git repos, validate against the cache directory, not process.cwd()
    // This is important when running via MCP/npx where process.cwd() is unpredictable
    if (!config.skipSandboxCheck) {
      try {
        // Determine the safe base directory: either the configured cache dir or home directory
        const safeBaseDir = config.localPath 
          ? path.dirname(path.dirname(config.localPath)) // Parent of parent (e.g., ~/.workrail from ~/.workrail/cache/repo-name)
          : path.join(os.homedir(), '.workrail'); // Default safe zone
        
        assertWithinBase(localPath, safeBaseDir);
      } catch (error) {
        throw new SecurityError(`Local path outside safe boundaries: ${(error as Error).message}`);
      }
    }

    return {
      repositoryUrl: config.repositoryUrl.trim(),
      branch: this.sanitizeGitRef(config.branch || 'main'),
      localPath,
      syncInterval: config.syncInterval !== undefined ? Math.max(0, config.syncInterval) : 60, // default 60 minutes, allow 0 for testing
      authToken: config.authToken || '',
      maxFileSize: securityOptions.maxFileSizeBytes,
      maxFiles: config.maxFiles || 100 // default 100 files
    };
  }

  private isValidGitUrl(url: string): boolean {
    // SSH format: git@github.com:org/repo.git
    const sshPattern = /^git@[\w.-]+:[\w\/-]+\.git$/;
    if (sshPattern.test(url)) {
      return true;
    }
    
    // SSH URL format: ssh://git@github.com/org/repo.git
    if (url.startsWith('ssh://')) {
      return true;
    }
    
    // Local file paths (for testing and local repos)
    // /path/to/repo or file:///path/to/repo
    if (url.startsWith('/') || url.startsWith('file://')) {
      return true;
    }
    
    // HTTPS/Git protocol
    try {
      const parsed = new URL(url);
      
      // For HTTPS/Git protocols, validate basic URL structure
      // This allows both well-known hosts and self-hosted Git servers
      if (parsed.protocol === 'https:' || parsed.protocol === 'git:') {
        // Basic validation: must have a hostname and path that looks like a repo
        // Reject obviously dangerous patterns
        const hostname = parsed.hostname;
        const pathname = parsed.pathname;
        
        // Hostname must be valid (no empty, no localhost in production unless testing)
        if (!hostname || hostname.length === 0) {
          return false;
        }
        
        // Must have a path that looks like a repository (contains at least one segment)
        if (!pathname || pathname === '/') {
          return false;
        }
        
        // Reject URLs with suspicious patterns
        if (hostname.includes('..') || pathname.includes('..')) {
          return false;
        }
        
        return true;
      }
      
      // file:// protocol is valid
      if (parsed.protocol === 'file:') {
        return true;
      }
      
      return false;
    } catch {
      // If URL parsing fails, might be a local path
      return url.startsWith('/');
    }
  }
  
  private isSshUrl(url: string): boolean {
    return url.startsWith('git@') || url.startsWith('ssh://');
  }

  private sanitizeGitRef(ref: string): string {
    // Prevent Git injection by allowing only safe characters
    if (!/^[a-zA-Z0-9/_.-]+$/.test(ref)) {
      throw new SecurityError('Git reference contains unsafe characters');
    }
    return ref;
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
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
      
      logger.debug('Found workflow files', { count: jsonFiles.length });
      
      if (jsonFiles.length > this.config.maxFiles) {
        throw new StorageError(
          `Too many workflow files (${jsonFiles.length}), maximum allowed: ${this.config.maxFiles}`
        );
      }
      
      const workflows: Workflow[] = [];
      
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(workflowsPath, file);
          
          // Security: Ensure file is within expected directory
          assertWithinBase(filePath, workflowsPath);
          
                     // Validate file size
           const stats = await fs.stat(filePath);
           validateFileSize(stats.size, this.config.maxFileSize, file);
           
           const content = await fs.readFile(filePath, 'utf-8');
           const workflow = JSON.parse(content) as Workflow;
           
           // Validate workflow ID matches filename (security)
           const expectedFilename = `${sanitizeId(workflow.id)}.json`;
           if (file !== expectedFilename) {
             throw new InvalidWorkflowError(
               workflow.id,
               `Workflow ID '${workflow.id}' doesn't match filename '${file}'`
             );
           }
           
           workflows.push(workflow);
           logger.debug('Loaded workflow', { id: workflow.id, name: workflow.name });
         } catch (error) {
           if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
             throw error;
           }
           throw new StorageError(`Failed to load workflow from ${file}: ${(error as Error).message}`);
         }
       }
       
       logger.info('Successfully loaded workflows from Git repository', {
         repositoryUrl: this.config.repositoryUrl,
         count: workflows.length,
         workflows: workflows.map(w => ({ id: w.id, name: w.name }))
       });
       
       return workflows;
     } catch (error) {
       logger.error('Failed to load workflows from Git repository', error, {
         repositoryUrl: this.config.repositoryUrl
       });
       if (error instanceof StorageError || error instanceof SecurityError || error instanceof InvalidWorkflowError) {
         throw error;
       }
       throw new StorageError(`Failed to load workflows from Git repository: ${(error as Error).message}`);
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
      category: 'community',
      version: workflow.version
    }));
  }

  async save(workflow: Workflow): Promise<void> {
    try {
      // Validate workflow ID
      const sanitizedId = sanitizeId(workflow.id);
      if (workflow.id !== sanitizedId) {
        throw new InvalidWorkflowError(workflow.id, `Invalid workflow ID: ${workflow.id}`);
      }

      await this.ensureRepository();
      
      const workflowsPath = path.join(this.localPath, 'workflows');
      await fs.mkdir(workflowsPath, { recursive: true });
      
      const filename = `${sanitizedId}.json`;
      const filePath = path.join(workflowsPath, filename);
      
      // Security: Ensure we're writing within expected directory
      assertWithinBase(filePath, workflowsPath);
      
      const content = JSON.stringify(workflow, null, 2);
      
             // Validate content size
       validateFileSize(Buffer.byteLength(content, 'utf-8'), this.config.maxFileSize, workflow.id);
       
       await fs.writeFile(filePath, content);
       
       // Git commit and push
       await this.gitCommitAndPush(workflow);
     } catch (error) {
       if (error instanceof SecurityError || error instanceof InvalidWorkflowError) {
         throw error;
       }
       throw new StorageError(`Failed to save workflow to Git repository: ${(error as Error).message}`);
    }
  }

  private async ensureRepository(): Promise<void> {
    if (this.isCloning) {
      // Wait for clone to complete
      let attempts = 0;
      const maxAttempts = 60; // 1 minute max wait
      
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
    
    if (!shouldSync) {
      return;
    }

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
      branch: this.config.branch,
      localPath: this.localPath
    });
    
    const parentDir = path.dirname(this.localPath);
    await fs.mkdir(parentDir, { recursive: true });
    
    // Prepare URL based on protocol
    let cloneUrl = this.config.repositoryUrl;
    
    // For local paths, convert to file:// URL for proper remote tracking
    if (cloneUrl.startsWith('/')) {
      cloneUrl = `file://${cloneUrl}`;
      logger.debug('Converted local path to file:// URL', { cloneUrl });
    }
    
    // For HTTPS URLs with token, inject token into URL
    if (!this.isSshUrl(this.config.repositoryUrl) && this.config.authToken && cloneUrl.startsWith('https://')) {
      cloneUrl = cloneUrl.replace('https://', `https://${this.config.authToken}@`);
      logger.debug('Injected auth token into URL');
    }
    // For SSH URLs, Git will use SSH keys from ~/.ssh/ automatically
    
    const escapedUrl = this.escapeShellArg(cloneUrl);
    const escapedBranch = this.escapeShellArg(this.config.branch);
    const escapedPath = this.escapeShellArg(this.localPath);
    
    // Try cloning with the specified branch
    let command = `git clone --branch ${escapedBranch} ${escapedUrl} ${escapedPath}`;
    
    try {
      logger.debug('Executing git clone', { branch: this.config.branch });
      await execAsync(command, { timeout: 60000 }); // 1 minute timeout
      logger.info('Successfully cloned repository', { branch: this.config.branch });
    } catch (error) {
      const errorMsg = (error as Error).message;
      
      // If branch not found, try cloning without branch specification (use repo's default branch)
      if (errorMsg.includes('Remote branch') && errorMsg.includes('not found')) {
        logger.warn('Requested branch not found, trying default branch', {
          requestedBranch: this.config.branch
        });
        command = `git clone ${escapedUrl} ${escapedPath}`;
        
        try {
          await execAsync(command, { timeout: 60000 });
          
          // Detect the actual default branch
          const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: this.localPath });
          const actualBranch = stdout.trim();
          logger.info('Successfully cloned with default branch', {
            requestedBranch: this.config.branch,
            actualBranch
          });
          
          // Update config to use the actual default branch for future operations
          this.config.branch = actualBranch;
        } catch (fallbackError) {
          logger.error('Failed to clone repository with fallback', fallbackError);
          throw new StorageError(`Failed to clone workflow repository: ${(fallbackError as Error).message}`);
        }
      } else {
        logger.error('Failed to clone repository', error, { branch: this.config.branch });
        throw new StorageError(`Failed to clone workflow repository: ${errorMsg}`);
      }
    }
  }

  private async pullRepository(): Promise<void> {
    logger.debug('Pulling latest changes from Git repository', {
      branch: this.config.branch,
      localPath: this.localPath
    });
    
    const escapedPath = this.escapeShellArg(this.localPath);
    const escapedBranch = this.escapeShellArg(this.config.branch);
    
    try {
      // Try to fetch and reset
      const fetchCommand = `cd ${escapedPath} && git fetch origin ${escapedBranch}`;
      const resetCommand = `cd ${escapedPath} && git reset --hard origin/${escapedBranch}`;
      
      await execAsync(fetchCommand, { timeout: 30000 });
      await execAsync(resetCommand, { timeout: 30000 });
      logger.info('Successfully updated repository', { branch: this.config.branch });
    } catch (error) {
      // If fetch/reset fails, try simple pull
      try {
        const pullCommand = `cd ${escapedPath} && git pull origin ${escapedBranch}`;
        await execAsync(pullCommand, { timeout: 30000 });
        logger.info('Successfully updated repository via pull', { branch: this.config.branch });
      } catch (pullError) {
        // Don't throw on pull failure - use cached version
        // This is intentional behavior for offline scenarios
        logger.warn('Git pull failed, using cached version', pullError, {
          repositoryUrl: this.config.repositoryUrl,
          branch: this.config.branch
        });
      }
    }
  }

  private async gitCommitAndPush(workflow: Workflow): Promise<void> {
    const escapedPath = this.escapeShellArg(this.localPath);
    const escapedFilename = this.escapeShellArg(`workflows/${workflow.id}.json`);
    const escapedMessage = this.escapeShellArg(`Add/update workflow: ${workflow.name}`);
    const escapedBranch = this.escapeShellArg(this.config.branch);
    
    const commands = [
      `cd ${escapedPath}`,
      `git add ${escapedFilename}`,
      `git commit -m ${escapedMessage}`,
      `git push origin ${escapedBranch}`
    ];
    
    const command = commands.join(' && ');
    
    try {
      await execAsync(command, { timeout: 60000 }); // 1 minute timeout
    } catch (error) {
      throw new StorageError(`Failed to push workflow to repository: ${(error as Error).message}`);
    }
  }

  private escapeShellArg(arg: string): string {
    // Escape shell arguments to prevent injection attacks
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
  }
}

/**
 * Example usage and configuration
 */
export const COMMUNITY_WORKFLOW_REPOS = {
  // Official community repository
  official: {
    repositoryUrl: 'https://github.com/EtienneBBeaulac/workrail-community-workflows.git',
    branch: 'main',
    syncInterval: 60, // 1 hour
    maxFileSize: 1024 * 1024, // 1MB
    maxFiles: 100
  },
  
  // User's personal workflow repository
  personal: {
    repositoryUrl: 'https://github.com/username/my-workflows.git',
    branch: 'main',
    syncInterval: 30, // 30 minutes
    authToken: process.env['GITHUB_TOKEN'],
    maxFileSize: 1024 * 1024, // 1MB
    maxFiles: 50
  }
}; 