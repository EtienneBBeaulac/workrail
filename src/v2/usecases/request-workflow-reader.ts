import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IWorkflowReader } from '../../types/storage.js';
import type { IFeatureFlagProvider } from '../../config/feature-flags.js';
import { createEnhancedMultiSourceWorkflowStorage } from '../../infrastructure/storage/enhanced-multi-source-workflow-storage.js';
import { SchemaValidatingCompositeWorkflowStorage } from '../../infrastructure/storage/schema-validating-workflow-storage.js';
import type { RememberedRootsStorePortV2 } from '../ports/remembered-roots-store.port.js';
import type { ManagedSourceRecordV2, ManagedSourceStorePortV2 } from '../ports/managed-source-store.port.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { isWorkspaceAncestor, getGitCommonDir } from '../../utils/workspace-path-utils.js';

// ---------------------------------------------------------------------------
// Walk skip list
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git', 'node_modules',
  'build', 'dist', 'out', 'target',
  '.gradle', '.gradle-cache', '.cache',
  'DerivedData', 'Pods',
  'vendor',
  '__pycache__', '.venv', 'venv',
  '.next', '.nuxt', '.turbo', '.parcel-cache',
  '.claude', '.claude-worktrees', '.firebender',
  'coverage', '.nyc_output',
]);

// ---------------------------------------------------------------------------
// Walk depth limit
// ---------------------------------------------------------------------------

// .workrail/workflows will never be nested more than 5 levels deep in a
// typical project layout (workspace/project/module/src/pkg/.workrail).
// Capping here prevents unbounded traversal into deep build artifact trees
// that are not in the skip list.
const MAX_WALK_DEPTH = 5;

// ---------------------------------------------------------------------------
// Walk result cache
// ---------------------------------------------------------------------------

const WALK_CACHE_TTL_MS = 300_000; // 5 min
interface WalkCacheEntry {
  readonly result: WorkflowRootDiscoveryResult;
  readonly expiresAt: number;
}
const walkCache = new Map<string, WalkCacheEntry>();

const walkInFlight = new Map<string, Promise<WorkflowRootDiscoveryResult>>();

/**
 * Exported for test isolation only -- do not use in production code.
 */
export function clearWalkCacheForTesting(): void {
  walkCache.clear();
  walkInFlight.clear();
}

// ---------------------------------------------------------------------------
// Discovery timeout
// ---------------------------------------------------------------------------

const DISCOVERY_TIMEOUT_MS = 10_000;

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

export function discoverRootedWorkflowDirectories(
  roots: readonly string[],
): Promise<WorkflowRootDiscoveryResult> {
  const cacheKey = roots.map((r) => path.resolve(r)).sort().join('\0');
  const now = Date.now();
  const cached = walkCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.result);
  }

  const inFlight = walkInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = _doWalk(cacheKey, roots, now);
  walkInFlight.set(cacheKey, promise);
  promise.then(
    () => walkInFlight.delete(cacheKey),
    () => walkInFlight.delete(cacheKey),
  );
  return promise;
}

async function _doWalk(
  cacheKey: string,
  roots: readonly string[],
  now: number,
): Promise<WorkflowRootDiscoveryResult> {
  const discoveredByPath = new Set<string>();
  const discoveredPaths: string[] = [];
  const stalePaths: string[] = [];

  const resolvedRoots = roots.map((r) => path.resolve(r));
  const rootResults = await Promise.allSettled(
    resolvedRoots.map((rootPath) => discoverWorkflowDirectoriesUnderRoot(rootPath)),
  );

  for (let i = 0; i < resolvedRoots.length; i++) {
    const rootPath = resolvedRoots[i]!;
    const rootResult = rootResults[i]!;
    if (rootResult.status === 'rejected') {
      throw rootResult.reason;
    }
    if (rootResult.value.stale) {
      stalePaths.push(rootPath);
      continue;
    }
    for (const nextPath of rootResult.value.discovered) {
      const normalizedPath = path.resolve(nextPath);
      if (discoveredByPath.has(normalizedPath)) continue;
      discoveredByPath.add(normalizedPath);
      discoveredPaths.push(normalizedPath);
    }
  }

  const result: WorkflowRootDiscoveryResult = { discovered: discoveredPaths, stale: stalePaths };
  walkCache.set(cacheKey, { result, expiresAt: now + WALK_CACHE_TTL_MS });
  return result;
}

export interface WorkflowReaderForRequestResult {
  readonly reader: IWorkflowReader;
  readonly stalePaths: readonly string[];
  readonly managedSourceRecords: readonly ManagedSourceRecordV2[];
  readonly staleManagedRecords: readonly ManagedSourceRecordV2[];
  readonly excludedByScope: readonly string[];
  readonly managedStoreError?: string;
}

