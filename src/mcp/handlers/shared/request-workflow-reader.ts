import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IWorkflowReader } from '../../../types/storage.js';
import type { IFeatureFlagProvider } from '../../../config/feature-flags.js';
import { createEnhancedMultiSourceWorkflowStorage } from '../../../infrastructure/storage/enhanced-multi-source-workflow-storage.js';
import { SchemaValidatingCompositeWorkflowStorage } from '../../../infrastructure/storage/schema-validating-workflow-storage.js';
import type { RememberedRootsStorePortV2 } from '../../../v2/ports/remembered-roots-store.port.js';
import type { ManagedSourceRecordV2, ManagedSourceStorePortV2 } from '../../../v2/ports/managed-source-store.port.js';

export interface RequestWorkflowReaderOptions {
  readonly featureFlags: IFeatureFlagProvider;
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
  readonly serverCwd?: string;
  readonly rememberedRootsStore?: RememberedRootsStorePortV2;
  readonly managedSourceStore?: ManagedSourceStorePortV2;
}

export function hasRequestWorkspaceSignal(options: {
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
}): boolean {
  return Boolean(options.workspacePath) || (options.resolvedRootUris?.length ?? 0) > 0;
}

export function resolveRequestWorkspaceDirectory(options: {
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
  readonly serverCwd?: string;
}): string {
  if (options.workspacePath && path.isAbsolute(options.workspacePath)) {
    return options.workspacePath;
  }

  const rootUri = options.resolvedRootUris?.[0];
  if (rootUri) {
    const fsPath = fileUriToFsPath(rootUri);
    if (fsPath) {
      return fsPath;
    }
  }

  return options.serverCwd ?? process.cwd();
}

export function toProjectWorkflowDirectory(workspaceDirectory: string): string {
  return path.basename(workspaceDirectory) === 'workflows'
    ? workspaceDirectory
    : path.join(workspaceDirectory, 'workflows');
}

export interface WorkflowRootDiscoveryResult {
  readonly discovered: readonly string[];
  readonly stale: readonly string[];
}

export async function discoverRootedWorkflowDirectories(
  roots: readonly string[],
): Promise<WorkflowRootDiscoveryResult> {
  const discoveredByPath = new Set<string>();
  const discoveredPaths: string[] = [];
  const stalePaths: string[] = [];

  for (const root of roots) {
    const rootPath = path.resolve(root);
    const result = await discoverWorkflowDirectoriesUnderRoot(rootPath);
    if (result.stale) {
      stalePaths.push(rootPath);
      continue;
    }
    for (const nextPath of result.discovered) {
      const normalizedPath = path.resolve(nextPath);
      if (discoveredByPath.has(normalizedPath)) continue;
      discoveredByPath.add(normalizedPath);
      discoveredPaths.push(normalizedPath);
    }
  }

  return { discovered: discoveredPaths, stale: stalePaths };
}

export interface WorkflowReaderForRequestResult {
  readonly reader: IWorkflowReader;
  readonly stalePaths: readonly string[];
  /** Managed source records whose paths exist on disk and are included in composition. */
  readonly managedSourceRecords: readonly ManagedSourceRecordV2[];
  /** Managed source records whose paths are missing on disk; surfaced in staleRoots + catalog. */
  readonly staleManagedRecords: readonly ManagedSourceRecordV2[];
  /**
   * Set when the managed source store could not be read (busy, IO error, or corrupted).
   * Callers should surface this as a warning so the agent knows managed sources were skipped.
   */
  readonly managedStoreError?: string;
}

