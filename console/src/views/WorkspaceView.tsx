import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type RefObject,
} from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { SessionList } from './SessionList';
import type { FileChangeStatus, ChangedFile, ConsoleSessionSummary } from '../api/types';
import { type WorkspaceItem, type Scope, type RepoGroup } from './workspace-types';
import type { UseWorkspaceViewModelResult } from '../hooks/useWorkspaceViewModel';
import type { UseSessionListViewModelResult } from '../hooks/useSessionListViewModel';
import { formatRelativeTime } from '../utils/time';
import { CutCornerBox } from '../components/CutCornerBox';
import { BracketBadge } from '../components/BracketBadge';
import { TreeLine } from '../components/TreeLine';
import { ConsoleCard } from '../components/ConsoleCard';
import { StatusBadge } from '../components/StatusBadge';

// ---------------------------------------------------------------------------
// Rotating content
// ---------------------------------------------------------------------------

interface ActionPrompt {
  readonly workflow: string;
  readonly task: string;
}

const ACTION_PROMPTS: readonly ActionPrompt[] = [
  { workflow: 'coding task workflow', task: 'add a dark mode toggle to the settings page' },
  { workflow: 'coding task workflow', task: 'write tests for the authentication module' },
  { workflow: 'coding task workflow', task: 'refactor the data layer to use a repository pattern' },
  { workflow: 'coding task workflow', task: 'add pagination to the search results view' },
  { workflow: 'bug investigation workflow', task: 'find why the API returns 500 on logout' },
  { workflow: 'bug investigation workflow', task: 'trace why notifications stop sending after 24 hours' },
  { workflow: 'bug investigation workflow', task: 'figure out why the build is failing on CI but not locally' },
  { workflow: 'MR review workflow', task: 'review my latest changes on this branch' },
  { workflow: 'MR review workflow', task: 'review PR #123 before it merges' },
];

// 3 stale tips removed (Worktrees tab reference, Group by Status reference, Sessions tab search reference)
const DISCOVERY_TIPS: readonly string[] = [
  'The DAG view shows every node the agent created, including blocked attempts and alternative paths.',
  'Dormant sessions have been idle for over an hour -- return to the original conversation to resume.',
  'Gaps are open questions the agent flagged but could not resolve. Check them in the node detail panel.',
  'The preferred tip node (highlighted in yellow in the DAG) is the most recent forward position.',
  'Complete with gaps means the workflow finished but left critical follow-ups unresolved.',
  'The tip count badge shows how many execution paths a session explored.',
  'Use j and k to navigate between branches, Enter to expand, and / to open the full session archive.',
];

function pickRandom<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Expand state for a single branch's collapsible panels.
 * Stored in a ref map keyed by `branch + '\0' + repoRoot` so panels survive
 * SSE-driven re-renders that unmount/remount BranchGroup and WorktreeOnlyRow.
 */
interface BranchExpandState {
  filesExpanded: boolean;
  unpushedExpanded: boolean;
}

