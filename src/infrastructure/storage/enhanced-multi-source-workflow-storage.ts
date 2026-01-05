import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { ICompositeWorkflowStorage, IWorkflowStorage } from '../../types/storage';
import { 
  Workflow, 
  WorkflowSummary, 
  WorkflowDefinition,
  WorkflowSource,
  createBundledSource,
  createUserDirectorySource,
  createProjectDirectorySource,
  createCustomDirectorySource
} from '../../types/workflow';
import { FileWorkflowStorage } from './file-workflow-storage';
import { GitWorkflowStorage, GitWorkflowConfig } from './git-workflow-storage';
import { RemoteWorkflowStorage, RemoteWorkflowRegistryConfig } from './remote-workflow-storage';
import { PluginWorkflowStorage, PluginWorkflowConfig } from './plugin-workflow-storage';
import type { IFeatureFlagProvider } from '../../config/feature-flags';
import { EnvironmentFeatureFlagProvider } from '../../config/feature-flags';
import { createLogger } from '../../utils/logger';

const logger = createLogger('EnhancedMultiSourceWorkflowStorage');

/**
 * Options for FileWorkflowStorage instances
 */
interface FileWorkflowStorageOptions {
  maxFileSizeBytes?: number;
  cacheTTLms?: number;
  cacheSize?: number;
  indexCacheTTLms?: number;
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
export class EnhancedMultiSourceWorkflowStorage implements ICompositeWorkflowStorage {
  public readonly kind = 'composite' as const;
  private readonly storageInstances: IWorkflowStorage[] = [];
  private readonly config: Required<
    Pick<EnhancedMultiSourceConfig, 'warnOnSourceFailure' | 'gracefulDegradation'>
  >;

  constructor(
    config: EnhancedMultiSourceConfig = {},
    private readonly featureFlagProvider: IFeatureFlagProvider | null = null
  ) {
    this.config = {
      warnOnSourceFailure: config.warnOnSourceFailure ?? true,
      gracefulDegradation: config.gracefulDegradation ?? true
    };

    // Parse WORKFLOW_STORAGE_PATH environment variable
    const customPathsEnv = process.env['WORKFLOW_STORAGE_PATH'];
    if (customPathsEnv) {
      const paths = customPathsEnv
        .split(path.delimiter)
        .map(p => p.trim())
        .filter(p => p.length > 0);
      config.customPaths = [...(config.customPaths || []), ...paths];
      logger.info('Added custom paths from WORKFLOW_STORAGE_PATH', { paths });
    }

    this.storageInstances = this.initializeStorageSources(config);
  }
  
  getSources(): readonly WorkflowSource[] {
    return this.storageInstances.map(storage => storage.source);
  }

