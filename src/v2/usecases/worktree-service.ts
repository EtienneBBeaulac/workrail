/**
 * Worktree Service — reads git worktree state for the Console UI.
 *
 * Pure read-only. No DI needed — git is a stable external tool.
 * Accepts multiple repo roots (derived from session observations) so the console
 * can group worktrees by project rather than only showing the current CWD's repo.
 *
 * Why not a port: git is not an application boundary we need to mock in tests.
 * The console is a dev-time tool; a real git repo is always present.
 *
 * Two-phase scan design:
 * - Fast path: `git worktree list --porcelain` per repo (~100ms total, any repo size)
 *   returns branch names and paths only. Response is immediate.
 * - Background enrichment: per-worktree git commands (6 per worktree) run after the
 *   response is sent. When complete, onEnrichmentComplete callback fires so the route
 *   can push a `worktrees-updated` SSE event. The client then re-fetches and gets
 *   fully enriched data.
 *
 * This eliminates the timeout problem for repos with 79+ worktrees.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { basename } from 'path';
import type {
  ConsoleWorktreeSummary,
  ConsoleRepoWorktrees,
  ConsoleWorktreeListResponse,
  ConsoleSessionStatus,
  ChangedFile,
  FileChangeStatus,
  WorktreeEnrichment,
} from './console-types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** 5 s ceiling per git command — prevents the endpoint hanging on credential
 * prompts, network fetches, or a locked index. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Discriminate child_process execution errors from programmer errors.
 *
 * Two classes of execution error need to be caught:
 * - ExecFileException (non-zero exit, timeout): carries a `killed` property
 * - Spawn errors (ENOENT cwd or binary, EACCES): system errors with `syscall`
 *   starting with 'spawn'. These do NOT carry `killed`.
 *
 * TypeError, ReferenceError, etc. don't match either pattern and propagate.
 */
function isExecError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if ('killed' in e) return true; // ExecFileException (non-zero exit, timeout)
  const sys = (e as NodeJS.ErrnoException).syscall ?? '';
  return sys.startsWith('spawn'); // ENOENT/EACCES from spawn (bad cwd or missing binary)
}

/**
 * Run a git command and return stdout trimmed, or null on execution failure.
 *
 * null is an explicit signal — callers must handle it rather than conflating
 * a failed command with empty output (e.g. `git status --short` on a clean
 * repo legitimately returns ''). Programmer errors (TypeError etc.) are
 * re-thrown so they surface rather than being masked as missing git data.
 *
 * Async so per-worktree enrichment can be parallelized with Promise.allSettled.
 */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (e: unknown) {
    if (isExecError(e)) return null;
    throw e;
  }
}

interface RawWorktree {
  path: string;
  head: string;
  branch: string | null; // null = detached
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Each entry is separated by a blank line and looks like:
 *   worktree /abs/path
 *   HEAD abc1234
 *   branch refs/heads/my-branch   <- absent if detached
 *   detached                       <- present if detached
 */
function parseWorktreePorcelain(raw: string): RawWorktree[] {
  const entries: RawWorktree[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const pathLine = lines.find(l => l.startsWith('worktree '));
    const headLine = lines.find(l => l.startsWith('HEAD '));
    const branchLine = lines.find(l => l.startsWith('branch '));
    if (!pathLine || !headLine) continue;
    const path = pathLine.slice('worktree '.length).trim();
    const head = headLine.slice('HEAD '.length).trim();
    const branch = branchLine
      ? branchLine.slice('branch refs/heads/'.length).trim()
      : null;
    entries.push({ path, head, branch });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Foreground semaphore: limit concurrent git subprocess batches
//
// enrichWorktree runs 6 git commands in parallel per worktree via Promise.all.
// Without a cap, a repo with 101 worktrees spawns 606 concurrent subprocesses
// per /api/v2/worktrees request, saturating the OS process table and causing
// 12.5s response times and 140%+ CPU usage.
//
// With MAX_CONCURRENT_ENRICHMENTS=8: at most 48 concurrent git processes
// (8 worktrees x 6 commands). Total latency for 101 worktrees becomes
// ~ceil(101/8) x single-worktree-time rather than max single-worktree-time.
//
// Invariant: activeEnrichments counts RUNNING enrichments only.
// When a slot is released and there is a waiter, the slot is TRANSFERRED
// (count stays the same) by calling the waiter's resolve directly.
// The waiter callback must NOT increment activeEnrichments -- that would
// cause the counter to drift upward after each request, eventually leaving
// it permanently at MAX_CONCURRENT_ENRICHMENTS and hanging all future requests.
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_ENRICHMENTS = 8;
let activeEnrichments = 0;
const enrichmentQueue: Array<() => void> = [];

function acquireEnrichmentSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeEnrichments < MAX_CONCURRENT_ENRICHMENTS) {
      activeEnrichments++;
      resolve();
    } else {
      // Store only the resolve callback. The slot count is already accounted for
      // by the releasing side: releaseEnrichmentSlot transfers the slot without
      // changing activeEnrichments, so the waiter must NOT increment it again.
      enrichmentQueue.push(resolve);
    }
  });
}

