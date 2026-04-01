import { useWorktreeList } from '../api/hooks';
import type { ConsoleWorktreeSummary } from '../api/types';

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

// ---------------------------------------------------------------------------
// Worktree card
// ---------------------------------------------------------------------------

function WorktreeCard({ wt, onSelectBranch }: { wt: ConsoleWorktreeSummary; onSelectBranch: (branch: string) => void }) {
  const isDetached = wt.branch === null;
  const isClean = wt.changedCount === 0;
  const isUpToDate = wt.aheadCount === 0;
  const hasActiveSessions = wt.activeSessionCount > 0;

  const borderColor = hasActiveSessions
    ? 'border-[var(--status-in-progress)]'
    : isDetached
    ? 'border-yellow-500/40'
    : 'border-[var(--border)]';

  const isClickable = !isDetached;

  return (
    <div
      className={`rounded-lg border ${borderColor} bg-[var(--bg-secondary)] p-4 flex flex-col gap-2 ${isClickable ? 'cursor-pointer hover:border-[var(--accent)] transition-colors' : ''}`}
      onClick={isClickable ? () => onSelectBranch(wt.branch!) : undefined}
      title={isClickable ? `View sessions for ${wt.branch}` : undefined}
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
        {/* Changed files */}
        {isClean ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
            clean
          </span>
        ) : (
          <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20">
            {wt.changedCount} changed
          </span>
        )}

        {/* Ahead of main */}
        {!isUpToDate && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
            {wt.aheadCount} ahead
          </span>
        )}

        {/* Commit time — pushed to right */}
        <span className="text-xs text-[var(--text-muted)] ml-auto">
          {relativeTime(wt.headTimestampMs)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function WorktreeList({ onSelectBranch }: { onSelectBranch: (branch: string) => void }) {
  const { data, isLoading, error } = useWorktreeList();

  if (isLoading) {
    return (
      <div className="text-[var(--text-muted)] text-sm py-12 text-center">
        Loading worktrees…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-red-400 text-sm py-12 text-center">
        {error instanceof Error ? error.message : 'Failed to load worktrees'}
      </div>
    );
  }

  const { worktrees } = data;

  if (worktrees.length === 0) {
    return (
      <div className="text-[var(--text-muted)] text-sm py-12 text-center">
        No worktrees found. Run{' '}
        <code className="font-mono bg-[var(--bg-tertiary)] px-1 rounded">git worktree list</code>{' '}
        to verify.
      </div>
    );
  }

  const activeSessions = worktrees.filter(w => w.activeSessionCount > 0);
  const dirty = worktrees.filter(w => w.activeSessionCount === 0 && w.changedCount > 0);
  const clean = worktrees.filter(w => w.activeSessionCount === 0 && w.changedCount === 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-[var(--text-primary)] font-semibold">
          Worktrees
          <span className="text-[var(--text-muted)] font-normal ml-2 text-sm">
            {worktrees.length}
          </span>
        </h2>
        <span className="text-xs text-[var(--text-muted)]">auto-refreshes every 10s</span>
      </div>

      {activeSessions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Active sessions
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeSessions.map(wt => <WorktreeCard key={wt.path} wt={wt} onSelectBranch={onSelectBranch} />)}
          </div>
        </section>
      )}

      {dirty.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            In progress (dirty)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {dirty.map(wt => <WorktreeCard key={wt.path} wt={wt} onSelectBranch={onSelectBranch} />)}
          </div>
        </section>
      )}

      {clean.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Clean
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {clean.map(wt => <WorktreeCard key={wt.path} wt={wt} onSelectBranch={onSelectBranch} />)}
          </div>
        </section>
      )}
    </div>
  );
}
