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
 * dormant is a first-class status returned by the backend (sessions idle > 1h).
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

  // Actively running or blocked: always visible
  if (status === 'in_progress' || status === 'blocked') {
    return 'visible';
  }

  // Branches with uncommitted or unpushed work are always visible -- the branch
  // has active changes regardless of session status
  const hasUncommitted = (item.worktree?.changedCount ?? 0) > 0;
  const hasUnpushed = (item.worktree?.aheadCount ?? 0) > 0;
  if (hasUncommitted || hasUnpushed) return 'visible';

  // Dormant sessions: visible in All scope only
  if (status === 'dormant') {
    return scope === 'all' ? 'visible' : 'hidden';
  }

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
 * - Sessions without a gitBranch are excluded from the result. They are only
 *   accessible via the global archive link.
 * - Sessions with a gitBranch are matched to worktrees by branch name within
 *   each repo. Sessions with no matching worktree are not shown in the main
 *   workspace view -- they remain accessible via the archive link.
 * - Branches that exist only as worktrees (no sessions) are included.
 *
 * The join key is `branch + '\0' + repoRoot` to avoid collisions between repos
 * that share branch names. repoRoot always comes from the worktrees API.
 */
export function joinSessionsAndWorktrees(
  sessions: readonly ConsoleSessionSummary[],
  worktreeRepos: readonly ConsoleRepoWorktrees[],
): WorkspaceItem[] {
  // Index worktrees by join key for O(1) lookup.
  // repoRoot is always sourced from the worktrees API (not from sessions).
  const worktreeByKey = new Map<string, { wt: ConsoleWorktreeSummary | undefined; repoName: string; repoRoot: string }>();
  for (const repo of worktreeRepos) {
    for (const wt of repo.worktrees) {
      if (wt.branch !== null) {
        worktreeByKey.set(`${wt.branch}\0${repo.repoRoot}`, { wt, repoName: repo.repoName, repoRoot: repo.repoRoot });
      }
    }
  }

  // Build a branch -> worktree entry index for sessions that only know their branch name.
  // When a session's branch matches exactly one worktree entry, use that entry's repoRoot.
  const worktreeByBranch = new Map<string, Array<{ repoRoot: string; repoName: string; wt: ConsoleWorktreeSummary | undefined }>>();
  for (const [key, entry] of worktreeByKey) {
    const [branch] = key.split('\0') as [string, string];
    const existing = worktreeByBranch.get(branch) ?? [];
    existing.push(entry);
    worktreeByBranch.set(branch, existing);
  }

  // Group sessions by join key, excluding sessions without a gitBranch.
  // repoRoot is derived from the worktrees API via branch matching.
  // Sessions whose branch matches no worktree fall back to a synthetic repo
  // using the session's own repoRoot (if available), or are excluded entirely.
  const sessionsByKey = new Map<string, ConsoleSessionSummary[]>();
  for (const session of sessions) {
    if (session.gitBranch === null) continue;
    const entries = worktreeByBranch.get(session.gitBranch) ?? [];

    // Fallback: no matching worktree (API slow/unavailable) -- use session's own repoRoot
    // so sessions stay visible without git badge data rather than disappearing entirely.
    if (entries.length === 0) {
      // Fallback: no worktree match. Sessions with a known repoRoot are grouped
      // under a synthetic repo so they remain visible without git badge data
      // (e.g. when the worktrees API is slow or unavailable).
      // Sessions with no repoRoot have no grouping information and are excluded
      // -- they remain accessible via the archive link.
      if (!session.repoRoot) continue;
      const key = `${session.gitBranch}\0${session.repoRoot}`;
      const existing = sessionsByKey.get(key);
      if (existing) existing.push(session);
      else sessionsByKey.set(key, [session]);
      if (!worktreeByKey.has(key)) {
        const repoName = session.repoRoot.split('/').at(-1) ?? session.repoRoot;
        worktreeByKey.set(key, { wt: undefined, repoName, repoRoot: session.repoRoot });
      }
      continue;
    }

    // When multiple repos share the same branch name, add the session to all of them.
    for (const entry of entries) {
      const key = `${session.gitBranch}\0${entry.repoRoot}`;
      const existing = sessionsByKey.get(key);
      if (existing) {
        existing.push(session);
      } else {
        sessionsByKey.set(key, [session]);
      }
    }
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
      worktreeEntry?.wt?.headTimestampMs ?? 0,
    );
    const repoName = worktreeEntry?.repoName ?? repoRoot.split('/').at(-1) ?? repoRoot;

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
  for (const [key, { wt, repoName, repoRoot }] of worktreeByKey) {
    if (processedKeys.has(key)) continue;
    const [branch] = key.split('\0') as [string, string];
    items.push({
      branch,
      repoRoot,
      repoName,
      worktree: wt,
      primarySession: undefined,
      allSessions: [],
      activityMs: wt?.headTimestampMs ?? 0,
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
    return item.primarySession?.status === 'blocked' ? count + 1 : count;
  }, 0);
}

/**
 * Returns the count of items that have at least one session with unresolved gaps.
 *
 * Not currently consumed by the console UI -- reserved for a future
 * gaps-attention badge or filter. Kept here alongside countNeedsAttention
 * as the canonical aggregation layer for workspace-level attention signals.
 */
export function countHasGaps(items: readonly WorkspaceItem[]): number {
  return items.reduce((count, item) => {
    const hasGap = item.allSessions.some((s) => s.hasUnresolvedGaps);
    return hasGap ? count + 1 : count;
  }, 0);
}

// ---------------------------------------------------------------------------
// RepoGroup -- the display unit for a group of branches under one repo
// ---------------------------------------------------------------------------

export interface RepoGroup {
  readonly repoRoot: string;
  readonly repoName: string;
  readonly sortedItems: readonly WorkspaceItem[];
}

// ---------------------------------------------------------------------------
// buildRepoGroups -- pure use case: join + group + sort for workspace display
// ---------------------------------------------------------------------------

export interface RepoGroupsResult {
  readonly repoGroups: readonly RepoGroup[];
  readonly orderedItems: readonly WorkspaceItem[];
  /**
   * All repos seen in the unfiltered join, used for archive links.
   * Always shows all repos regardless of scope so archive links are stable.
   */
  readonly archiveRepos: ReadonlyArray<readonly [string, string]>;
  /** Count of dormant items hidden from the active scope (no git changes). */
  readonly dormantHiddenCount: number;
}

/**
 * Joins sessions and worktrees, groups by repo, sorts within each group,
 * and returns all derived display data for the workspace view.
 *
 * This is the primary use case that drives WorkspaceView rendering.
 * It calls joinSessionsAndWorktrees and sortItemsForRepo internally.
 *
 * Pure function: same inputs always produce the same outputs.
 */
export function buildRepoGroups(
  sessions: readonly ConsoleSessionSummary[],
  worktreeRepos: readonly ConsoleRepoWorktrees[],
  scope: Scope,
  nowMs: number,
): RepoGroupsResult {
  const joined = joinSessionsAndWorktrees(sessions, worktreeRepos);

  const reposSeen = new Map<string, string>();
  for (const item of joined) {
    if (!reposSeen.has(item.repoRoot)) reposSeen.set(item.repoRoot, item.repoName);
  }

  // Group by repo
  const byRepo = new Map<string, WorkspaceItem[]>();
  for (const item of joined) {
    const existing = byRepo.get(item.repoRoot) ?? [];
    existing.push(item);
    byRepo.set(item.repoRoot, existing);
  }

  // Sort repos: repos with active sessions first, then alphabetical
  const groups: RepoGroup[] = [...byRepo.entries()]
    .map(([repoRoot, items]) => ({
      repoRoot,
      repoName: items[0]!.repoName,
      sortedItems: sortItemsForRepo(items, scope, nowMs),
    }))
    .filter((g) => g.sortedItems.length > 0)
    .sort((a, b) => {
      const aActive = a.sortedItems.some(
        (i) =>
          i.primarySession?.status === 'in_progress' ||
          i.primarySession?.status === 'blocked',
      )
        ? 0
        : 1;
      const bActive = b.sortedItems.some(
        (i) =>
          i.primarySession?.status === 'in_progress' ||
          i.primarySession?.status === 'blocked',
      )
        ? 0
        : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.repoName.localeCompare(b.repoName);
    });

  const orderedItems = groups.flatMap((g) => g.sortedItems);

  // Count items hidden from Active scope because they're dormant (no git changes)
  const dormantHiddenCount =
    scope === 'active'
      ? joined.filter(
          (item) =>
            item.primarySession?.status === 'dormant' &&
            (item.worktree?.changedCount ?? 0) === 0 &&
            (item.worktree?.aheadCount ?? 0) === 0,
        ).length
      : 0;

  return {
    repoGroups: groups,
    orderedItems,
    archiveRepos: [...reposSeen.entries()].map(([root, name]) => [root, name] as const),
    dormantHiddenCount,
  };
}