function releaseEnrichmentSlot(): void {
  const next = enrichmentQueue.shift();
  if (next) {
    // Transfer the slot to the next waiter: count stays the same.
    next();
  } else {
    activeEnrichments--;
  }
}

// ---------------------------------------------------------------------------
// Background semaphore: separate capacity for off-request-path enrichment
//
// Background enrichment runs after the HTTP response is sent, so it must not
// compete with foreground request-path operations for the same semaphore slots.
// Using a separate semaphore with a higher cap (MAX=16) allows background work
// to proceed faster without impacting foreground request latency.
//
// Same slot-transfer invariant as the foreground semaphore.
// ---------------------------------------------------------------------------

const MAX_BACKGROUND_ENRICHMENTS = 16;
let activeBackgroundEnrichments = 0;
const backgroundEnrichmentQueue: Array<() => void> = [];

function acquireBackgroundSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeBackgroundEnrichments < MAX_BACKGROUND_ENRICHMENTS) {
      activeBackgroundEnrichments++;
      resolve();
    } else {
      backgroundEnrichmentQueue.push(resolve);
    }
  });
}

function releaseBackgroundSlot(): void {
  const next = backgroundEnrichmentQueue.shift();
  if (next) {
    next();
  } else {
    activeBackgroundEnrichments--;
  }
}

// ---------------------------------------------------------------------------
// Per-worktree enrichment
// ---------------------------------------------------------------------------

/**
 * Map a git status XY code to a FileChangeStatus.
 *
 * XY codes: X = index (staged), Y = worktree (unstaged). Both columns are
 * checked because we report a file as changed regardless of whether the change
 * is staged, unstaged, or both. '??' is the special untracked marker.
 */
function parseFileStatus(xy: string): FileChangeStatus {
  if (xy === '??') return 'untracked';
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (x === 'R') return 'renamed';
  if (x === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'M' || y === 'M') return 'modified';
  return 'other';
}

/**
 * Parse `git status --short` output into individual ChangedFile entries.
 *
 * Each line is formatted as `XY path` where XY is a two-character status code
 * and path starts at the third character. Blank lines are skipped.
 */
function parseChangedFiles(statusRaw: string): readonly ChangedFile[] {
  if (!statusRaw) return [];
  return statusRaw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => ({
      status: parseFileStatus(line.slice(0, 2)),
      path: line.slice(3),
    }));
}

// Hardcoded to origin/main -- repos using master/trunk will silently degrade (badges disappear, no crash)
const MAIN_BRANCH_REF = 'origin/main';

/**
 * Enrich a single worktree by running its git commands in parallel.
 * Each command is independent so there is no reason to serialize them.
 */