  private initializeStorageSources(config: EnhancedMultiSourceConfig): IWorkflowStorage[] {
    const instances: IWorkflowStorage[] = [];

    // Get feature flags provider (required for FileWorkflowStorage)
    // If not provided, we won't be able to create file-based storages.
    if (!this.featureFlagProvider) {
      logger.warn('No feature flag provider; file-based workflows may not load correctly');
    }

    // Priority 1: Bundled workflows (lowest priority)
    if (config.includeBundled !== false && this.featureFlagProvider) {
      try {
        const bundledPath = this.getBundledWorkflowsPath();
        if (existsSync(bundledPath)) {
          instances.push(new FileWorkflowStorage(
            bundledPath,
            createBundledSource(),
            this.featureFlagProvider,
            config.fileStorageOptions
          ));
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
        } catch (error) {
          this.handleSourceError(`plugin-${i}`, error as Error);
        }
      }
    }

    // Priority 3: User directory workflows
    if (config.includeUser !== false && this.featureFlagProvider) {
      try {
        const userPath = config.userPath || this.getUserWorkflowsPath();
        if (existsSync(userPath)) {
          instances.push(new FileWorkflowStorage(
            userPath,
            createUserDirectorySource(userPath),
            this.featureFlagProvider,
            config.fileStorageOptions
          ));
        }
      } catch (error) {
        this.handleSourceError('user', error as Error);
      }
    }

    // Priority 4: Custom directory workflows
    if (config.customPaths && config.customPaths.length > 0 && this.featureFlagProvider) {
      for (const customPath of config.customPaths) {
        try {
          if (existsSync(customPath)) {
            const label = path.basename(customPath);
            instances.push(new FileWorkflowStorage(
              customPath,
              createCustomDirectorySource(customPath, label),
              this.featureFlagProvider,
              config.fileStorageOptions
            ));
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
        } catch (error) {
          this.handleSourceError(`remote-${i}`, error as Error);
        }
      }
    }

    // Priority 7: Project directory workflows (highest priority)
    if (config.includeProject !== false && this.featureFlagProvider) {
      try {
        const projectPath = config.projectPath || this.getProjectWorkflowsPath();
        if (existsSync(projectPath)) {
          instances.push(new FileWorkflowStorage(
            projectPath,
            createProjectDirectorySource(projectPath),
            this.featureFlagProvider,
            config.fileStorageOptions
          ));
        }
      } catch (error) {
        this.handleSourceError('project', error as Error);
      }
    }

    return instances;
  }

  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    const allWorkflows: Workflow[] = [];
    const seenIds = new Set<string>();

    // Load from all sources, with later sources taking precedence
    for (let i = 0; i < this.storageInstances.length; i++) {
      const storage = this.storageInstances[i]!;

      try {
        const workflows = await storage.loadAllWorkflows();

        // Add workflows, with later ones overriding earlier ones with same ID.
        // v2 lock: bundled `wr.*` workflows cannot be shadowed by higher-priority sources.
        for (const workflow of workflows) {
          const id = workflow.definition.id;

          if (seenIds.has(id)) {
            const existingIndex = allWorkflows.findIndex((wf) => wf.definition.id === id);
            if (existingIndex >= 0) {
              const existing = allWorkflows[existingIndex]!;

              const isWr = id.startsWith('wr.');
              if (isWr && existing.source.kind === 'bundled') {
                // Keep bundled `wr.*` authoritative; ignore shadow attempts.
                continue;
              }

              allWorkflows[existingIndex] = workflow;
            }
          } else {
            allWorkflows.push(workflow);
            seenIds.add(id);
          }
        }
      } catch (error) {
        this.handleSourceError(`source-${i}`, error as Error);
      }
    }

    return allWorkflows;
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    // v2 lock: bundled `wr.*` workflows cannot be shadowed.
    // If the caller requests a `wr.*` id, prefer bundled, then fall back to normal precedence.
    if (id.startsWith('wr.')) {
      for (let i = 0; i < this.storageInstances.length; i++) {
        const storage = this.storageInstances[i]!;
        if (storage.source.kind !== 'bundled') continue;

        try {
          const workflow = await storage.getWorkflowById(id);
          if (workflow) return workflow;
        } catch (error) {
          this.handleSourceError(`source-${i}`, error as Error);
        }
      }
    }

    // Search in reverse order (later sources take precedence)
    for (let i = this.storageInstances.length - 1; i >= 0; i--) {
      const storage = this.storageInstances[i]!;

      try {
        const workflow = await storage.getWorkflowById(id);
        if (workflow) {
          return workflow;
        }
      } catch (error) {
        this.handleSourceError(`source-${i}`, error as Error);
      }
    }

    return null;
  }

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    const allSummaries: WorkflowSummary[] = [];
    const seenIds = new Set<string>();