export async function filterRememberedRootsForWorkspace(
  allRoots: readonly string[],
  workspace: string,
): Promise<readonly string[]> {
  const ancestorRoots = allRoots.filter((r) => isWorkspaceAncestor(r, workspace));
  const nonAncestorRoots = allRoots.filter((r) => !isWorkspaceAncestor(r, workspace));

  let siblingRoots: readonly string[] = [];
  if (nonAncestorRoots.length > 0) {
    const workspaceCommonDir = await getGitCommonDir(workspace);
    if (workspaceCommonDir !== null) {
      const commonDirResults = await Promise.all(nonAncestorRoots.map((r) => getGitCommonDir(r)));
      siblingRoots = nonAncestorRoots.filter((_, i) => commonDirResults[i] === workspaceCommonDir);
    }
  }

  return [...ancestorRoots, ...siblingRoots];
}

export async function createWorkflowReaderForRequest(
  options: RequestWorkflowReaderOptions,
): Promise<WorkflowReaderForRequestResult> {
  const workspaceDirectory = resolveRequestWorkspaceDirectory(options);
  const projectWorkflowDirectory = toProjectWorkflowDirectory(workspaceDirectory);
  const allRememberedRoots = await listRememberedRoots(options.rememberedRootsStore);
  const resolvedWorkspace = path.resolve(workspaceDirectory);

  const rememberedRoots = await filterRememberedRootsForWorkspace(allRememberedRoots, resolvedWorkspace);
  const excludedByScope = allRememberedRoots.filter((root) => !rememberedRoots.includes(root));

  let discoveryResult: WorkflowRootDiscoveryResult;
  try {
    discoveryResult = await withTimeout(
      discoverRootedWorkflowDirectories(rememberedRoots),
      DISCOVERY_TIMEOUT_MS,
      'workflow_root_discovery',
    );
  } catch {
    discoveryResult = { discovered: [], stale: [] };
  }
  const { discovered: rootedWorkflowDirectories, stale: stalePaths } = discoveryResult;

  const rootedCustomPaths = rootedWorkflowDirectories.filter((directory) => directory !== projectWorkflowDirectory);

  const { records: allManagedRecords, storeError: managedStoreError } = await listManagedSourceRecords(options.managedSourceStore);
  const envCustomPaths = parseWorkflowStoragePathEnv();
  const normalizedCustom = new Set([
    ...rootedCustomPaths.map((p) => path.resolve(p)),
    ...envCustomPaths.map((p) => path.resolve(p)),
  ]);
  const additionalManagedPaths: string[] = [];
  const activeManagedRecords: ManagedSourceRecordV2[] = [];
  const staleManagedRecords: ManagedSourceRecordV2[] = [];

  const alreadyCovered: ManagedSourceRecordV2[] = [];
  const needsStatCheck: ManagedSourceRecordV2[] = [];
  for (const record of allManagedRecords) {
    if (normalizedCustom.has(path.resolve(record.path))) {
      alreadyCovered.push(record);
    } else {
      needsStatCheck.push(record);
    }
  }
  activeManagedRecords.push(...alreadyCovered);

  if (needsStatCheck.length > 0) {
    const statResults = await withTimeout(
      Promise.allSettled(needsStatCheck.map((record) => isDirectory(record.path))),
      DISCOVERY_TIMEOUT_MS,
      'managed_source_stat',
    ).catch(() => null);

    for (let i = 0; i < needsStatCheck.length; i++) {
      const record = needsStatCheck[i]!;
      const result = statResults?.[i];
      const isDir = result?.status === 'fulfilled' && result.value === true;
      if (isDir) {
        additionalManagedPaths.push(record.path);
        activeManagedRecords.push(record);
      } else {
        staleManagedRecords.push(record);
      }
    }
  }
  const customPaths = [...rootedCustomPaths, ...additionalManagedPaths];
  const allStalePaths = [...stalePaths, ...staleManagedRecords.map((r) => r.path)];

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
    excludedByScope,
    ...(managedStoreError !== undefined ? { managedStoreError } : {}),
  };
}

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
    console.error(`[workrail] Failed to load remembered workflow roots: ${result.error.code}: ${result.error.message}`);
    return [];
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
    if (await isWorkrailPackageDir(rootPath)) return { discovered: [], stale: false };
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
  depth = 0,
): Promise<void> {
  if (depth > 0 && await isWorkrailPackageDir(currentDirectory)) return;

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

    if (depth >= MAX_WALK_DEPTH) {
      if (process.env['WORKRAIL_DEV'] === '1') {
        console.error(`[workrail] walk depth limit (${MAX_WALK_DEPTH}) reached at: ${entryPath}`);
      }
      continue;
    }

    await walkForRootedWorkflowDirectories(entryPath, discoveredPaths, depth + 1).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
}

function shouldSkipDirectory(name: string): boolean {
  return SKIP_DIRS.has(name);
}

async function isWorkrailPackageDir(dirPath: string): Promise<boolean> {
  try {
    const pkgJson = await fs.readFile(path.join(dirPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgJson) as { name?: unknown };
    return pkg.name === '@exaudeus/workrail';
  } catch {
    return false;
  }
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