async function enrichWorktree(wt: RawWorktree): Promise<WorktreeEnrichment> {
  // Branch description is stored in the repo's git config (not the worktree's
  // local config), so it is readable from any linked worktree via the same
  // `git config` call. Returns null when the key is unset -- git exits non-zero.
  const descriptionKey = wt.branch ? `branch.${wt.branch}.description` : null;
  const [logRaw, statusRaw, aheadRaw, descriptionRaw, unpushedLogRaw, mergedBranchesRaw] = await Promise.all([
    git(wt.path, ['log', '-1', '--format=%h%n%s%n%ct']),
    git(wt.path, ['status', '--short']),
    git(wt.path, ['rev-list', '--count', `${MAIN_BRANCH_REF}..HEAD`]),
    descriptionKey ? git(wt.path, ['config', descriptionKey]) : Promise.resolve(null),
    git(wt.path, ['log', `${MAIN_BRANCH_REF}..HEAD`, '--oneline']),
    // git branch --merged uses merge-base comparison, so it correctly handles
    // squash-merges. The badge shows when the branch tip is reachable from
    // origin/main OR when the branch's changes have been squash-merged.
    wt.branch && wt.branch !== 'main' ? git(wt.path, ['branch', '--merged', MAIN_BRANCH_REF]) : Promise.resolve(null),
  ]);

  const [hashLine, messageLine, timestampLine] = logRaw?.split('\n') ?? [];
  const headHash = hashLine?.trim() || wt.head.slice(0, 7);
  const headMessage = messageLine?.trim() ?? '';
  const headTimestampMs = timestampLine ? parseInt(timestampLine.trim(), 10) * 1000 : 0;

  // statusRaw === null means git failed; '' means clean — do not conflate them
  const changedFiles = statusRaw !== null ? parseChangedFiles(statusRaw) : [];
  const changedCount = changedFiles.length;

  // parseInt can return NaN if aheadRaw is '' (unexpected but possible)
  const parsedAhead = aheadRaw !== null ? parseInt(aheadRaw, 10) : NaN;
  const aheadCount = isNaN(parsedAhead) ? 0 : parsedAhead;

  // null or '' means no unpushed commits (or git failed)
  const unpushedCommits: readonly { readonly hash: string; readonly message: string }[] =
    unpushedLogRaw
      ? unpushedLogRaw.split('\n').filter(l => l.trim().length > 0).map(line => ({
          hash: line.slice(0, 7),
          message: line.slice(8),
        }))
      : [];

  // Use `git branch --merged origin/main` to detect squash-merges correctly.
  // The output lists all branches whose tips are reachable from origin/main after
  // squash-merge. If the current branch name appears in the output, it is merged.
  // Never true for main itself, detached HEAD (null branch), or when the git command failed.
  const isMerged =
    wt.branch !== null &&
    wt.branch !== 'main' &&
    mergedBranchesRaw !== null &&
    mergedBranchesRaw.split('\n').some(line => line.trim() === wt.branch);

  const description = descriptionRaw?.trim() ?? '';

  return { headHash, headMessage, headTimestampMs, changedCount, changedFiles, aheadCount, unpushedCommits, isMerged, description };
}

// ---------------------------------------------------------------------------
// Per-repo operations
// ---------------------------------------------------------------------------

/**
 * Resolve the git root for a given path, or null if it is not a git repo.
 * Used by the route to canonicalize the CWD before adding it to the repo list.
 */
export async function resolveRepoRoot(path: string): Promise<string | null> {
  // Use --git-common-dir to resolve linked worktrees back to the main repo root.
  // For the main worktree this returns ".git" (relative); for a linked worktree
  // it returns an absolute path like /repo/.git. Stripping the .git suffix gives
  // the canonical repo root, deduplicating all worktrees of the same repo.
  const commonDir = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir === null) return null;
  return commonDir.replace(/\/\.git\/?$/, '') || null;
}

/**
 * Build a fast (unenriched) ConsoleWorktreeSummary for each worktree in a repo.
 * Uses `git worktree list --porcelain` which is a single fast local operation.
 * All enrichment fields default to safe values (0, [], false, '').
 * `enrichment: null` signals that background enrichment has not yet completed.
 */
