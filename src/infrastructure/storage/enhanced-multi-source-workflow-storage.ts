import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { inject, singleton } from 'tsyringe';
import { IWorkflowStorage } from '../../types/storage';
import { Workflow, WorkflowSummary } from '../../types/mcp-types';
import { FileWorkflowStorage } from './file-workflow-storage';
import { GitWorkflowStorage, GitWorkflowConfig } from './git-workflow-storage';
import { RemoteWorkflowStorage, RemoteWorkflowRegistryConfig } from './remote-workflow-storage';
import { PluginWorkflowStorage, PluginWorkflowConfig } from './plugin-workflow-storage';
import { createLogger } from '../../utils/logger';
import { IFeatureFlagProvider, EnvironmentFeatureFlagProvider } from '../../config/feature-flags';
import { DI } from '../../di/tokens';

const logger = createLogger('EnhancedMultiSourceWorkflowStorage');

/**
 * Options for FileWorkflowStorage instances
 */
interface FileWorkflowStorageOptions {
  maxFileSizeBytes?: number;
  cacheTTLms?: number;
  cacheSize?: number;
  indexCacheTTLms?: number;
  featureFlagProvider?: IFeatureFlagProvider;
}

/**
 * Configuration for enhanced multi-source workflow storage that supports:
 * - Local directories (bundled, user, project, custom)
 * - Git repositories (GitHub, GitLab, etc.)
 * - Remote HTTP registries (npm-style)
 * - Plugin directories (npm packages)
 */
export interface EnhancedMultiSourceConfig {
  // ========== Local Directory Options ==========
  /** Include bundled workflows (default: true) */
  includeBundled?: boolean;
  
  /** Include user workflows from ~/.workrail/workflows (default: true) */
  includeUser?: boolean;
  
  /** Include project workflows from ./workflows (default: true) */
  includeProject?: boolean;
  
  /** Additional custom directory paths */
  customPaths?: string[];
  
  /** Custom project workflows path (overrides default ./workflows) */
  projectPath?: string;
  
  /** Custom user workflows path (overrides default ~/.workrail/workflows) */
  userPath?: string;
  
  /** Options for FileWorkflowStorage instances */
  fileStorageOptions?: FileWorkflowStorageOptions;
  
  // ========== Git Repository Options ==========
  /** 
   * Git repositories to load workflows from.
   * Loaded with medium priority (after bundled/user, before project).
   */
  gitRepositories?: GitWorkflowConfig[];
  
  // ========== Remote Registry Options ==========
  /**
   * Remote HTTP-based workflow registries.
   * Loaded with medium-high priority (after Git, before project).
   */
  remoteRegistries?: RemoteWorkflowRegistryConfig[];
  
  // ========== Plugin Options ==========
  /**
   * Plugin directories or packages to load workflows from.
   * Loaded with low-medium priority (after bundled, before user).
   */
  pluginConfigs?: PluginWorkflowConfig[];
  
  // ========== Advanced Options ==========
  /**
   * If true, log warnings when a source fails to load.
   * If false, fail silently (graceful degradation).
   * Default: true
   */
  warnOnSourceFailure?: boolean;
  
  /**
   * If true, continue loading from other sources even if one fails.
   * If false, throw error on first failure.
   * Default: true (graceful degradation)
   */
  gracefulDegradation?: boolean;
}

/**
 * Enhanced multi-source workflow storage that combines all available storage types.
 * 
 * Priority order (highest priority last - overwrites earlier sources):
 * 1. Bundled workflows (lowest priority)
 * 2. Plugin workflows
 * 3. User directory workflows
 * 4. Custom directory workflows
 * 5. Git repository workflows
 * 6. Remote registry workflows
 * 7. Project directory workflows (highest priority)
 * 
 * Features:
 * - Graceful degradation (continues if one source fails)
 * - Workflow ID deduplication (later sources override earlier ones)
 * - Support for all storage types
 * - Configurable priority ordering
 * - Comprehensive error handling
 */
