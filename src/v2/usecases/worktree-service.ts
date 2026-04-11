/**
 * Worktree Service — reads git worktree state for the Console UI.
 *
 * Pure read-only. No DI needed — git is a stable external tool.
 * Accepts multiple repo roots (derived from session observations) so the console
 * can group worktrees by project rather than only showing the current CWD's repo.
 *
 * Why not a port: git is not an application boundary we need to mock in tests.
 * The console is a dev-time tool; a real git repo is always present.
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
 * Execution errors (non-zero exit, ENOENT, ETIMEDOUT) are set by Node's
 * child_process module and always carry a `killed` property. TypeError,
 * ReferenceError, etc. do not — those are bugs in our code and must
 * propagate rather than being silently swallowed.
 */
function isExecError(e: unknown): boolean {
  return e instanceof Error && 'killed' in e;
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
// Semaphore: limit concurrent git subprocess batches
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

interface WorktreeEnrichment {
  headHash: string;
  headMessage: string;
  headTimestampMs: number;
  changedCount: number;
  changedFiles: readonly ChangedFile[];
  aheadCount: number;
  unpushedCommits: readonly { readonly hash: string; readonly message: string }[];
  isMerged: boolean;
  /** Content of `git config branch.<name>.description`, or empty string if unset. */
  branchDescription: string;
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

  const branchDescription = descriptionRaw?.trim() ?? '';

  return { headHash, headMessage, headTimestampMs, changedCount, changedFiles, aheadCount, unpushedCommits, isMerged, branchDescription };
}

// ---------------------------------------------------------------------------
// Per-repo enrichment
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
 * Enrich all worktrees for a single repo root.
 * Returns null if the repo root is inaccessible (not a git repo, deleted, etc.).
 * Returns an empty array if the repo is valid but has no worktrees to enrich
 * (all enrichments failed) — callers filter out empty repos.
 */
async function enrichRepo(
  repoRoot: string,
  activeSessions: ActiveSessionsByBranch,
): Promise<readonly ConsoleWorktreeSummary[] | null> {
  const porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return null;

  const rawWorktrees = parseWorktreePorcelain(porcelain);

  // Enrich all worktrees in parallel, gated by the process-level semaphore.
  // Each enrichWorktree call runs 6 git commands concurrently; the semaphore
  // limits how many worktrees are enriched at once so we don't fan out to
  // hundreds of simultaneous git subprocesses across multiple repo roots.
  //
  // Promise.allSettled so a single broken worktree (unexpected JS error, not a
  // git failure -- those are already handled in git()) does not silently fail the
  // entire repo. Rejected entries are logged and excluded: surface info, don't hide it.
  const results = await Promise.allSettled(
    rawWorktrees.map(async (wt) => {
      await acquireEnrichmentSlot();
      try {
        return await enrichWorktree(wt);
      } finally {
        releaseEnrichmentSlot();
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
    return [{
      path: wt.path,
      name: basename(wt.path),
      branch: wt.branch,
      headHash: e.headHash,
      headMessage: e.headMessage,
      headTimestampMs: e.headTimestampMs,
      changedCount: e.changedCount,
      changedFiles: e.changedFiles,
      aheadCount: e.aheadCount,
      unpushedCommits: e.unpushedCommits,
      isMerged: e.isMerged,
      activeSessionCount: wt.branch ? (activeSessions.counts.get(wt.branch) ?? 0) : 0,
      // Empty string means unset -- omit from the type so consumers can use simple truthiness checks
      ...(e.branchDescription ? { description: e.branchDescription } : {}),
    }];
  });

  // Sort: active sessions first, then dirty, then by recency.
  // Spread before sorting — keeps the mutation local rather than mutating
  // a fresh flatMap result in place before handing it out as readonly.
  return [...worktrees].sort((a, b) => {
    if (b.activeSessionCount !== a.activeSessionCount) return b.activeSessionCount - a.activeSessionCount;
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
// The console UI polls /api/v2/worktrees every few seconds. Without caching,
// each poll triggers a full git scan of all worktrees. With caching, the first
// request in each TTL window does the scan; concurrent and near-concurrent
// requests get the stale result immediately.
//
// Active-session counts change frequently (every continue_workflow), so the
// TTL is kept short. The repos/branches list changes infrequently, so even a
// 15s stale read is acceptable for the git data portion.
//
// In-flight deduplication: if a scan is already running when a second request
// arrives, the second request awaits the same promise rather than launching
// a duplicate scan. This prevents the semaphore from being acquired twice
// simultaneously for the same repo set.
// ---------------------------------------------------------------------------

const WORKTREE_CACHE_TTL_MS = 15_000;

interface WorktreeCache {
  readonly repos: readonly ConsoleRepoWorktrees[];
  readonly cachedAtMs: number;
  /** Canonical key used to detect repo root changes (comma-joined sorted paths). */
  readonly repoRootsKey: string;
}

let worktreeCache: WorktreeCache | null = null;
let inflight: Promise<readonly ConsoleRepoWorktrees[]> | null = null;

/** Per-repo enrichment timeout. Repos that exceed this are skipped for the
 *  current scan cycle and retried on the next TTL expiry. Prevents a single
 *  large repo (e.g. 79 worktrees) from blocking results for all others. */
const PER_REPO_TIMEOUT_MS = 8_000;

async function scanRepos(
  repoRoots: readonly string[],
): Promise<readonly ConsoleRepoWorktrees[]> {
  const repoResults = await Promise.allSettled(
    repoRoots.map(async (repoRoot) => {
      const worktrees = await Promise.race([
        enrichRepo(repoRoot, { counts: new Map() }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`repo scan timeout: ${repoRoot}`)), PER_REPO_TIMEOUT_MS)
        ),
      ]);
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
 * Return worktrees for each of the given repo roots, grouped per repo.
 *
 * Repos are enriched in parallel. Repos with 0 worktrees (inaccessible root,
 * or all enrichments failed) are omitted from the result — an empty section
 * header would be confusing when the repo's path no longer exists.
 *
 * Active session counts are applied on top of cached git data so they always
 * reflect the current session state even when serving a cached scan.
 *
 * Sort order: repos with active sessions first, then alphabetical by repo name.
 */
export async function getWorktreeList(
  repoRoots: readonly string[],
  activeSessions: ActiveSessionsByBranch,
): Promise<ConsoleWorktreeListResponse> {
  const repoRootsKey = [...repoRoots].sort().join(',');
  const nowMs = Date.now();

  let repos: readonly ConsoleRepoWorktrees[];

  const isCacheValid =
    worktreeCache !== null &&
    worktreeCache.repoRootsKey === repoRootsKey &&
    nowMs - worktreeCache.cachedAtMs < WORKTREE_CACHE_TTL_MS;

  if (isCacheValid) {
    repos = worktreeCache!.repos;
  } else {
    // Deduplicate concurrent scans: if a scan is already running, await it.
    if (inflight === null) {
      inflight = scanRepos(repoRoots).finally(() => { inflight = null; });
    }
    repos = await inflight;
    worktreeCache = { repos, cachedAtMs: Date.now(), repoRootsKey };
  }

  // Apply current active-session counts on top of (possibly cached) git data.
  // This keeps session badges up-to-date without re-scanning git on every poll.
  const reposWithActiveSessions: ConsoleRepoWorktrees[] = repos.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((wt) => ({
      ...wt,
      activeSessionCount: wt.branch ? (activeSessions.counts.get(wt.branch) ?? 0) : 0,
    })),
  }));

  // Sort: repos with active sessions first, then alphabetical by name.
  // Spread before sorting — same immutability rationale as enrichRepo.
  const sortedRepos = [...reposWithActiveSessions].sort((a, b) => {
    const aActive = a.worktrees.some(w => w.activeSessionCount > 0) ? 0 : 1;
    const bActive = b.worktrees.some(w => w.activeSessionCount > 0) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.repoName.localeCompare(b.repoName);
  });

  return { repos: sortedRepos };
}