async function buildFastWorktrees(
  repoRoot: string,
): Promise<readonly ConsoleWorktreeSummary[] | null> {
  const porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return null;

  const rawWorktrees = parseWorktreePorcelain(porcelain);
  return rawWorktrees.map((wt): ConsoleWorktreeSummary => ({
    path: wt.path,
    name: basename(wt.path),
    branch: wt.branch,
    // Safe defaults for all enrichment-derived flat fields
    headHash: wt.head.slice(0, 7),
    headMessage: '',
    headTimestampMs: 0,
    changedCount: 0,
    changedFiles: [],
    aheadCount: 0,
    unpushedCommits: [],
    isMerged: false,
    activeSessionCount: 0, // populated later by applyActiveSessionsAndSort
    // enrichment: null signals "background scan not yet complete"
    enrichment: null,
  }));
}

/**
 * Enrich all worktrees for a single repo root using the background semaphore.
 * Returns null if the repo root is inaccessible.
 * Returns an empty array if all enrichments failed.
 */
async function enrichRepo(
  repoRoot: string,
): Promise<readonly ConsoleWorktreeSummary[] | null> {
  const porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return null;

  const rawWorktrees = parseWorktreePorcelain(porcelain);

  // Enrich all worktrees in parallel, gated by the BACKGROUND semaphore.
  // Promise.allSettled so a single broken worktree does not fail the entire repo.
  const results = await Promise.allSettled(
    rawWorktrees.map(async (wt) => {
      await acquireBackgroundSlot();
      try {
        return await enrichWorktree(wt);
      } finally {
        releaseBackgroundSlot();
      }
    }),
  );

  const worktrees: ConsoleWorktreeSummary[] = rawWorktrees.flatMap((wt, i) => {
    const result = results[i]!;
    if (result.status === 'rejected') {
      console.warn(`[WorktreeService] Failed to enrich worktree at ${wt.path}:`, result.reason);
      return [];
    }
    const e = result.value;
    const enrichment: WorktreeEnrichment = {
      headHash: e.headHash,
      headMessage: e.headMessage,
      headTimestampMs: e.headTimestampMs,
      changedCount: e.changedCount,
      changedFiles: e.changedFiles,
      aheadCount: e.aheadCount,
      unpushedCommits: e.unpushedCommits,
      isMerged: e.isMerged,
      description: e.description,
    };
    return [{
      path: wt.path,
      name: basename(wt.path),
      branch: wt.branch,
      // Flat fields mirrored from enrichment for backward compat with consumers
      headHash: e.headHash,
      headMessage: e.headMessage,
      headTimestampMs: e.headTimestampMs,
      changedCount: e.changedCount,
      changedFiles: e.changedFiles,
      aheadCount: e.aheadCount,
      unpushedCommits: e.unpushedCommits,
      isMerged: e.isMerged,
      activeSessionCount: 0, // applied later in applyActiveSessionsAndSort
      // Empty string means unset -- omit from the flat field so consumers can use simple truthiness checks
      ...(e.description ? { description: e.description } : {}),
      enrichment,
    }];
  });

  // Sort: dirty first, then by recency. Active sessions applied afterward.
  return [...worktrees].sort((a, b) => {
    if (b.changedCount !== a.changedCount) return b.changedCount - a.changedCount;
    return b.headTimestampMs - a.headTimestampMs;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ActiveSessionsByBranch {
  /** branch name -> count of in_progress sessions */
  readonly counts: ReadonlyMap<string, number>;
}

/**
 * Build active session counts from session summaries.
 * Extracted so callers can pass in pre-fetched session data.
 */
export function buildActiveSessionCounts(
  sessions: ReadonlyArray<{ gitBranch: string | null; status: ConsoleSessionStatus }>,
): ActiveSessionsByBranch {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (s.gitBranch && s.status === 'in_progress') {
      counts.set(s.gitBranch, (counts.get(s.gitBranch) ?? 0) + 1);
    }
  }
  return { counts };
}

// ---------------------------------------------------------------------------
// Worktree scan result cache
//
// Two-phase design:
// - unenrichedRepos: available immediately after `git worktree list --porcelain`
//   (fast path, <1s for any repo size). All worktrees have enrichment: null.
// - enrichedRepos: null until background enrichment completes. Once set, all
//   worktrees have full enrichment data. getWorktreeList serves enrichedRepos
//   when available, falls back to unenrichedRepos otherwise.
//
// Cache TTL of 45s: longer than the 30s frontend poll interval so steady-state
// polls always hit the cache. The enriched data changes infrequently (branch
// switches, commits); active session counts are applied fresh on every request.
// ---------------------------------------------------------------------------

const WORKTREE_CACHE_TTL_MS = 45_000;

interface WorktreeCache {
  /** Fast-path data: branch + path only, enrichment: null on all worktrees. */
  readonly unenrichedRepos: readonly ConsoleRepoWorktrees[];
  /** Background-enriched data: null until enrichment completes. */
  readonly enrichedRepos: readonly ConsoleRepoWorktrees[] | null;
  readonly cachedAtMs: number;
  /** Canonical key used to detect repo root changes (comma-joined sorted paths). */
  readonly repoRootsKey: string;
}

let worktreeCache: WorktreeCache | null = null;

// ---------------------------------------------------------------------------
// Background enrichment
//
// Deduplication guard: prevents N concurrent cold-cache requests from each
// launching a separate background scan. Only one background scan runs at a time
// per cache window. This is the same class of problem that the foreground
// `inflight` pattern solved -- background enrichment needs the same protection.
//
// The guard is reset in the finally block of runBackgroundEnrichment so it is
// always released even on timeout or error.
// ---------------------------------------------------------------------------

let backgroundEnrichmentInFlight = false;

/** 120s ceiling for background enrichment -- much longer than request timeout.
 * Individual git commands are still bounded by GIT_TIMEOUT_MS=5s so the
 * realistic worst case for 79 worktrees is ceil(79/16) * 5s = ~25s. */
const BACKGROUND_ENRICHMENT_TIMEOUT_MS = 120_000;

/** Callback invoked when background enrichment completes -- used to broadcast SSE. */
let onEnrichmentComplete: (() => void) | null = null;

/**
 * Register a callback to be invoked when background enrichment finishes.
 * Called once at server startup by mountConsoleRoutes.
 * The callback broadcasts a `worktrees-updated` SSE event to all connected clients.
 */
export function setEnrichmentCompleteCallback(cb: () => void): void {
  onEnrichmentComplete = cb;
}

async function scanRepos(
  repoRoots: readonly string[],
): Promise<readonly ConsoleRepoWorktrees[]> {
  const repoResults = await Promise.allSettled(
    repoRoots.map(async (repoRoot) => {
      const worktrees = await enrichRepo(repoRoot);
      return { repoRoot, worktrees };
    }),
  );

  return repoResults.flatMap((result) => {
    if (result.status === 'rejected') {
      console.warn(`[WorktreeService] Failed to enrich repo:`, result.reason);
      return [];
    }
    const { repoRoot, worktrees } = result.value;
    if (!worktrees || worktrees.length === 0) return [];
    return [{
      repoName: basename(repoRoot),
      repoRoot,
      worktrees,
    }];
  });
}

/**
 * Run background enrichment for the given repo roots.
 * Updates the cache with enriched data when complete.
 * Invokes onEnrichmentComplete to trigger SSE broadcast.
 * Always releases the backgroundEnrichmentInFlight guard.
 */
async function runBackgroundEnrichment(
  repoRoots: readonly string[],
  repoRootsKey: string,
): Promise<void> {
  try {
    const enriched = await Promise.race([
      scanRepos(repoRoots),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('background enrichment timeout')), BACKGROUND_ENRICHMENT_TIMEOUT_MS)
      ),
    ]);
    // Only write to cache if the repo roots haven't changed since the scan started.
    // If the user opened a new workspace during enrichment, the stale result is
    // discarded -- but we must NOT leave the current cache with enrichedRepos: null
    // indefinitely. The finally block resets backgroundEnrichmentInFlight so the
    // next request to getWorktreeList (next poll) will trigger a fresh background scan.
    if (worktreeCache?.repoRootsKey === repoRootsKey) {
      worktreeCache = { ...worktreeCache, enrichedRepos: enriched };
      onEnrichmentComplete?.();
    }
  } catch {
    // Background enrichment failed or timed out -- unenriched data remains in cache.
    // The next TTL expiry will trigger a fresh fast path + new background scan.
  } finally {
    backgroundEnrichmentInFlight = false;
  }
}