@singleton()
export class EnhancedMultiSourceWorkflowStorage implements IWorkflowStorage {
  private readonly storageInstances: IWorkflowStorage[] = [];
  private readonly config: Required<
    Pick<EnhancedMultiSourceConfig, 'warnOnSourceFailure' | 'gracefulDegradation'>
  >;
  private readonly sourceNames: string[] = []; // For debugging
  private readonly featureFlags: IFeatureFlagProvider;

  constructor(
    @inject(DI.Infra.FeatureFlags)
    featureFlagsOrConfig?: IFeatureFlagProvider | EnhancedMultiSourceConfig,
    configOrUndefined?: EnhancedMultiSourceConfig
  ) {
    const resolvedConfig = this.resolveConfig(featureFlagsOrConfig, configOrUndefined);
    const resolvedFeatureFlags = this.resolveFeatureFlags(featureFlagsOrConfig, configOrUndefined);

    this.featureFlags = resolvedFeatureFlags;
    this.config = {
      warnOnSourceFailure: resolvedConfig.warnOnSourceFailure ?? true,
      gracefulDegradation: resolvedConfig.gracefulDegradation ?? true
    };

    // Parse WORKFLOW_STORAGE_PATH environment variable
    const customPathsEnv = process.env['WORKFLOW_STORAGE_PATH'];
    if (customPathsEnv) {
      const paths = customPathsEnv
        .split(path.delimiter)
        .map(p => p.trim())
        .filter(p => p.length > 0);
      resolvedConfig.customPaths = [...(resolvedConfig.customPaths || []), ...paths];
      logger.info('Added custom paths from WORKFLOW_STORAGE_PATH', { paths });
    }

    this.storageInstances = this.initializeStorageSources(resolvedConfig);
  }

  private resolveFeatureFlags(
    featureFlagsOrConfig: IFeatureFlagProvider | EnhancedMultiSourceConfig | undefined,
    configOrUndefined: EnhancedMultiSourceConfig | undefined
  ): IFeatureFlagProvider {
    if (configOrUndefined !== undefined) {
      const injectedFeatureFlags = this.isFeatureFlagProvider(featureFlagsOrConfig)
        ? featureFlagsOrConfig
        : undefined;
      return injectedFeatureFlags ?? new EnvironmentFeatureFlagProvider();
    }

    const injectedFeatureFlags = this.isFeatureFlagProvider(featureFlagsOrConfig)
      ? featureFlagsOrConfig
      : undefined;
    return injectedFeatureFlags ?? new EnvironmentFeatureFlagProvider();
  }

  private resolveConfig(
    featureFlagsOrConfig: IFeatureFlagProvider | EnhancedMultiSourceConfig | undefined,
    configOrUndefined: EnhancedMultiSourceConfig | undefined
  ): EnhancedMultiSourceConfig {
    if (configOrUndefined !== undefined) {
      return configOrUndefined;
    }

    if (featureFlagsOrConfig === undefined) {
      return {};
    }

    if (this.isFeatureFlagProvider(featureFlagsOrConfig)) {
      return {};
    }

    return featureFlagsOrConfig;
  }

  private isFeatureFlagProvider(value: unknown): value is IFeatureFlagProvider {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value !== 'object') {
      return false;
    }

