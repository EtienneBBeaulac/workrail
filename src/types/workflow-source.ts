/**
 * Workflow Source Types
 * 
 * Discriminated union representing all possible origins for workflows.
 * Exhaustive - compiler enforces all cases are handled in switch statements.
 * 
 * This is a first-class domain concept, not metadata.
 */

// =============================================================================
// SOURCE TYPE DEFINITIONS
// =============================================================================

export type WorkflowSource =
  | BundledSource
  | UserDirectorySource
  | ProjectDirectorySource
  | CustomDirectorySource
  | GitRepositorySource
  | RemoteRegistrySource
  | PluginSource;

export interface BundledSource {
  readonly kind: 'bundled';
}

export interface UserDirectorySource {
  readonly kind: 'user';
  readonly directoryPath: string;
}

export interface ProjectDirectorySource {
  readonly kind: 'project';
  readonly directoryPath: string;
}

export interface CustomDirectorySource {
  readonly kind: 'custom';
  readonly directoryPath: string;
  readonly label: string;
}

export interface GitRepositorySource {
  readonly kind: 'git';
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly localCachePath: string;
}

export interface RemoteRegistrySource {
  readonly kind: 'remote';
  readonly registryUrl: string;
}

export interface PluginSource {
  readonly kind: 'plugin';
  readonly pluginName: string;
  readonly pluginVersion: string;
}

// =============================================================================
// SOURCE KIND ENUM (for validation and serialization)
// =============================================================================

export type WorkflowSourceKind = WorkflowSource['kind'];

export const WORKFLOW_SOURCE_KINDS: readonly WorkflowSourceKind[] = [
  'bundled',
  'user',
  'project',
  'custom',
  'git',
  'remote',
  'plugin'
] as const;

// =============================================================================
// TYPE GUARDS
// =============================================================================

export function isBundledSource(source: WorkflowSource): source is BundledSource {
  return source.kind === 'bundled';
}

export function isUserDirectorySource(source: WorkflowSource): source is UserDirectorySource {
  return source.kind === 'user';
}

export function isProjectDirectorySource(source: WorkflowSource): source is ProjectDirectorySource {
  return source.kind === 'project';
}

export function isCustomDirectorySource(source: WorkflowSource): source is CustomDirectorySource {
  return source.kind === 'custom';
}

export function isGitRepositorySource(source: WorkflowSource): source is GitRepositorySource {
  return source.kind === 'git';
}

export function isRemoteRegistrySource(source: WorkflowSource): source is RemoteRegistrySource {
  return source.kind === 'remote';
}

export function isPluginSource(source: WorkflowSource): source is PluginSource {
  return source.kind === 'plugin';
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

export function createBundledSource(): BundledSource {
  return Object.freeze({ kind: 'bundled' });
}

export function createUserDirectorySource(directoryPath: string): UserDirectorySource {
  return Object.freeze({ kind: 'user', directoryPath });
}

export function createProjectDirectorySource(directoryPath: string): ProjectDirectorySource {
  return Object.freeze({ kind: 'project', directoryPath });
}

export function createCustomDirectorySource(directoryPath: string, label: string): CustomDirectorySource {
  return Object.freeze({ kind: 'custom', directoryPath, label });
}

export function createGitRepositorySource(
  repositoryUrl: string,
  branch: string,
  localCachePath: string
): GitRepositorySource {
  return Object.freeze({ kind: 'git', repositoryUrl, branch, localCachePath });
}

export function createRemoteRegistrySource(registryUrl: string): RemoteRegistrySource {
  return Object.freeze({ kind: 'remote', registryUrl });
}

export function createPluginSource(pluginName: string, pluginVersion: string): PluginSource {
  return Object.freeze({ kind: 'plugin', pluginName, pluginVersion });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Type-safe exhaustive check for switch statements.
 * If you see a compile error here, you forgot to handle a source kind.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected source kind: ${JSON.stringify(x)}`);
}

/**
 * Get a human-readable display name for a source.
 */
export function getSourceDisplayName(source: WorkflowSource): string {
  switch (source.kind) {
    case 'bundled':
      return 'Built-in';
    case 'user':
      return 'User Library';
    case 'project':
      return 'Project';
    case 'custom':
      return source.label || 'Custom';
    case 'git':
      return extractRepoName(source.repositoryUrl);
    case 'remote':
      return extractHostname(source.registryUrl);
    case 'plugin':
      return source.pluginName;
    default:
      return assertNever(source);
  }
}

/**
 * Get the directory path for file-based sources.
 * Returns undefined for non-file sources.
 */
export function getSourcePath(source: WorkflowSource): string | undefined {
  switch (source.kind) {
    case 'user':
    case 'project':
    case 'custom':
      return source.directoryPath;
    case 'git':
      return source.localCachePath;
    case 'bundled':
    case 'remote':
    case 'plugin':
      return undefined;
    default:
      return assertNever(source);
  }
}

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

function extractRepoName(url: string): string {
  try {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] || 'Git Repository';
  } catch {
    return 'Git Repository';
  }
}

function extractHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return 'Remote Registry';
  }
}
