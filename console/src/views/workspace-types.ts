import type {
  ConsoleSessionSummary,
  ConsoleWorktreeSummary,
  ConsoleRepoWorktrees,
  ConsoleSessionStatus,
} from '../api/types';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type Scope = 'active' | 'all';

/**
 * Whether a WorkspaceItem is shown in the current scope.
 *
 * 'visible' -- shown in the branch list within its repo section
 * 'hidden'  -- clean, done, no activity within 30 days (omitted in Active scope)
 *
 * This replaces the old SectionKind ('active' | 'recent' | 'hidden'). In the
 * repo-sections model, within-section priority is expressed by sortPriority(),
 * not by separate section headers -- so the only meaningful distinction is
 * visible vs hidden.
 */
export type ItemVisibility = 'visible' | 'hidden';

/**
 * One item per branch per repo -- the natural unit of work identity.
 *
 * repoRoot is always non-null here. Null-repoRoot sessions are excluded before
 * the join and are only accessible via the archive link.
 *
 * activityMs is precomputed by joinSessionsAndWorktrees(); never recomputed
 * in rendering components.
 */
export interface WorkspaceItem {
  readonly branch: string;
  readonly repoRoot: string;
  readonly repoName: string;
  /** Undefined when no git worktree exists for this branch. Git badges degrade to dash. */
  readonly worktree: ConsoleWorktreeSummary | undefined;
  /** The most relevant session for this branch per the priority order. */
  readonly primarySession: ConsoleSessionSummary | undefined;
  readonly allSessions: readonly ConsoleSessionSummary[];
  /**
   * max(primarySession.lastModifiedMs, worktree.headTimestampMs)
   * Pre-computed here so components never need to recompute it.
   */
  readonly activityMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Priority order for selecting the primary session from a branch's sessions. */
const STATUS_PRIORITY: Record<ConsoleSessionStatus, number> = {
  in_progress: 0,
  dormant: 0,      // treated same as in_progress for placement
  blocked: 1,
  complete_with_gaps: 2,
  complete: 3,
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Selects the most representative session for a WorkspaceItem.
 *
 * Priority: in_progress/dormant (most recently updated) > blocked >
 * complete_with_gaps > most recently modified (any status).
 */
export function selectPrimarySession(
  sessions: readonly ConsoleSessionSummary[],
): ConsoleSessionSummary | undefined {
  if (sessions.length === 0) return undefined;
  return [...sessions].sort((a, b) => {
    const priorityDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (priorityDiff !== 0) return priorityDiff;
    return b.lastModifiedMs - a.lastModifiedMs;
  })[0];
}

/**
 * Determines whether a WorkspaceItem is visible in the current scope.
 *
 * Items are hidden only when they are clean (no uncommitted/unpushed changes),
 * have no active session, and have had no activity in the last 30 days while
 * the scope is 'active'. Everything else is visible.
 */
export function itemVisibility(
  item: WorkspaceItem,
  scope: Scope,
  nowMs: number,
): ItemVisibility {
  const status = item.primarySession?.status;

  // Active sessions are always visible regardless of age or cleanliness
  if (status === 'in_progress' || status === 'dormant' || status === 'blocked') {
    return 'visible';
  }

  // Branches with uncommitted or unpushed work are always visible
  const hasUncommitted = (item.worktree?.changedCount ?? 0) > 0;
  const hasUnpushed = (item.worktree?.aheadCount ?? 0) > 0;
  if (hasUncommitted || hasUnpushed) return 'visible';

  // Within-30-day activity is always visible
  if (nowMs - item.activityMs < THIRTY_DAYS_MS) return 'visible';

  // Old, clean, done -- only hidden in 'active' scope
  return scope === 'all' ? 'visible' : 'hidden';
}

/**
 * Sort priority for a WorkspaceItem within a repo section.
 *
 * Lower number = higher in the list.
 *   0: in_progress  (actively running)
 *   1: blocked      (needs user intervention)
 *   2: dormant      (stalled, incomplete -- distinct from done)
 *   3: uncommitted or unpushed, no active session
 *   4: everything else (complete, complete_with_gaps, no-session recently active)
 *
 * Note: complete_with_gaps is intentionally at priority 4 (same as complete).
 * The gaps badge is surfaced inline on the row -- the sort position does not
 * need to distinguish them.
 */
function sortPriority(item: WorkspaceItem): 0 | 1 | 2 | 3 | 4 {
  const status = item.primarySession?.status;
  switch (status) {
    case 'in_progress': return 0;
    case 'blocked': return 1;
    case 'dormant': return 2;
    default: {
      const hasChanges =
        (item.worktree?.changedCount ?? 0) > 0 ||
        (item.worktree?.aheadCount ?? 0) > 0;
      return hasChanges ? 3 : 4;
    }
  }
}

/**
 * Sorts and filters WorkspaceItems for display within a single repo section.
 *
 * - Filters out items hidden by the current scope (clean+done, >30 days, Active scope)
 * - Sorts by sortPriority then activityMs descending within each priority tier
 * - Returns a new array -- does not mutate the input
 */
export function sortItemsForRepo(
  items: readonly WorkspaceItem[],
  scope: Scope,
  nowMs: number,
): WorkspaceItem[] {
  return [...items]
    .filter((item) => itemVisibility(item, scope, nowMs) === 'visible')
    .sort((a, b) => {
      const priorityDiff = sortPriority(a) - sortPriority(b);
      if (priorityDiff !== 0) return priorityDiff;
      return b.activityMs - a.activityMs;
    });
}

/**
 * Client-side join of sessions and worktrees into WorkspaceItems.
 *
 * - Sessions with repoRoot=null are excluded from the result. They are only
 *   accessible via the global archive link.
 * - Branches that exist only as worktrees (no sessions) are included.
 * - Branches that exist only as sessions (no matching worktree) are included
 *   with worktree=undefined.
 *
 * The join key is `branch + '\0' + repoRoot` to avoid collisions between repos
 * that share branch names.
 */
export function joinSessionsAndWorktrees(
  sessions: readonly ConsoleSessionSummary[],
  worktreeRepos: readonly ConsoleRepoWorktrees[],
): WorkspaceItem[] {
  // Index worktrees by join key for O(1) lookup
  const worktreeByKey = new Map<string, { wt: ConsoleWorktreeSummary; repoName: string }>();
  for (const repo of worktreeRepos) {
    for (const wt of repo.worktrees) {
      if (wt.branch !== null) {
        worktreeByKey.set(`${wt.branch}\0${repo.repoRoot}`, { wt, repoName: repo.repoName });
      }
    }
  }

  // Build a map from any worktree path -> canonical main repo root.
  // Sessions store the worktree path they were started from as repoRoot, but the
  // worktrees API normalizes linked worktrees to the main repo root. Without this
  // map, sessions from linked worktrees would never join with their worktree entry
  // and would appear as separate spurious repos (named after the worktree dir).
  const worktreePathToRepoRoot = new Map<string, string>();
  for (const repo of worktreeRepos) {
    for (const wt of repo.worktrees) {
      worktreePathToRepoRoot.set(wt.path, repo.repoRoot);
    }
  }

  // Group sessions by join key, excluding null-repoRoot sessions.
  // Normalize session repoRoot via worktreePathToRepoRoot so sessions started
  // from a linked worktree collapse to the main repo root.
  const sessionsByKey = new Map<string, ConsoleSessionSummary[]>();
  for (const session of sessions) {
    if (session.repoRoot === null || session.gitBranch === null) continue;
    const normalizedRoot = worktreePathToRepoRoot.get(session.repoRoot) ?? session.repoRoot;
    const key = `${session.gitBranch}\0${normalizedRoot}`;
    const existing = sessionsByKey.get(key);
    if (existing) {
      existing.push(session);
    } else {
      sessionsByKey.set(key, [session]);
    }
  }

  // Build repoName index from sessions for branches without worktrees
  // Use the last segment of repoRoot as a fallback repoName
  const repoNameByRoot = new Map<string, string>();
  for (const repo of worktreeRepos) {
    repoNameByRoot.set(repo.repoRoot, repo.repoName);
  }

  const items: WorkspaceItem[] = [];
  const processedKeys = new Set<string>();

  // Process all branches that have sessions
  for (const [key, branchSessions] of sessionsByKey) {
    const [branch, repoRoot] = key.split('\0') as [string, string];
    const worktreeEntry = worktreeByKey.get(key);
    const primarySession = selectPrimarySession(branchSessions);
    const activityMs = Math.max(
      primarySession?.lastModifiedMs ?? 0,
      worktreeEntry?.wt.headTimestampMs ?? 0,
    );
    const repoName =
      worktreeEntry?.repoName ??
      repoNameByRoot.get(repoRoot) ??
      repoRoot.split('/').at(-1) ??
      repoRoot;

    items.push({
      branch,
      repoRoot,
      repoName,
      worktree: worktreeEntry?.wt,
      primarySession,
      allSessions: branchSessions,
      activityMs,
    });
    processedKeys.add(key);
  }

  // Process worktree-only branches (no sessions recorded yet)
  for (const [key, { wt, repoName }] of worktreeByKey) {
    if (processedKeys.has(key)) continue;
    const [branch, repoRoot] = key.split('\0') as [string, string];
    items.push({
      branch,
      repoRoot,
      repoName,
      worktree: wt,
      primarySession: undefined,
      allSessions: [],
      activityMs: wt.headTimestampMs,
    });
  }

  return items;
}

/**
 * Returns the count of sessions that need attention (blocked or dormant).
 * Used by AlertStrip.
 */
export function countNeedsAttention(items: readonly WorkspaceItem[]): number {
  return items.reduce((count, item) => {
    const status = item.primarySession?.status;
    return status === 'blocked' || status === 'dormant' ? count + 1 : count;
  }, 0);
}

/**
 * Returns the count of sessions that have unresolved gaps across all items.
 */
export function countHasGaps(items: readonly WorkspaceItem[]): number {
  return items.reduce((count, item) => {
    const hasGap = item.allSessions.some((s) => s.hasUnresolvedGaps);
    return hasGap ? count + 1 : count;
  }, 0);
}