export async function createWorkflowReaderForRequest(
  options: RequestWorkflowReaderOptions,
): Promise<WorkflowReaderForRequestResult> {
  const workspaceDirectory = resolveRequestWorkspaceDirectory(options);
  const projectWorkflowDirectory = toProjectWorkflowDirectory(workspaceDirectory);
  const rememberedRoots = await listRememberedRoots(options.rememberedRootsStore);
  const { discovered: rootedWorkflowDirectories, stale: stalePaths } = await discoverRootedWorkflowDirectories(rememberedRoots);
  const rootedCustomPaths = rootedWorkflowDirectories.filter((directory) => directory !== projectWorkflowDirectory);

  // Include managed source paths, deduplicating against already-discovered custom paths.
  // Paths that exist on disk are added to customPaths; paths that are missing are tracked
  // separately so callers can surface them in staleRoots and the source catalog.
  const { records: allManagedRecords, storeError: managedStoreError } = await listManagedSourceRecords(options.managedSourceStore);
  // Build a dedup set from all paths already covered: rooted-discovered paths AND
  // env-configured paths from WORKFLOW_STORAGE_PATH. The factory (createEnhancedMultiSourceWorkflowStorage)
  // adds WORKFLOW_STORAGE_PATH entries to customPaths internally, so we must mirror that
  // resolution here to avoid appending duplicate managed paths.
  const envCustomPaths = parseWorkflowStoragePathEnv();
  const normalizedCustom = new Set([
    ...rootedCustomPaths.map((p) => path.resolve(p)),
    ...envCustomPaths.map((p) => path.resolve(p)),
  ]);
  const additionalManagedPaths: string[] = [];
  const activeManagedRecords: ManagedSourceRecordV2[] = [];
  const staleManagedRecords: ManagedSourceRecordV2[] = [];
  for (const record of allManagedRecords) {
    if (normalizedCustom.has(path.resolve(record.path))) {
      // Already covered by rooted discovery -- the path exists and is in customPaths.
      // Still add to activeManagedRecords so the catalog annotates it as managed.
      activeManagedRecords.push(record);
      continue;
    }
    if (await isDirectory(record.path)) {
      additionalManagedPaths.push(record.path);
      activeManagedRecords.push(record);
    } else {
      staleManagedRecords.push(record);
    }
  }
  const customPaths = [...rootedCustomPaths, ...additionalManagedPaths];
  const allStalePaths = [...stalePaths, ...staleManagedRecords.map((r) => r.path)];

  // Use the factory (rather than `new EnhancedMultiSourceWorkflowStorage`) so that
  // env-configured sources (WORKFLOW_GIT_REPOS, WORKFLOW_STORAGE_PATH, etc.) are included
  // in every request-scoped reader. This keeps the source catalog (list_workflows
  // includeSources=true) consistent with the regular workflow listing.
  //
  // NOTE: createEnhancedMultiSourceWorkflowStorage is marked @deprecated for the DI-managed
  // production bootstrap path. Using it here is intentional -- request-scoped readers are
  // created per-call with workspace overrides and must pick up runtime env configuration.
  const storage = createEnhancedMultiSourceWorkflowStorage(
    {
      customPaths,
      projectPath: projectWorkflowDirectory,
    },
    options.featureFlags ?? undefined,
  );
  const reader = new SchemaValidatingCompositeWorkflowStorage(storage);
  return {
    reader,
    stalePaths: allStalePaths,
    managedSourceRecords: activeManagedRecords,
    staleManagedRecords,
    ...(managedStoreError !== undefined ? { managedStoreError } : {}),
  };
}

/**
 * Returns paths from the WORKFLOW_STORAGE_PATH environment variable, using the
 * same parsing logic as EnhancedMultiSourceWorkflowStorage so the dedup set
 * stays in sync with what the factory adds internally.
 */
function parseWorkflowStoragePathEnv(): readonly string[] {
  const raw = process.env['WORKFLOW_STORAGE_PATH'];
  if (!raw) return [];
  return raw.split(path.delimiter).map((p) => p.trim()).filter((p) => p.length > 0);
}

interface ManagedSourceListResult {
  readonly records: readonly ManagedSourceRecordV2[];
  readonly storeError?: string;
}

async function listManagedSourceRecords(
  managedSourceStore: ManagedSourceStorePortV2 | undefined,
): Promise<ManagedSourceListResult> {
  if (!managedSourceStore) return { records: [] };

  const result = await managedSourceStore.list();
  if (result.isErr()) {
    // Graceful degradation: proceed without managed sources so the rest of list_workflows
    // still returns built-in / rooted / project sources. The error is surfaced to the caller
    // via storeError so it can add a warning to the response -- information is not silently lost.
    return { records: [], storeError: `${result.error.code}: ${result.error.message}` };
  }

  return { records: result.value };
}

async function listRememberedRoots(
  rememberedRootsStore: RememberedRootsStorePortV2 | undefined,
): Promise<readonly string[]> {
  if (!rememberedRootsStore) return [];

  const result = await rememberedRootsStore.listRoots();
  if (result.isErr()) {
    const error = result.error;
    throw new Error(`Failed to load remembered workflow roots: ${error.code}: ${error.message}`);
  }

  return result.value.map((root) => path.resolve(root));
}

interface RootDiscoveryResult {
  readonly discovered: readonly string[];
  readonly stale: boolean;
}

async function discoverWorkflowDirectoriesUnderRoot(rootPath: string): Promise<RootDiscoveryResult> {
  const discoveredPaths: string[] = [];
  try {
    await walkForRootedWorkflowDirectories(rootPath, discoveredPaths);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { discovered: [], stale: true };
    }
    throw err;
  }
  return { discovered: discoveredPaths, stale: false };
}

async function walkForRootedWorkflowDirectories(
  currentDirectory: string,
  discoveredPaths: string[],
): Promise<void> {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sortedEntries) {
    if (!entry.isDirectory()) continue;

    const entryPath = path.join(currentDirectory, entry.name);
    if (shouldSkipDirectory(entry.name)) continue;

    if (entry.name === '.workrail') {
      const workflowsDirectory = path.join(entryPath, 'workflows');
      if (await isDirectory(workflowsDirectory)) {
        discoveredPaths.push(path.resolve(workflowsDirectory));
      }
      continue;
    }

    // Guard recursive descent: a subdirectory may vanish between readdir and recurse.
    // ENOENT here means the subdir disappeared mid-walk -- skip it, not the whole root.
    await walkForRootedWorkflowDirectories(entryPath, discoveredPaths).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
}

function shouldSkipDirectory(name: string): boolean {
  return name === '.git' || name === 'node_modules';
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function fileUriToFsPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
