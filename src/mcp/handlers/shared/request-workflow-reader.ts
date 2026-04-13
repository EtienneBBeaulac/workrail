import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IWorkflowReader } from '../../../types/storage.js';
import type { IFeatureFlagProvider } from '../../../config/feature-flags.js';
import { createEnhancedMultiSourceWorkflowStorage } from '../../../infrastructure/storage/enhanced-multi-source-workflow-storage.js';
import { SchemaValidatingCompositeWorkflowStorage } from '../../../infrastructure/storage/schema-validating-workflow-storage.js';
import type { RememberedRootsStorePortV2 } from '../../../v2/ports/remembered-roots-store.port.js';
import type { ManagedSourceRecordV2, ManagedSourceStorePortV2 } from '../../../v2/ports/managed-source-store.port.js';
import { withTimeout } from './with-timeout.js';
import { isWorkspaceAncestor, getGitCommonDir } from './workspace-path-utils.js';

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

// Keyed on sorted, path.resolve'd root paths joined by NUL.
// Invalidated automatically when the root set changes (different key).
// TTL guards against stale results within a single session when a user
// creates a new .workrail/workflows dir inside an already-remembered root.
// NOTE: adding a new root changes the key -> cache miss (correct behavior).
const WALK_CACHE_TTL_MS = 300_000; // 5 min -- covers list_workflows -> think -> start_workflow agent workflow gap
interface WalkCacheEntry {
  readonly result: WorkflowRootDiscoveryResult;
  readonly expiresAt: number;
}
const walkCache = new Map<string, WalkCacheEntry>();

// In-flight dedup: if multiple callers request the same root set concurrently
// (e.g. parallel list_workflows + start_workflow at server startup), they share
// one in-flight walk instead of each spawning independent filesystem traversals.
const walkInFlight = new Map<string, Promise<WorkflowRootDiscoveryResult>>();

/**
 * Exported for test isolation only -- do not use in production code.
 *
 * Tests MUST call this in `beforeEach` (or `afterEach`) when running in a
 * shared Jest/Vitest process pool. The walk cache is a module-level singleton;
 * without explicit clearing, cache state from one test suite bleeds into
 * subsequent suites running in the same worker process.
 */
export function clearWalkCacheForTesting(): void {
  walkCache.clear();
  walkInFlight.clear();
}

// ---------------------------------------------------------------------------
// Discovery timeout
// ---------------------------------------------------------------------------