/**
 * Apply current active-session counts on top of cached repos and sort.
 *
 * Active-session counts change frequently (every continue_workflow step), so
 * they are always applied fresh rather than cached with git data.
 *
 * Sort order: repos with active sessions first, then alphabetical by name.
 */
function applyActiveSessionsAndSort(
  repos: readonly ConsoleRepoWorktrees[],
  activeSessions: ActiveSessionsByBranch,
): ConsoleWorktreeListResponse {
  const reposWithActiveSessions: ConsoleRepoWorktrees[] = repos.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((wt) => ({
      ...wt,
      activeSessionCount: wt.branch ? (activeSessions.counts.get(wt.branch) ?? 0) : 0,
    })),
  }));

  // Sort: repos with active sessions first, then alphabetical by name.
  const sortedRepos = [...reposWithActiveSessions].sort((a, b) => {
    const aActive = a.worktrees.some(w => w.activeSessionCount > 0) ? 0 : 1;
    const bActive = b.worktrees.some(w => w.activeSessionCount > 0) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.repoName.localeCompare(b.repoName);
  });

  return { repos: sortedRepos };
}

/**
 * Return worktrees for each of the given repo roots, grouped per repo.
 *
 * Fast path: if cache is stale or empty, runs `git worktree list --porcelain`
 * per repo (<1s total) and returns immediately with unenriched data. Background
 * enrichment is triggered concurrently and will push a `worktrees-updated` SSE
 * event when complete.
 *
 * Enriched path: once background enrichment completes and the client refetches
 * (triggered by the SSE event), the enriched data is served from cache.
 *
 * Active session counts are applied on top of cached git data so they always
 * reflect the current session state even when serving a cached scan.
 */
