import { useMemo, useState } from 'react';
import { useWorktreeList } from '../api/hooks';
import type { ConsoleWorktreeSummary, ConsoleRepoWorktrees } from '../api/types';

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function relativeTime(epochMs: number): string {
  if (!epochMs) return 'unknown';
  const diffMs = Date.now() - epochMs;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function shortTime(epochMs: number): string {
  if (!epochMs) return '';
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------------
// Worktree card
// ---------------------------------------------------------------------------

function WorktreeCard({
  wt,
  repoRoot,
  onSelectBranch,
}: {
  wt: ConsoleWorktreeSummary;
  repoRoot: string;
  onSelectBranch: (branch: string, repoRoot: string) => void;
}) {
  const isDetached = wt.branch === null;
  const isClean = wt.changedCount === 0;
  const isUpToDate = wt.aheadCount === 0;
  const hasActiveSessions = wt.activeSessionCount > 0;

  const borderColor = hasActiveSessions
    ? 'border-[var(--status-in-progress)]'
    : isDetached
    ? 'border-yellow-500/40'
    : 'border-[var(--border)]';

  const tooltip = isDetached
    ? 'Detached HEAD — not on any branch. Check out a branch to enable session filtering.'
    : `View sessions for ${wt.branch}`;

  return (
    <button
      type="button"
      disabled={isDetached}
      onClick={!isDetached ? () => onSelectBranch(wt.branch!, repoRoot) : undefined}
      title={tooltip}
      className={`w-full text-left rounded-lg border ${borderColor} bg-[var(--bg-secondary)] p-4 flex flex-col gap-2 transition-colors ${!isDetached ? 'cursor-pointer hover:border-[var(--accent)]' : 'cursor-default opacity-80'}`}
    >
      {/* Header row: branch + worktree name */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          {isDetached ? (
            <span className="text-yellow-400 font-mono text-sm font-medium truncate">
              detached · {wt.headHash}
            </span>
          ) : (
            <span className="text-[var(--text-primary)] font-mono text-sm font-medium truncate">
              {wt.branch}
            </span>
          )}
          <span className="text-[var(--text-muted)] text-xs font-mono truncate">
            {wt.name}
          </span>
        </div>

        {/* Active sessions badge */}
        {hasActiveSessions && (
          <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--status-in-progress)]/20 text-[var(--status-in-progress)] border border-[var(--status-in-progress)]/30">
            {wt.activeSessionCount} active
          </span>
        )}
      </div>

      {/* Last commit */}
      <p className="text-[var(--text-secondary)] text-sm leading-snug line-clamp-2">
        {wt.headMessage || <span className="text-[var(--text-muted)] italic">no commit message</span>}
      </p>

      {/* Footer: status badges + time */}
      <div className="flex items-center gap-2 flex-wrap pt-1">
        {isClean ? (
          <span
            title="No uncommitted changes — working tree matches the last commit"
            className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20"
          >
            nothing to commit
          </span>
        ) : (
          <span
            title={`${wt.changedCount} file${wt.changedCount === 1 ? '' : 's'} edited but not yet committed`}
            className="text-xs px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20"
          >
            {wt.changedCount} uncommitted
          </span>
        )}

        {!isUpToDate && (
          <span
            title={`${wt.aheadCount} commit${wt.aheadCount === 1 ? '' : 's'} not yet on main — needs to be pushed or merged`}
            className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20"
          >
            {wt.aheadCount} unpushed
          </span>
        )}

        <span className="text-xs text-[var(--text-muted)] ml-auto">
          {relativeTime(wt.headTimestampMs)}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// WorktreeGrid — receives valid data, all hooks called unconditionally
// ---------------------------------------------------------------------------

/**
 * Renders worktrees grouped into Active / Dirty / Clean sections.
 * The Clean section is collapsed by default to reduce noise — most clean
 * worktrees are done or dormant and don't need immediate attention.
 *
 * Separated from WorktreeList so that all hooks (useMemo, useState) are
 * called unconditionally on every render.
 */
function WorktreeGrid({
  worktrees,
  repoRoot,
  onSelectBranch,
}: {
  worktrees: readonly ConsoleWorktreeSummary[];
  repoRoot: string;
  onSelectBranch: (branch: string, repoRoot: string) => void;
}) {
  const [cleanExpanded, setCleanExpanded] = useState(false);

  const groups = useMemo(() => ({
    activeSessions: worktrees.filter(w => w.activeSessionCount > 0),
    dirty: worktrees.filter(w => w.activeSessionCount === 0 && w.changedCount > 0),
    clean: worktrees.filter(w => w.activeSessionCount === 0 && w.changedCount === 0),
  }), [worktrees]);

  const { activeSessions, dirty, clean } = groups;

  return (
    <div className="flex flex-col gap-4">
      {activeSessions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Active sessions
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeSessions.map(wt => (
              <WorktreeCard key={wt.path} wt={wt} repoRoot={repoRoot} onSelectBranch={onSelectBranch} />
            ))}
          </div>
        </section>
      )}

      {dirty.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Uncommitted changes
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {dirty.map(wt => (
              <WorktreeCard key={wt.path} wt={wt} repoRoot={repoRoot} onSelectBranch={onSelectBranch} />
            ))}
          </div>
        </section>
      )}

      {clean.length > 0 && (
        <section className="flex flex-col gap-1">
          {/* Collapsible header — collapsed by default to reduce noise */}
          <button
            type="button"
            onClick={() => setCleanExpanded(e => !e)}
            className="flex items-center gap-2 text-left group"
          >
            <span className={`text-[var(--text-muted)] text-[10px] transition-transform duration-150 ${cleanExpanded ? 'rotate-90' : ''}`}>
              ▶
            </span>
            <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider group-hover:text-[var(--text-secondary)] transition-colors">
              Clean
            </h4>
            <span className="text-xs text-[var(--text-muted)]">({clean.length})</span>
          </button>
          {cleanExpanded && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-1">
              {clean.map(wt => (
                <WorktreeCard key={wt.path} wt={wt} repoRoot={repoRoot} onSelectBranch={onSelectBranch} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RepoSection — one section per repo
// ---------------------------------------------------------------------------

function RepoSection({
  repo,
  onSelectBranch,
}: {
  repo: ConsoleRepoWorktrees;
  onSelectBranch: (branch: string, repoRoot: string) => void;
}) {
  const activeCount = repo.worktrees.filter(w => w.activeSessionCount > 0).length;
  const dirtyCount = repo.worktrees.filter(w => w.activeSessionCount === 0 && w.changedCount > 0).length;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border-b border-[var(--border)] pb-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] font-mono">
          {repo.repoName}
        </h3>
        <span className="text-xs text-[var(--text-muted)]">{repo.worktrees.length}</span>
        {activeCount > 0 && (
          <span className="text-xs font-medium text-[var(--status-in-progress)]">
            · {activeCount} active
          </span>
        )}
        {dirtyCount > 0 && (
          <span className="text-xs font-medium text-orange-400">
            · {dirtyCount} uncommitted
          </span>
        )}
        <span
          className="text-xs text-[var(--text-muted)] ml-auto font-mono truncate max-w-[240px]"
          title={repo.repoRoot}
        >
          {repo.repoRoot}
        </span>
      </div>

      <WorktreeGrid
        worktrees={repo.worktrees}
        repoRoot={repo.repoRoot}
        onSelectBranch={onSelectBranch}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// WorktreeList — async boundary: loading / error / empty / data
// ---------------------------------------------------------------------------

/**
 * Handles the async boundary for worktree data. Delegates all rendering
 * to RepoSection + WorktreeGrid once data is available so that those
 * components' hooks are always called unconditionally.
 */
export function WorktreeList({
  onSelectBranch,
}: {
  onSelectBranch: (branch: string, repoRoot: string) => void;
}) {
  const { data, isLoading, error, dataUpdatedAt, isFetching } = useWorktreeList();

  if (isLoading) {
    return (
      <div className="text-[var(--text-muted)] text-sm py-12 text-center">
        Loading worktrees…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-400 text-sm py-12 text-center">
        {error instanceof Error ? error.message : 'Failed to load worktrees'}
      </div>
    );
  }

  if (!data || data.repos.length === 0) {
    return (
      <div className="text-[var(--text-muted)] text-sm py-12 text-center">
        No worktrees found. Run{' '}
        <code className="font-mono bg-[var(--bg-tertiary)] px-1 rounded">git worktree list</code>{' '}
        to verify.
      </div>
    );
  }

  const totalWorktrees = data.repos.reduce((n, r) => n + r.worktrees.length, 0);
  const totalActive = data.repos.reduce((n, r) => n + r.worktrees.filter(w => w.activeSessionCount > 0).length, 0);
  const totalDirty = data.repos.reduce((n, r) => n + r.worktrees.filter(w => w.activeSessionCount === 0 && w.changedCount > 0).length, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Global header */}
      <div className="flex items-center justify-between">
        <h2 className="text-[var(--text-primary)] font-semibold flex items-center gap-2 flex-wrap">
          Worktrees
          <span className="text-[var(--text-muted)] font-normal text-sm">{totalWorktrees}</span>
          {totalActive > 0 && (
            <span className="text-xs font-medium text-[var(--status-in-progress)]">
              · {totalActive} active
            </span>
          )}
          {totalDirty > 0 && (
            <span className="text-xs font-medium text-orange-400">
              · {totalDirty} uncommitted
            </span>
          )}
        </h2>
        <span className="text-xs text-[var(--text-muted)]">
          {isFetching
            ? 'refreshing…'
            : dataUpdatedAt
            ? `updated ${shortTime(dataUpdatedAt)}`
            : ''}
        </span>
      </div>

      {/* One section per repo */}
      {data.repos.map(repo => (
        <RepoSection key={repo.repoRoot} repo={repo} onSelectBranch={onSelectBranch} />
      ))}
    </div>
  );
}