// Caps the total time spent walking remembered root directories.
// NOTE: withTimeout races but does not cancel the underlying walk.
// The walk continues in background after timeout; subsequent calls within
// the TTL window will hit the cache so repeated background walks are avoided.
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
  // Cache key uses resolved paths so trailing slashes / relative paths hit the same entry.
  const cacheKey = roots.map((r) => path.resolve(r)).sort().join('\0');
  const now = Date.now();
  const cached = walkCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.result);
  }

  // In-flight dedup: return the existing promise if a walk for this root set is
  // already running. Concurrent callers (e.g. list_workflows + start_workflow at
  // startup) share one walk instead of each spawning independent directory traversals.
  const inFlight = walkInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = _doWalk(cacheKey, roots, now);
  walkInFlight.set(cacheKey, promise);
  // Use then+both-paths (not .finally) to clean up the in-flight entry.
  // .finally() would create a second rejected promise that triggers an
  // unhandled rejection warning when the walk throws.
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

  // Walk all roots in parallel -- each root's filesystem traversal is independent.
  // Cold walk time becomes max(slowest root) instead of sum(all roots).
  // Promise.allSettled preserves partial results if a root throws unexpectedly
  // (discoverWorkflowDirectoriesUnderRoot already handles ENOENT internally).
  const resolvedRoots = roots.map((r) => path.resolve(r));
  const rootResults = await Promise.allSettled(
    resolvedRoots.map((rootPath) => discoverWorkflowDirectoriesUnderRoot(rootPath)),
  );

  for (let i = 0; i < resolvedRoots.length; i++) {
    const rootPath = resolvedRoots[i]!;
    const rootResult = rootResults[i]!;
    if (rootResult.status === 'rejected') {
      // Re-throw non-ENOENT errors (e.g. ENOTDIR on a file path) -- these indicate a
      // caller error, not a missing root. discoverWorkflowDirectoriesUnderRoot converts
      // ENOENT into a stale result internally, so a rejected entry here is always
      // something unexpected that should propagate.
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
  /** Managed source records whose paths exist on disk and are included in composition. */
  readonly managedSourceRecords: readonly ManagedSourceRecordV2[];
  /** Managed source records whose paths are missing on disk; surfaced in staleRoots + catalog. */
  readonly staleManagedRecords: readonly ManagedSourceRecordV2[];
  /**
   * Remembered roots that were filtered out because they are not ancestors of (or equal to)
   * the current workspace. Mirrors the stalePaths pattern so callers can surface or log this
   * information without relying on the WORKRAIL_DEV debug log.
   */
  readonly excludedByScope: readonly string[];
  /**
   * Set when the managed source store could not be read (busy, IO error, or corrupted).
   * Callers should surface this as a warning so the agent knows managed sources were skipped.
   */
  readonly managedStoreError?: string;
}

/**
 * Filters `allRoots` to only those that are in scope for the given `workspace`.
 *
 * A root is in scope if it is either:
 * 1. An ancestor of (or equal to) `workspace` -- determined by lexical path comparison,
 *    no subprocess needed.
 * 2. A sibling worktree -- shares the same git common directory as `workspace`. This
 *    covers the `git worktree add ../branch-name` pattern where neither directory is
 *    an ancestor of the other but both belong to the same repository.
 *
 * The ancestor check runs first and incurs no subprocess cost. The git common-dir
 * check is lazy: it is skipped entirely when all roots pass the ancestor check.
 * Non-ancestor roots are checked in parallel to keep worst-case latency at
 * max(one subprocess) rather than N * max(one subprocess).
 *
 * @throws never -- all errors from git subprocesses are caught inside `getGitCommonDir`
 *   and surfaced as null. This function always resolves.
 */
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
  // Filter to only roots that are ancestors of (or equal to) the current workspace.
  // This prevents .workrail/workflows/ directories from unrelated repositories
  // from leaking into the workflow list when a user has visited those repos recently.
  // Engineers who relied on cross-repo bleed should use `manage_workflow_source` instead.
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
    // Discovery timed out or failed -- degrade gracefully to empty rooted sources.
    // The background walk continues running and will write to the cache when it
    // completes. A caller retrying immediately may still see empty results until
    // the background walk finishes and populates the cache.
    discoveryResult = { discovered: [], stale: [] };
  }
  const { discovered: rootedWorkflowDirectories, stale: stalePaths } = discoveryResult;

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

  // Separate already-covered records (no stat needed) from records that require a
  // filesystem check. Covered records are always active.
  const alreadyCovered: ManagedSourceRecordV2[] = [];
  const needsStatCheck: ManagedSourceRecordV2[] = [];
  for (const record of allManagedRecords) {
    if (normalizedCustom.has(path.resolve(record.path))) {
      // Already covered by rooted discovery -- the path exists and is in customPaths.
      // Still add to activeManagedRecords so the catalog annotates it as managed.
      alreadyCovered.push(record);
    } else {
      needsStatCheck.push(record);
    }
  }
  activeManagedRecords.push(...alreadyCovered);

  // Fan out stat checks in parallel and cap aggregate time with the existing discovery
  // timeout budget. Sequential fs.stat calls at 20+ managed sources would add 20+ round
  // trips even on a warm cache. Promise.allSettled (not Promise.all) isolates per-entry
  // failures: one bad NFS path must not abort the rest.
  //
  // On timeout the underlying promises continue in the background (same tradeoff as the
  // walk timeout at discoverRootedWorkflowDirectories). The next call within the TTL
  // window may still see partial results; subsequent calls after TTL expiry re-stat.
  if (needsStatCheck.length > 0) {
    const statResults = await withTimeout(
      Promise.allSettled(needsStatCheck.map((record) => isDirectory(record.path))),
      DISCOVERY_TIMEOUT_MS,
      'managed_source_stat',
    ).catch(() => null);

    for (let i = 0; i < needsStatCheck.length; i++) {
      const record = needsStatCheck[i]!;
      // On overall timeout (null) or per-entry rejection, treat as stale.
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
    excludedByScope,
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
    // Degrade gracefully: log and return empty list rather than throwing.
    // A throw here would propagate out of the bare `await createWorkflowReaderForRequest`
    // in handlers, bypassing ResultAsync error handling. Empty roots = no rooted sources
    // this call, which is safe.
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

    // Depth limit: stop recursing beyond MAX_WALK_DEPTH levels.
    // .workrail entries are checked before this guard so a directory at depth=MAX_WALK_DEPTH
    // is still inspected for .workrail -- only its non-.workrail children are skipped.
    if (depth >= MAX_WALK_DEPTH) {
      if (process.env['WORKRAIL_DEV'] === '1') {
        console.error(`[workrail] walk depth limit (${MAX_WALK_DEPTH}) reached at: ${entryPath}`);
      }
      continue;
    }

    // Guard recursive descent: a subdirectory may vanish between readdir and recurse.
    // ENOENT here means the subdir disappeared mid-walk -- skip it, not the whole root.
    await walkForRootedWorkflowDirectories(entryPath, discoveredPaths, depth + 1).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
}

function shouldSkipDirectory(name: string): boolean {
  return SKIP_DIRS.has(name);
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
