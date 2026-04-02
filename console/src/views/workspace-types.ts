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
 * 'active'  -- has a running, stalled, or blocked workflow (featured card)
 * 'recent'  -- clean or uncommitted-only, touched recently (compact row)
 * 'hidden'  -- clean, done, no activity within 30 days (omitted in Active scope)
 */
export type SectionKind = 'active' | 'recent' | 'hidden';

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
 * Determines which section a WorkspaceItem belongs to.
 *
 * Active  -- has in_progress, dormant, or blocked session
 * Recent  -- uncommitted/unpushed changes OR (clean+done, activity within 30d)
 * Hidden  -- clean, done, no activity within 30 days (omitted in Active scope)
 */
export function sectionFor(
  item: WorkspaceItem,
  scope: Scope,
  nowMs: number,
): SectionKind {
  const status = item.primarySession?.status;
  if (
    status === 'in_progress' ||
    status === 'dormant' ||
    status === 'blocked'
  ) {
    return 'active';
  }

  const hasUncommitted = (item.worktree?.changedCount ?? 0) > 0;
  const hasUnpushed = (item.worktree?.aheadCount ?? 0) > 0;
  if (hasUncommitted || hasUnpushed) {
    return 'recent';
  }

  const isRecent = nowMs - item.activityMs < THIRTY_DAYS_MS;
  if (isRecent) {
    return 'recent';
  }

  // Clean, done, no activity in 30 days
  if (scope === 'all') {
    // In All scope, include everything -- no time cutoff
    return 'recent';
  }
  return 'hidden';
}

/** Numeric sort key for a section: active first, recent second. */
function sectionOrder(section: SectionKind): number {
  switch (section) {
    case 'active': return 0;
    case 'recent': return 1;
    case 'hidden': return 2;
  }
}

/** Numeric sort key for an item within a section. */
function itemSortKey(item: WorkspaceItem): number {
  const status = item.primarySession?.status;
  switch (status) {
    case 'in_progress':
    case 'dormant':
      return 0;
    case 'blocked':
      return 1;
    default: {
      const hasChanges =
        (item.worktree?.changedCount ?? 0) > 0 ||
        (item.worktree?.aheadCount ?? 0) > 0;
      return hasChanges ? 2 : 3;
    }
  }
}

/**
 * Sorts WorkspaceItems by section (active first) then by status group then by
 * activityMs descending (most recently touched first within group).
 *
 * Returns a new array -- does not mutate the input.
 */
export function sortWorkspaceItems(
  items: readonly WorkspaceItem[],
  scope: Scope,
  nowMs: number,
): WorkspaceItem[] {
  return [...items]
    .filter((item) => sectionFor(item, scope, nowMs) !== 'hidden')
    .sort((a, b) => {
      const sectionDiff =
        sectionOrder(sectionFor(a, scope, nowMs)) -
        sectionOrder(sectionFor(b, scope, nowMs));
      if (sectionDiff !== 0) return sectionDiff;

      const keyDiff = itemSortKey(a) - itemSortKey(b);
      if (keyDiff !== 0) return keyDiff;

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

  // Group sessions by join key, excluding null-repoRoot sessions
  const sessionsByKey = new Map<string, ConsoleSessionSummary[]>();
  for (const session of sessions) {
    if (session.repoRoot === null || session.gitBranch === null) continue;
    const key = `${session.gitBranch}\0${session.repoRoot}`;
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