    return 'isEnabled' in value && typeof (value as IFeatureFlagProvider).isEnabled === 'function';
  }

  private initializeStorageSources(config: EnhancedMultiSourceConfig): IWorkflowStorage[] {
    const instances: IWorkflowStorage[] = [];
    
    // Merge feature flags into file storage options
    const fileStorageOptions: FileWorkflowStorageOptions = {
      ...config.fileStorageOptions,
      featureFlagProvider: this.featureFlags
    };

    // Priority 1: Bundled workflows (lowest priority)
    if (config.includeBundled !== false) {
      try {
        const bundledPath = this.getBundledWorkflowsPath();
        if (existsSync(bundledPath)) {
          instances.push(new FileWorkflowStorage(bundledPath, fileStorageOptions));
          this.sourceNames.push('bundled');
        }
      } catch (error) {
        this.handleSourceError('bundled', error as Error);
      }
    }

    // Priority 2: Plugin workflows
    if (config.pluginConfigs && config.pluginConfigs.length > 0) {
      for (let i = 0; i < config.pluginConfigs.length; i++) {
        try {
          const pluginConfig = config.pluginConfigs[i]!;
          instances.push(new PluginWorkflowStorage(pluginConfig));
          this.sourceNames.push(`plugin-${i}`);
        } catch (error) {
          this.handleSourceError(`plugin-${i}`, error as Error);
        }
      }
    }

    // Priority 3: User directory workflows
    if (config.includeUser !== false) {
      try {
        const userPath = config.userPath || this.getUserWorkflowsPath();
        if (existsSync(userPath)) {
          instances.push(new FileWorkflowStorage(userPath, fileStorageOptions));
          this.sourceNames.push('user');
        }
      } catch (error) {
        this.handleSourceError('user', error as Error);
      }
    }

    // Priority 4: Custom directory workflows
    if (config.customPaths && config.customPaths.length > 0) {
      for (const customPath of config.customPaths) {
        try {
          if (existsSync(customPath)) {
            instances.push(new FileWorkflowStorage(customPath, fileStorageOptions));
            this.sourceNames.push(`custom:${customPath}`);
          }
        } catch (error) {
          this.handleSourceError(`custom:${customPath}`, error as Error);
        }
      }
    }

    // Priority 5: Git repository workflows
    if (config.gitRepositories && config.gitRepositories.length > 0) {
      for (let i = 0; i < config.gitRepositories.length; i++) {
        try {
          const gitConfig = config.gitRepositories[i]!;
          instances.push(new GitWorkflowStorage(gitConfig));
          const repoName = this.extractRepoName(gitConfig.repositoryUrl);
          this.sourceNames.push(`git:${repoName}`);
        } catch (error) {
          this.handleSourceError(`git-${i}`, error as Error);
        }
      }
    }

    // Priority 6: Remote registry workflows
    if (config.remoteRegistries && config.remoteRegistries.length > 0) {
      for (let i = 0; i < config.remoteRegistries.length; i++) {
        try {
          const remoteConfig = config.remoteRegistries[i]!;
          instances.push(new RemoteWorkflowStorage(remoteConfig));
          this.sourceNames.push(`remote:${remoteConfig.baseUrl}`);
        } catch (error) {
          this.handleSourceError(`remote-${i}`, error as Error);
        }
      }
    }

    // Priority 7: Project directory workflows (highest priority)
    if (config.includeProject !== false) {
      try {
        const projectPath = config.projectPath || this.getProjectWorkflowsPath();
        if (existsSync(projectPath)) {
          instances.push(new FileWorkflowStorage(projectPath, fileStorageOptions));
          this.sourceNames.push('project');
        }
      } catch (error) {
        this.handleSourceError('project', error as Error);
      }
    }

    return instances;
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    const allWorkflows: Workflow[] = [];
    const seenIds = new Set<string>();

    // Load from all sources, with later sources taking precedence
    for (let i = 0; i < this.storageInstances.length; i++) {
      const storage = this.storageInstances[i]!;
      const sourceName = this.sourceNames[i] || `source-${i}`;

      try {
        const workflows = await storage.loadAllWorkflows();

        // Add workflows, with later ones overriding earlier ones with same ID
        for (const workflow of workflows) {
          if (seenIds.has(workflow.id)) {
            // Replace existing workflow with same ID
            const existingIndex = allWorkflows.findIndex(wf => wf.id === workflow.id);
            if (existingIndex >= 0) {
              allWorkflows[existingIndex] = workflow;
              if (this.config.warnOnSourceFailure) {
                console.debug(
                  `Workflow '${workflow.id}' from ${sourceName} overrode earlier version`
                );
              }
            }
          } else {
            allWorkflows.push(workflow);
            seenIds.add(workflow.id);
          }
        }
      } catch (error) {
        this.handleSourceError(sourceName, error as Error);
      }
    }

    return allWorkflows;
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    // Search in reverse order (later sources take precedence)
    for (let i = this.storageInstances.length - 1; i >= 0; i--) {
      const storage = this.storageInstances[i]!;
      const sourceName = this.sourceNames[i] || `source-${i}`;

      try {
        const workflow = await storage.getWorkflowById(id);
        if (workflow) {
          return workflow;
        }
      } catch (error) {
        this.handleSourceError(sourceName, error as Error);
      }
    }

    return null;
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    const allSummaries: WorkflowSummary[] = [];
    const seenIds = new Set<string>();

    // Load from all sources, with later sources taking precedence
    for (let i = 0; i < this.storageInstances.length; i++) {
      const storage = this.storageInstances[i]!;
      const sourceName = this.sourceNames[i] || `source-${i}`;

      try {
        const summaries = await storage.listWorkflowSummaries();

        for (const summary of summaries) {
          if (seenIds.has(summary.id)) {
            // Replace existing summary with same ID
            const existingIndex = allSummaries.findIndex(s => s.id === summary.id);
            if (existingIndex >= 0) {
              allSummaries[existingIndex] = summary;
            }
          } else {
            allSummaries.push(summary);
            seenIds.add(summary.id);
          }
        }
      } catch (error) {
        this.handleSourceError(sourceName, error as Error);
      }
    }

    return allSummaries;
  }

  /**
   * Save operation delegates to the highest priority source that supports saving.
   * Typically this would be the project directory.
   */
  async save(workflow: Workflow): Promise<void> {
    // Try to save to sources in reverse order (highest priority first)
    for (let i = this.storageInstances.length - 1; i >= 0; i--) {
      const storage = this.storageInstances[i]!;
      if (storage.save) {
        try {
          await storage.save(workflow);
          return; // Success
        } catch (error) {
          // Continue to next source
          const sourceName = this.sourceNames[i] || `source-${i}`;
          this.handleSourceError(sourceName, error as Error);
        }
      }
    }

    throw new Error('No storage source supports saving workflows');
  }

  /**
   * Get information about configured sources (for debugging/CLI)
   */
  getSourceInfo(): Array<{ name: string; type: string }> {
    return this.sourceNames.map((name, index) => ({
      name,
      type: this.getStorageType(this.storageInstances[index]!)
    }));
  }

  // ========== Private Helper Methods ==========

  private handleSourceError(sourceName: string, error: Error): void {
    if (this.config.warnOnSourceFailure) {
      console.warn(`Failed to load workflows from ${sourceName}:`, error.message);
    }

    if (!this.config.gracefulDegradation) {
      throw error;
    }
  }

  private getBundledWorkflowsPath(): string {
    // Bundled workflows are in the package directory
    return path.resolve(__dirname, '../../../workflows');
  }

  private getUserWorkflowsPath(): string {
    return path.join(os.homedir(), '.workrail', 'workflows');
  }

  private getProjectWorkflowsPath(): string {
    return path.join(process.cwd(), 'workflows');
  }

  private extractRepoName(url: string): string {
    try {
      const match = url.match(/\/([^/]+?)(?:\.git)?$/);
      return match?.[1] || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private getStorageType(storage: IWorkflowStorage): string {
    const className = storage.constructor.name;
    if (className.includes('Git')) return 'git';
    if (className.includes('Remote')) return 'remote';
    if (className.includes('Plugin')) return 'plugin';
    if (className.includes('File')) return 'file';
    return 'unknown';
  }
}

/**
 * Factory function to create enhanced multi-source storage from environment variables
 */
export function createEnhancedMultiSourceWorkflowStorage(
  overrides: EnhancedMultiSourceConfig = {}
): EnhancedMultiSourceWorkflowStorage {
  logger.info('Creating enhanced multi-source workflow storage');
  
  const config: EnhancedMultiSourceConfig = {
    includeBundled: getEnvBool('WORKFLOW_INCLUDE_BUNDLED', true),
    includeUser: getEnvBool('WORKFLOW_INCLUDE_USER', true),
    includeProject: getEnvBool('WORKFLOW_INCLUDE_PROJECT', true),
    ...overrides
  };

  logger.debug('Storage configuration', {
    includeBundled: config.includeBundled,
    includeUser: config.includeUser,
    includeProject: config.includeProject
  });

  // Parse Git repositories from environment (multiple formats supported)
  
  // Format 1: JSON array
  const gitReposJson = process.env['WORKFLOW_GIT_REPOS'];
  if (gitReposJson && gitReposJson.startsWith('[')) {
    try {
      const repos = JSON.parse(gitReposJson) as GitWorkflowConfig[];
      // Resolve tokens for each repo if not specified
      config.gitRepositories = repos.map(repo => ({
        ...repo,
        authToken: repo.authToken || resolveAuthToken(repo.repositoryUrl)
      }));
      logger.info('Parsed Git repositories from JSON array', {
        count: config.gitRepositories.length,
        repos: config.gitRepositories.map(r => ({ url: r.repositoryUrl, branch: r.branch }))
      });
    } catch (error) {
      logger.error('Failed to parse WORKFLOW_GIT_REPOS as JSON', error);
    }
  }
  // Format 2: Comma-separated URLs
  else if (gitReposJson) {
    // Use home directory for cache (more predictable than process.cwd() when running via MCP/npx)
    const cacheBaseDir = process.env['WORKRAIL_CACHE_DIR'] || 
                         path.join(os.homedir(), '.workrail', 'cache');
    
    logger.debug('Using cache directory', { cacheBaseDir });
    
    const urls = gitReposJson.split(',').map(url => url.trim());
    
    // Separate local file:// URLs from actual Git URLs
    const localFileUrls: string[] = [];
    const actualGitUrls: string[] = [];
    
    for (const url of urls) {
      if (url.startsWith('file://') || (!url.includes('://') && url.startsWith('/'))) {
        localFileUrls.push(url);
      } else {
        actualGitUrls.push(url);
      }
    }
    
    // Add local file:// URLs as custom directory paths (no Git clone needed)
    if (localFileUrls.length > 0) {
      config.customPaths = config.customPaths || [];
      for (const url of localFileUrls) {
        const localPath = url.startsWith('file://') ? url.substring(7) : url;
        config.customPaths.push(localPath);
        logger.info('Using direct file access for local repository', { localPath });
      }
    }
    
    // Only add actual Git URLs to gitRepositories (these will be cloned)
    if (actualGitUrls.length > 0) {
      config.gitRepositories = actualGitUrls.map((url, index) => {
        const repoName = url.split('/').pop()?.replace(/\.git$/, '') || `repo-${index}`;
        return {
          repositoryUrl: url,
          branch: 'main',
          localPath: path.join(cacheBaseDir, `git-${index}-${repoName}`),
          authToken: resolveAuthToken(url),
          syncInterval: 60
        };
      });
      
      logger.info('Parsed remote Git repositories from comma-separated list', {
        count: config.gitRepositories.length,
        repos: config.gitRepositories.map(r => ({ url: r.repositoryUrl, branch: r.branch, path: r.localPath }))
      });
    }
  }

  // Format 3: Single repository
  const gitRepoUrl = process.env['WORKFLOW_GIT_REPO_URL'];
  if (gitRepoUrl) {
    config.gitRepositories = config.gitRepositories || [];
    config.gitRepositories.push({
      repositoryUrl: gitRepoUrl,
      branch: process.env['WORKFLOW_GIT_REPO_BRANCH'] || 'main',
      authToken: resolveAuthToken(gitRepoUrl),
      syncInterval: Number(process.env['WORKFLOW_GIT_SYNC_INTERVAL'] || 60)
    });
    logger.info('Added single Git repository from env vars', {
      url: gitRepoUrl,
      branch: process.env['WORKFLOW_GIT_REPO_BRANCH'] || 'main'
    });
  }

  // Parse remote registries from environment
  const remoteRegistryUrl = process.env['WORKFLOW_REGISTRY_URL'];
  if (remoteRegistryUrl) {
    config.remoteRegistries = config.remoteRegistries || [];
    config.remoteRegistries.push({
      baseUrl: remoteRegistryUrl,
      apiKey: process.env['WORKFLOW_REGISTRY_API_KEY'],
      timeout: Number(process.env['WORKFLOW_REGISTRY_TIMEOUT'] || 10000)
    });
  }

  return new EnhancedMultiSourceWorkflowStorage(undefined, config);
}

// ========== Helper Functions ==========

/**
 * Resolve authentication token for a Git repository URL based on the hostname.
 * 
 * Resolution order:
 * 1. SSH URLs (git@host:path) → undefined (uses SSH keys from ~/.ssh/)
 * 2. Service-specific tokens (github.com → GITHUB_TOKEN, etc.)
 * 3. Hostname-based tokens (git.company.com → GIT_COMPANY_COM_TOKEN)
 * 4. Generic fallbacks (WORKFLOW_GIT_AUTH_TOKEN, GIT_TOKEN)
 * 
 * Supports:
 * - git@github.com:org/repo.git → SSH keys (Phase 3)
 * - ssh://git@host/repo.git → SSH keys (Phase 3)
 * - github.com → GITHUB_TOKEN
 * - gitlab.com → GITLAB_TOKEN
 * - bitbucket.org → BITBUCKET_TOKEN
 * - git.company.com → GIT_COMPANY_COM_TOKEN (Phase 2)
 * - custom.gitlab.io → CUSTOM_GITLAB_IO_TOKEN (Phase 2)
 * 
 * @param repositoryUrl The Git repository URL
 * @returns Auth token or undefined if not found/not needed
 */
function resolveAuthToken(repositoryUrl: string): string | undefined {
  // Phase 3: SSH URLs don't need tokens (use SSH keys)
  if (isSshUrl(repositoryUrl)) {
    return undefined;
  }
  
  try {
    const url = new URL(repositoryUrl);
    const hostname = url.hostname.toLowerCase();
    
    // Phase 1: Service-specific tokens (common services)
    if (hostname.includes('github.com')) {
      return process.env['GITHUB_TOKEN'];
    }
    if (hostname.includes('gitlab.com')) {
      return process.env['GITLAB_TOKEN'];
    }
    if (hostname.includes('bitbucket.org')) {
      return process.env['BITBUCKET_TOKEN'];
    }
    
    // Phase 2: Hostname-based tokens (self-hosted)
    // Convert hostname to env var format: git.company.com → GIT_COMPANY_COM_TOKEN
    const hostnameEnvKey = `GIT_${hostname.replace(/[.-]/g, '_').toUpperCase()}_TOKEN`;
    const hostnameToken = process.env[hostnameEnvKey];
    if (hostnameToken) {
      return hostnameToken;
    }
    
    // Generic fallbacks
    return process.env['WORKFLOW_GIT_AUTH_TOKEN'] || process.env['GIT_TOKEN'];
  } catch {
    // Invalid URL, try generic tokens
    return process.env['WORKFLOW_GIT_AUTH_TOKEN'] || process.env['GIT_TOKEN'];
  }
}

function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://');
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