export async function getWorktreeList(
  repoRoots: readonly string[],
  activeSessions: ActiveSessionsByBranch,
): Promise<ConsoleWorktreeListResponse> {
  const repoRootsKey = [...repoRoots].sort().join(',');
  const nowMs = Date.now();

  const isCacheValid =
    worktreeCache !== null &&
    worktreeCache.repoRootsKey === repoRootsKey &&
    nowMs - worktreeCache.cachedAtMs < WORKTREE_CACHE_TTL_MS;

  if (!isCacheValid) {
    // Fast path: list all worktrees in parallel (~100ms for any repo size)
    const fastRepoResults = await Promise.allSettled(
      repoRoots.map(async (repoRoot) => {
        const worktrees = await buildFastWorktrees(repoRoot);
        return { repoRoot, worktrees };
      }),
    );

    const fastRepos: ConsoleRepoWorktrees[] = fastRepoResults.flatMap((result) => {
      if (result.status === 'rejected') return [];
      const { repoRoot, worktrees } = result.value;
      if (!worktrees || worktrees.length === 0) return [];
      return [{ repoName: basename(repoRoot), repoRoot, worktrees }];
    });

    worktreeCache = {
      unenrichedRepos: fastRepos,
      enrichedRepos: null,
      cachedAtMs: nowMs,
      repoRootsKey,
    };

    // Trigger background enrichment only if one isn't already running.
    // This prevents N concurrent cold-cache requests from each launching
    // a separate background scan (same problem inflight solved for foreground).
    if (!backgroundEnrichmentInFlight) {
      backgroundEnrichmentInFlight = true;
      void runBackgroundEnrichment(repoRoots, repoRootsKey);
    }
  }

  // Use enriched data if available, fall back to unenriched.
  // worktreeCache is non-null here: set in the cache-miss block above, or confirmed valid at isCacheValid.
  const cache = worktreeCache!;
  const repos = cache.enrichedRepos ?? cache.unenrichedRepos;
  return applyActiveSessionsAndSort(repos, activeSessions);
}