type ExpandStateMap = Map<string, BranchExpandState>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  /**
   * ViewModel result from useWorkspaceViewModel().
   * WorkspaceView is a pure presentational component -- it does not fetch data.
   */
  readonly viewModel: UseWorkspaceViewModelResult;
  /** ViewModel for the inline archive (SessionList) sub-panel. */
  readonly sessionListViewModel: UseSessionListViewModelResult;
  /**
   * When true, the view is hidden (parent navigated to SessionDetail). Kept
   * mounted so expandStateRef survives SSE-driven remounts of child components.
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// WorkspaceView
// ---------------------------------------------------------------------------

export function WorkspaceView({ viewModel, sessionListViewModel, hidden = false }: Props) {
  const { state, dispatch, scrollYRef, onSelectSession } = viewModel;

  // Expand state for branch panels (changed files, unpushed commits).
  // Kept as a local ref (not in reducer state) so SSE-driven re-renders that
  // unmount/remount BranchGroup and WorktreeOnlyRow do not reset the user's
  // open panels. Keyed by `branch + '\0' + repoRoot`.
  //
  // Invariant: WorkspaceView stays permanently mounted (AppShell renders it
  // with CSS hidden only). If this invariant breaks, expand state is lost.
  const expandStateRef = useRef<ExpandStateMap>(new Map());

  // Scroll restoration: restore captured position when returning from SessionDetail.
  // Skip on first render -- page is already at 0 and there is nothing to restore.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!hidden) {
      const id = requestAnimationFrame(() => {
        window.scrollTo({ top: scrollYRef.current });
      });
      return () => cancelAnimationFrame(id);
    }
  }, [hidden, scrollYRef]);

  // Render based on view state discriminant
  if (state.kind === 'loading') {
    return (
      <div className={`flex items-center justify-center py-32 ${hidden ? 'hidden' : ''}`}>
        <span className="font-mono text-[11px] text-[var(--text-muted)] uppercase tracking-[0.25em] motion-safe:animate-pulse">
          // LOADING WORKSPACE...
        </span>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        className={`p-4 ${hidden ? 'hidden' : ''}`}
        style={{ borderLeft: '3px solid var(--error)' }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--error)] block mb-1">
          // ERROR
        </span>
        <span className="text-sm text-[var(--text-secondary)]">
          Failed to load workspace: {state.message}
        </span>
      </div>
    );
  }

  // state.kind === 'ready'
  const {
    scope,
    focusedIndex,
    archive,
    repoGroups,
    orderedItems,
    archiveRepos,
    dormantHiddenCount,
    worktreesFetching,
    hasAnySessions,
  } = state;

  // Archive view (inline SessionList)
  if (archive !== null) {
    return (
      <div className={`space-y-4 ${hidden ? 'hidden' : ''}`}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => dispatch({ type: 'archive_closed' })}
            className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
          >
            // WORKSPACE &larr;
          </button>
          {archive.repoName && (
            <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)]">
              {archive.repoName}
            </span>
          )}
        </div>
        <SessionList
          viewModel={sessionListViewModel}
        />
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${hidden ? 'hidden' : ''}`}>
      {!hasAnySessions ? (
        <>
          <FullEmptyState prompt={pickRandom(ACTION_PROMPTS)} />
          <TipCard />
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1
                className="font-mono text-2xl font-bold uppercase tracking-[0.12em] leading-none"
                style={{ color: 'var(--accent)', textShadow: '0 0 28px rgba(244,196,48,0.35)' }}
              >
                Workspace
              </h1>
              <p className="font-mono text-[10px] tracking-[0.25em] text-[var(--text-muted)] mt-1.5">
                // {orderedItems.length} session{orderedItems.length !== 1 ? 's' : ''}
              </p>
            </div>
            <ScopeToggle scope={scope} onChange={(s) => dispatch({ type: 'scope_changed', scope: s })} />
          </div>

          {orderedItems.length === 0 ? (
            <p className="font-mono text-[11px] text-[var(--text-muted)] text-center py-8">
              // no sessions match current filter
            </p>
          ) : (
            <div className="space-y-6">
              {repoGroups.map((group, groupIndex) => {
                const groupOffset = repoGroups.slice(0, groupIndex).reduce((sum, g) => sum + g.sortedItems.length, 0);
                return (
                  <RepoSection
                    key={group.repoRoot}
                    group={group}
                    showHeader={true}
                    scope={scope}
                    focusedIndex={focusedIndex}
                    groupOffset={groupOffset}
                    worktreesFetching={worktreesFetching}
                    onSelectSession={onSelectSession}
                    expandStateRef={expandStateRef}
                  />
                );
              })}
            </div>
          )}

          {dormantHiddenCount > 0 && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'scope_changed', scope: 'all' })}
            className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors text-left"
          >
            // {dormantHiddenCount} dormant session{dormantHiddenCount !== 1 ? 's' : ''} hidden — show all
          </button>
        )}

        <ArchiveLinks
          repos={archiveRepos}
          onOpen={(repoName) => dispatch({ type: 'archive_opened', repoName })}
        />
        </>
      )}
      <TipCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RepoSection
// ---------------------------------------------------------------------------

const SECTION_COLLAPSE_THRESHOLD = 12;

function RepoSection({
  group,
  showHeader,
  scope,
  focusedIndex,
  groupOffset,
  worktreesFetching,
  onSelectSession,
  expandStateRef,
}: {
  readonly group: RepoGroup;
  readonly showHeader: boolean;
  readonly scope: Scope;
  readonly focusedIndex: number;
  readonly groupOffset: number;
  readonly worktreesFetching: boolean;
  readonly onSelectSession: (id: string) => void;
  readonly expandStateRef: RefObject<ExpandStateMap>;
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleItems = showAll ? group.sortedItems : group.sortedItems.slice(0, SECTION_COLLAPSE_THRESHOLD);
  const hiddenCount = group.sortedItems.length - SECTION_COLLAPSE_THRESHOLD;

  const activeCount = group.sortedItems.filter(
    i => i.primarySession?.status === 'in_progress' || i.primarySession?.status === 'blocked'
  ).length;

  return (
    <section>
      {showHeader && (
        <div
          style={{ position: 'sticky', top: 'var(--app-header-height)', zIndex: 10 }}
          className="mb-3"
        >
          <div
            className="flex items-center gap-3 px-3 py-2"
            style={{
              background: 'var(--bg-secondary)',
              borderLeft: '3px solid var(--accent)',
              borderBottom: '1px solid rgba(244,196,48,0.15)',
            }}
          >
            <span className="font-mono text-[12px] font-bold uppercase tracking-[0.25em] text-[var(--text-primary)]">
              {group.repoName}
            </span>
            {activeCount > 0 && (
              <BracketBadge
                label={`${activeCount} ACTIVE`}
                color="var(--accent-strong)"
              />
            )}
            <div className="flex-1 h-px" style={{ background: 'rgba(244,196,48,0.12)' }} />
          </div>
        </div>
      )}

      <div className="space-y-3">
        {visibleItems.map((item, idx) => {
          const absoluteIndex = groupOffset + idx;
          const isFocused = focusedIndex === absoluteIndex;

          if (item.allSessions.length === 0) {
            return (
              <WorktreeOnlyRow
                key={`${item.branch}\0${item.repoRoot}`}
                item={item}
                isFocused={isFocused}
                worktreesFetching={worktreesFetching}
                expandStateRef={expandStateRef}
              />
            );
          }

          if (item.allSessions.length > 1) {
            return (
              <BranchGroup
                key={`${item.branch}\0${item.repoRoot}`}
                item={item}
                isFocused={isFocused}
                scope={scope}
                worktreesFetching={worktreesFetching}
                onSelectSession={onSelectSession}
                expandStateRef={expandStateRef}
              />
            );
          }

          // Single-session: branch header + session row connected by left border
          const session = item.allSessions[0]!;
          return (
            <TreeLine key={`${item.branch}\0${item.repoRoot}`} style={isFocused ? { outline: '2px solid var(--accent)', outlineOffset: '2px' } : undefined}>
              <BranchLabel item={item} worktreesFetching={worktreesFetching} filesExpanded={false} onToggleFiles={() => {}} unpushedExpanded={false} onToggleUnpushed={() => {}} />
              <div className="pl-3 mt-px">
                <SessionRow session={session} item={item} showBranch={false} onSelect={() => onSelectSession(session.sessionId)} />
              </div>
            </TreeLine>
          );
        })}

        {!showAll && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full text-left px-3 py-2 font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
          >
            + {hiddenCount} more {hiddenCount === 1 ? 'branch' : 'branches'}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// BranchGroup -- collapsible multi-session branches
// ---------------------------------------------------------------------------

const SESSION_SORT = (a: ConsoleSessionSummary, b: ConsoleSessionSummary) => {
  const priority = (s: ConsoleSessionSummary) =>
    s.status === 'in_progress' || s.status === 'dormant' ? 0 :
    s.status === 'blocked' ? 1 : 2;
  const diff = priority(a) - priority(b);
  if (diff !== 0) return diff;
  return b.lastModifiedMs - a.lastModifiedMs;
};

function BranchGroup({
  item,
  isFocused,
  scope,
  worktreesFetching,
  onSelectSession,
  expandStateRef,
}: {
  readonly item: WorkspaceItem;
  readonly isFocused: boolean;
  readonly scope: Scope;
  readonly worktreesFetching: boolean;
  readonly onSelectSession: (id: string) => void;
  readonly expandStateRef: RefObject<ExpandStateMap>;
}) {
  const expandKey = `${item.branch}\0${item.repoRoot}`;
  const getExpand = () => expandStateRef.current?.get(expandKey) ?? { filesExpanded: false, unpushedExpanded: false };

  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(() => getExpand().filesExpanded);
  const [unpushedExpanded, setUnpushedExpanded] = useState(() => getExpand().unpushedExpanded);
  const sorted = [...item.allSessions].sort(SESSION_SORT);

  const handleToggleFiles = useCallback(() => {
    setFilesExpanded(e => {
      const next = !e;
      const current = expandStateRef.current?.get(expandKey) ?? { filesExpanded: false, unpushedExpanded: false };
      expandStateRef.current?.set(expandKey, { ...current, filesExpanded: next });
      return next;
    });
  }, [expandKey, expandStateRef]);

  const handleToggleUnpushed = useCallback(() => {
    setUnpushedExpanded(e => {
      const next = !e;
      const current = expandStateRef.current?.get(expandKey) ?? { filesExpanded: false, unpushedExpanded: false };
      expandStateRef.current?.set(expandKey, { ...current, unpushedExpanded: next });
      return next;
    });
  }, [expandKey, expandStateRef]);

  // In Active scope, dormant sessions are demoted to history -- they appear
  // behind the "expand history" toggle rather than cluttering the active list.
  // In All scope, dormant sessions stay visible in the active section so the
  // user can see all running/stalled work at once.
  const isDormantVisible = (s: ConsoleSessionSummary) =>
    s.status === 'dormant' && scope === 'all';
  const activeSessions = sorted.filter(s =>
    s.status === 'in_progress' || s.status === 'blocked' || isDormantVisible(s)
  );
  const historySessions = sorted.filter(s =>
    s.status !== 'in_progress' && s.status !== 'blocked' && !isDormantVisible(s)
  );

  return (
    <TreeLine style={isFocused ? { outline: '2px solid var(--accent)', outlineOffset: '2px' } : undefined}>
      <BranchLabel
        item={item}
        worktreesFetching={worktreesFetching}
        filesExpanded={filesExpanded}
        onToggleFiles={handleToggleFiles}
        unpushedExpanded={unpushedExpanded}
        onToggleUnpushed={handleToggleUnpushed}
      />
      {filesExpanded && item.worktree && item.worktree.changedFiles.length > 0 && (
        <ChangedFilesPanel files={item.worktree.changedFiles} />
      )}
      {unpushedExpanded && item.worktree && (
        <UnpushedCommitsPanel commits={item.worktree.unpushedCommits} count={item.worktree.aheadCount} />
      )}
      <div className="pl-3 mt-px space-y-px">
        {activeSessions.map(session => (
          <SessionRow key={session.sessionId} session={session} showBranch={false} onSelect={() => onSelectSession(session.sessionId)} />
        ))}
        {historySessions.length > 0 && (
          <>
            {historyExpanded && historySessions.map(session => (
              <SessionRow key={session.sessionId} session={session} showBranch={false} onSelect={() => onSelectSession(session.sessionId)} />
            ))}
            <button
              type="button"
              onClick={() => setHistoryExpanded(e => !e)}
              className="w-full text-left px-3 py-1.5 font-mono text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              {historyExpanded ? '// hide history' : `+ ${historySessions.length} completed workflow${historySessions.length !== 1 ? 's' : ''}`}
            </button>
          </>
        )}
      </div>
    </TreeLine>
  );
}

// ---------------------------------------------------------------------------
// BranchLabel
// ---------------------------------------------------------------------------

function BranchLabel({
  item,
  worktreesFetching,
  filesExpanded,
  onToggleFiles,
  unpushedExpanded,
  onToggleUnpushed,
}: {
  readonly item: WorkspaceItem;
  readonly worktreesFetching: boolean;
  readonly filesExpanded: boolean;
  readonly onToggleFiles: () => void;
  readonly unpushedExpanded: boolean;
  readonly onToggleUnpushed: () => void;
}) {
  const timeAgo = formatRelativeTime(item.activityMs);
  return (
    <div className="flex items-center gap-2 py-1 pr-3">
      <span className="font-mono text-[11px] font-medium text-[var(--text-secondary)] truncate flex-1">
        {item.branch}
      </span>
      {item.worktree?.isMerged && item.worktree.branch !== null && item.worktree.branch !== 'main' && (
        <MergedBadge />
      )}
      <GitBadges
        item={item}
        fetching={worktreesFetching}
        compact
        filesExpanded={filesExpanded}
        onToggleFiles={onToggleFiles}
        unpushedExpanded={unpushedExpanded}
        onToggleUnpushed={onToggleUnpushed}
      />
      <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">{timeAgo}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionRow -- status-based left border
// ---------------------------------------------------------------------------

function SessionRow({
  session,
  item,
  showBranch = true,
  onSelect,
}: {
  readonly session: ConsoleSessionSummary;
  readonly item?: WorkspaceItem;
  readonly showBranch?: boolean;
  readonly onSelect: () => void;
}) {
  const timeAgo = formatRelativeTime(session.lastModifiedMs);
  const goalTitle = session.sessionTitle?.trim() || session.workflowName || session.workflowId || session.sessionId.slice(0, 8);
  const workflowLabel = session.workflowName ?? session.workflowId ?? null;
  const isDormant = session.status === 'dormant';

  const borderAccent =
    session.status === 'in_progress' ? 'var(--accent-strong)' :
    session.status === 'blocked'     ? 'var(--blocked)' :
    isDormant                        ? 'rgba(244, 196, 48, 0.55)' :
    'rgba(244, 196, 48, 0.15)';

  return (
    <ConsoleCard
      variant="list"
      onClick={onSelect}
      className="px-4 py-3"
      style={{ borderLeft: `3px solid ${borderAccent}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-start gap-2">
          {isDormant && (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0 mt-[3px] bg-[var(--accent)]"
              aria-hidden="true"
              title="Dormant"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors leading-snug line-clamp-1 mb-0.5">
              {goalTitle}
            </p>
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              {showBranch && item && (
                <span className="font-mono text-[10px] text-[var(--text-muted)] truncate max-w-[200px]">
                  {item.branch}
                </span>
              )}
              {workflowLabel && session.sessionTitle && (
                <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">{workflowLabel}</span>
              )}
              {showBranch && item?.worktree && (
                <GitBadges item={item} fetching={false} compact />
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {session.hasUnresolvedGaps && (
            <span className="text-[10px] text-[var(--warning)]" title="Unresolved gaps">&#x26A0;</span>
          )}
          <StatusBadge status={session.status} />
          <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">{timeAgo}</span>
        </div>
      </div>
    </ConsoleCard>
  );
}

// ---------------------------------------------------------------------------
// Worktree-only row -- branch with no sessions, just git state
// ---------------------------------------------------------------------------

function WorktreeOnlyRow({
  item,
  isFocused,
  worktreesFetching,
  expandStateRef,
}: {
  readonly item: WorkspaceItem;
  readonly isFocused: boolean;
  readonly worktreesFetching: boolean;
  readonly expandStateRef: RefObject<ExpandStateMap>;
}) {
  const expandKey = `${item.branch}\0${item.repoRoot}`;

  const getExpand = (): BranchExpandState =>
    expandStateRef.current?.get(expandKey) ?? { filesExpanded: false, unpushedExpanded: false };

  const [filesExpanded, setFilesExpanded] = useState(() => getExpand().filesExpanded);
  const [unpushedExpanded, setUnpushedExpanded] = useState(() => getExpand().unpushedExpanded);
  const [animateRef] = useAutoAnimate<HTMLDivElement>();
  const timeAgo = formatRelativeTime(item.activityMs);

  const handleToggleFiles = useCallback(() => {
    setFilesExpanded((e) => {
      const next = !e;
      const current = expandStateRef.current?.get(expandKey) ?? { filesExpanded: false, unpushedExpanded: false };
      expandStateRef.current?.set(expandKey, { ...current, filesExpanded: next });
      return next;
    });
  }, [expandKey, expandStateRef]);

  const handleToggleUnpushed = useCallback(() => {
    setUnpushedExpanded((e) => {
      const next = !e;
      const current = expandStateRef.current?.get(expandKey) ?? { filesExpanded: false, unpushedExpanded: false };
      expandStateRef.current?.set(expandKey, { ...current, unpushedExpanded: next });
      return next;
    });
  }, [expandKey, expandStateRef]);

  return (
    // Outer wrapper enables the file panel to be a sibling of the flex row.
    // The isFocused ring stays on the inner flex row so it does not wrap the panel.
    <div ref={animateRef}>
      <div
        className={`flex items-center gap-3 px-3 py-2 rounded ${isFocused ? 'ring-2 ring-[var(--accent)] ring-offset-1' : ''}`}
      >
        <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--border)]" title="No sessions" />
        <span className="font-mono text-xs text-[var(--text-muted)] truncate flex-1">
          {item.branch}
        </span>
        {item.worktree?.isMerged && item.worktree.branch !== null && item.worktree.branch !== 'main' && (
          <MergedBadge />
        )}
        <GitBadges
          item={item}
          fetching={worktreesFetching}
          compact
          filesExpanded={filesExpanded}
          onToggleFiles={handleToggleFiles}
          unpushedExpanded={unpushedExpanded}
          onToggleUnpushed={handleToggleUnpushed}
        />
        {item.worktree?.headMessage && (
          <span className="text-[10px] text-[var(--text-muted)] truncate hidden sm:block max-w-[200px] opacity-60">
            {item.worktree.headMessage}
          </span>
        )}
        <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">{timeAgo}</span>
      </div>
      {filesExpanded && item.worktree && item.worktree.changedFiles.length > 0 && (
        <ChangedFilesPanel files={item.worktree.changedFiles} />
      )}
      {unpushedExpanded && item.worktree && (
        <UnpushedCommitsPanel
          commits={item.worktree.unpushedCommits}
          count={item.worktree.aheadCount}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git badges
// ---------------------------------------------------------------------------

function GitBadges({
  item,
  fetching,
  compact = false,
  filesExpanded,
  onToggleFiles,
  unpushedExpanded,
  onToggleUnpushed,
}: {
  readonly item: WorkspaceItem;
  readonly fetching: boolean;
  readonly compact?: boolean;
  /** When provided, the uncommitted badge becomes a toggle button. */
  readonly filesExpanded?: boolean;
  readonly onToggleFiles?: () => void;
  /** When provided, the unpushed badge becomes a toggle button. */
  readonly unpushedExpanded?: boolean;
  readonly onToggleUnpushed?: () => void;
}) {
  if (fetching && item.worktree === undefined || item.worktree?.enrichment === null) {
    // Show skeleton shimmer in two cases:
    // 1. Worktree data hasn't arrived yet (fetching + no worktree)
    // 2. Fast path returned but background enrichment is still pending (enrichment: null)
    //    -- this fires even when fetching=false since enrichment is independent of the fetch flag.
    return (
      <span className="flex gap-1">
        <SkeletonBadge />
      </span>
    );
  }

  const wt = item.worktree;
  if (!wt) return null;

  const changedCount = wt.changedCount;
  const aheadCount = wt.aheadCount;

  if (changedCount === 0 && aheadCount === 0) {
    // Nothing to show -- absence of badges already communicates "clean"
    return null;
  }

  const badgeClass = `text-xs px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20 tabular-nums${compact ? ' text-[10px]' : ''}`;

  return (
    <span className="flex items-center gap-1">
      {changedCount > 0 && (
        onToggleFiles ? (
          // Clickable toggle: badge becomes a button that expands the file list panel.
          // aria-expanded signals current state to screen readers.
          <button
            type="button"
            aria-expanded={filesExpanded ?? false}
            aria-label={`Show ${changedCount} uncommitted file${changedCount === 1 ? '' : 's'}`}
            title={`${changedCount} file${changedCount === 1 ? '' : 's'} edited but not yet committed — click to expand`}
            onClick={onToggleFiles}
            className={`${badgeClass} cursor-pointer hover:bg-orange-500/20 transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1${filesExpanded ? ' ring-1 ring-orange-500/40' : ''}`}
          >
            {changedCount} uncommitted
          </button>
        ) : (
          <span
            title={`${changedCount} file${changedCount === 1 ? '' : 's'} edited but not yet committed`}
            className={badgeClass}
          >
            {changedCount} uncommitted
          </span>
        )
      )}
      {aheadCount > 0 && (
        onToggleUnpushed ? (
          // Clickable toggle: badge becomes a button that expands the unpushed commits panel.
          <button
            type="button"
            aria-expanded={unpushedExpanded ?? false}
            aria-label={`Show ${aheadCount} unpushed commit${aheadCount === 1 ? '' : 's'}`}
            title={`${aheadCount} commit${aheadCount === 1 ? '' : 's'} not yet pushed -- click to expand`}
            onClick={onToggleUnpushed}
            className={`text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 cursor-pointer hover:bg-blue-500/20 transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 tabular-nums${compact ? ' text-[10px]' : ''}${unpushedExpanded ? ' ring-1 ring-blue-500/40' : ''}`}
          >
            {aheadCount} unpushed
          </button>
        ) : (
          <span
            title={`${aheadCount} commit${aheadCount === 1 ? '' : 's'} not yet pushed`}
            className={`text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 tabular-nums${compact ? ' text-[10px]' : ''}`}
          >
            {aheadCount} unpushed
          </span>
        )
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Changed files panel -- expanded inline file list for uncommitted changes
// ---------------------------------------------------------------------------

/**
 * Maps FileChangeStatus to a CSS color value for the status indicator dot.
 *
 * untracked and other use #a0a0a0 (text-secondary equivalent) rather than
 * text-muted (#666) to meet contrast requirements.
 */
const FILE_STATUS_COLOR: Record<FileChangeStatus, string> = {
  modified: 'var(--warning)',
  added: 'var(--success)',
  deleted: 'var(--error)',
  untracked: '#a0a0a0',
  renamed: 'var(--accent)',
  other: '#a0a0a0',
};

const FILE_STATUS_LABEL: Record<FileChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: '?',
  renamed: 'R',
  other: '~',
};

function ChangedFilesPanel({ files }: { readonly files: readonly ChangedFile[] }) {
  return (
    <div className="mx-3 mb-1 max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-card)]">
      {files.map((file, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-0.5 hover:bg-[var(--bg-tertiary)]">
          <span
            className="text-[10px] font-mono font-semibold w-3 shrink-0 tabular-nums"
            style={{ color: FILE_STATUS_COLOR[file.status] }}
            title={file.status}
          >
            {FILE_STATUS_LABEL[file.status]}
          </span>
          <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate">
            {file.path}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unpushed commits panel -- expanded inline commit list for unpushed commits
// ---------------------------------------------------------------------------

function UnpushedCommitsPanel({
  commits,
  count,
}: {
  readonly commits: readonly { hash: string; message: string }[];
  readonly count?: number;
}) {
  if (commits.length === 0) {
    return (
      <div className="mx-3 mb-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-card)]">
        <span className="text-[11px] text-[var(--text-muted)] italic">
          {count !== undefined && count > 0
            ? `${count} commit${count === 1 ? '' : 's'} ahead -- details unavailable`
            : 'No unpushed commits'}
        </span>
      </div>
    );
  }
  return (
    <div className="mx-3 mb-1 max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-card)]">
      {commits.map((commit, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-0.5 hover:bg-[var(--bg-tertiary)]">
          <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0 tabular-nums w-14">
            {commit.hash}
          </span>
          <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate">
            {commit.message}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merged badge
// ---------------------------------------------------------------------------

function MergedBadge() {
  return (
    <span
      title="Merged into main"
      className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 shrink-0"
    >
      merged
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skeleton badge
// ---------------------------------------------------------------------------

function SkeletonBadge() {
  return (
    <span className="inline-block h-5 w-20 rounded bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
  );
}

// ---------------------------------------------------------------------------
// Scope toggle
// ---------------------------------------------------------------------------

function ScopeToggle({
  scope,
  onChange,
}: {
  readonly scope: Scope;
  readonly onChange: (scope: Scope) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {(['active', 'all'] as Scope[]).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`font-mono text-[10px] uppercase tracking-[0.20em] px-2.5 py-1 transition-colors capitalize ${
            scope === s
              ? 'border border-[var(--accent)] text-[var(--accent)] bg-transparent'
              : 'border border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          {s === 'active' ? 'Active' : 'All'}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Archive links
// ---------------------------------------------------------------------------

function ArchiveLinks({
  repos,
  onOpen,
}: {
  // Pre-computed from the unfiltered join so all repos are always shown
  // regardless of scope.
  readonly repos: ReadonlyArray<readonly [string, string]>;
  readonly onOpen: (repoName: string | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-[var(--border)]">
      {repos.map(([repoRoot, repoName]) => (
        <button
          key={repoRoot}
          type="button"
          onClick={() => onOpen(repoName)}
          className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors text-left"
        >
          // SESSION ARCHIVE &rarr;
        </button>
      ))}
      {repos.length > 1 && (
        <button
          type="button"
          onClick={() => onOpen(undefined)}
          className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors text-left"
        >
          // ALL SESSIONS &rarr;
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full empty state (no sessions at all)
// ---------------------------------------------------------------------------

function FullEmptyState({ prompt }: { readonly prompt: ActionPrompt }) {
  return (
    <div className="flex flex-col items-center gap-8 py-20 text-center">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.30em] text-[var(--text-muted)] mb-3">
          // WORKSPACE READY
        </p>
        <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3">
          Ready when you are
        </h2>
        <p className="text-sm text-[var(--text-muted)] max-w-sm leading-relaxed">
          Sessions appear here when your agent runs a workflow. Start one by telling your agent:
        </p>
      </div>

      <div className="relative h-[100px] max-w-lg w-full">
        <CutCornerBox
          cut={12}
          borderColor="var(--border)"
          background="var(--bg-card)"
          className="absolute inset-0"
        >
          <div className="px-6 py-5 text-left">
            <p className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] mb-2">
              Try this prompt
            </p>
            <p className="text-[var(--text-primary)] text-sm leading-relaxed">
              "Use the{' '}
              <span className="text-[var(--accent)] font-medium">{prompt.workflow}</span>
              {' '}to {prompt.task}"
            </p>
          </div>
        </CutCornerBox>
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)]">
        // {ACTION_PROMPTS.length} PROMPTS AVAILABLE
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tip card with 60s rotation and fade transition
// ---------------------------------------------------------------------------

function TipCard() {
  const [tipIndex, setTipIndex] = useState(() =>
    Math.floor(Math.random() * DISCOVERY_TIPS.length),
  );
  const [fading, setFading] = useState(false);

  useEffect(() => {
    // Track the fade timeout so it can be cancelled if the component unmounts
    // mid-fade. setInterval ignores return values so the timeout must be tracked
    // outside the callback.
    let fadeTimeout: ReturnType<typeof setTimeout> | null = null;

    const interval = setInterval(() => {
      setFading(true);
      fadeTimeout = setTimeout(() => {
        setTipIndex((prev) => (prev + 1) % DISCOVERY_TIPS.length);
        setFading(false);
        fadeTimeout = null;
      }, 300);
    }, 60_000);

    return () => {
      clearInterval(interval);
      if (fadeTimeout !== null) clearTimeout(fadeTimeout);
    };
  }, []);

  return (
    <div
      className="flex items-start gap-3 border border-[var(--border)] px-4 py-3"
      style={{ borderLeft: '3px solid rgba(244, 196, 48, 0.4)' }}
    >
      <div style={{ opacity: fading ? 0 : 1, transition: 'opacity 300ms' }}>
        <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--accent)]">
          // TIP
        </span>
        <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">
          {DISCOVERY_TIPS[tipIndex]}
        </p>
      </div>
    </div>
  );
}

// build-1775224304