    // Load from all sources, with later sources taking precedence
    for (let i = 0; i < this.storageInstances.length; i++) {
      const storage = this.storageInstances[i]!;

      try {
        const summaries = await storage.listWorkflowSummaries();

        for (const summary of summaries) {
          const id = summary.id;

          if (seenIds.has(id)) {
            const existingIndex = allSummaries.findIndex((s) => s.id === id);
            if (existingIndex >= 0) {
              const existing = allSummaries[existingIndex]!;

              const isWr = id.startsWith('wr.');
              if (isWr && existing.source.kind === 'bundled') {
                // Keep bundled `wr.*` authoritative; ignore shadow attempts.
                continue;
              }

              allSummaries[existingIndex] = summary;
            }
          } else {
            allSummaries.push(summary);
            seenIds.add(id);
          }
        }
      } catch (error) {
        this.handleSourceError(`source-${i}`, error as Error);
      }
    }

    return allSummaries;
  }

  /**
   * Save operation delegates to the highest priority source that supports saving.
   * Typically this would be the project directory.
   */
  async save(definition: WorkflowDefinition): Promise<void> {
    // Try to save to sources in reverse order (highest priority first)
    for (let i = this.storageInstances.length - 1; i >= 0; i--) {
      const storage = this.storageInstances[i]!;
      if (storage.save) {
        try {
          await storage.save(definition);
          return; // Success
        } catch (error) {
          // Continue to next source
          this.handleSourceError(`source-${i}`, error as Error);
        }
      }
    }

    throw new Error('No storage source supports saving workflows');
  }

  /**
   * Get information about configured sources (for debugging/CLI)
   */
  getSourceInfo(): Array<{ name: string; type: string; source: WorkflowSource }> {
    return this.storageInstances.map(storage => ({
      name: this.getStorageType(storage),
      type: this.getStorageType(storage),
      source: storage.source
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
 * Factory function to create enhanced multi-source storage from environment variables.
 * 
 * @param overrides - Config overrides
 * @param featureFlagProvider - Feature flags provider (optional; creates default if not provided)
 * @deprecated Use DI container: container.resolve(DI.Storage.Primary) instead
 */
export function createEnhancedMultiSourceWorkflowStorage(
  overrides: EnhancedMultiSourceConfig = {},
  featureFlagProvider?: IFeatureFlagProvider
): EnhancedMultiSourceWorkflowStorage {
  logger.info('Creating enhanced multi-source workflow storage');
  
  const config: EnhancedMultiSourceConfig = {
    includeBundled: getEnvBool('WORKFLOW_INCLUDE_BUNDLED', true),
    includeUser: getEnvBool('WORKFLOW_INCLUDE_USER', true),
    includeProject: getEnvBool('WORKFLOW_INCLUDE_PROJECT', true),
    ...overrides
  };
  
  // If no provider given, create one for backward compatibility
  // This allows tests and legacy code to work without DI
  const provider = featureFlagProvider ?? new EnvironmentFeatureFlagProvider();

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

    const isWindowsAbsolutePath = (p: string): boolean => {
      // Drive path: C:\... or C:/...
      if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
      // UNC path: \\server\share\...
      if (p.startsWith('\\\\')) return true;
      return false;
    };
    
    for (const url of urls) {
      const isLocalPath = !url.includes('://') && (url.startsWith('/') || isWindowsAbsolutePath(url));
      if (url.startsWith('file://') || isLocalPath) {
        localFileUrls.push(url);
      } else {
        actualGitUrls.push(url);
      }
    }
    
    // Add local file:// URLs as custom directory paths (no Git clone needed)
    if (localFileUrls.length > 0) {
      config.customPaths = config.customPaths || [];
      for (const url of localFileUrls) {
        const localPath = (() => {
          if (!url.startsWith('file://')) return url;
          try {
            // Decode percent-encoded URLs (e.g., file:///C:/Program%20Files/...)
            const decoded = decodeURIComponent(url);
            return fileURLToPath(new URL(decoded));
          } catch {
            // Best-effort fallback for malformed file URLs.
            try {
              return fileURLToPath(new URL(url));
            } catch {
              // Last resort: naive stripping (already validated as local earlier)
              return url.substring('file://'.length);
            }
          }
        })();
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

  return new EnhancedMultiSourceWorkflowStorage(config, provider);
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

