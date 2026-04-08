import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  type RefObject,
} from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useNavigate } from '@tanstack/react-router';
import { useSessionList, useWorktreeList, useWorkspaceEvents } from '../api/hooks';
import { SessionList } from './SessionList';
import type { FileChangeStatus, ChangedFile } from '../api/types';
import {
  type WorkspaceItem,
  type Scope,
  joinSessionsAndWorktrees,
  sortItemsForRepo,
} from './workspace-types';
import { formatRelativeTime } from '../utils/time';
import { CutCornerBox } from '../components/CutCornerBox';
import { BracketBadge } from '../components/BracketBadge';
import { SectionHeader } from '../components/SectionHeader';
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
  'Dormant sessions have been idle for 3 days -- return to the original conversation to resume.',
  'Gaps are open questions the agent flagged but could not resolve. Check them in the node detail panel.',
  'The preferred tip node (highlighted in yellow in the DAG) is the most recent forward position.',
  'Complete with gaps means the workflow finished but left critical follow-ups unresolved.',
  'The tip count badge shows how many execution paths a session explored.',
  'Use j and k to navigate between branches, Enter to expand, and / to open the full session archive.',
];

function pickRandom<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Archive state
// ---------------------------------------------------------------------------

interface ArchiveState {
  readonly repoName: string | undefined;
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
// Band type
// ---------------------------------------------------------------------------

type Band = 'live' | 'attention' | 'recent';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  /** When true, the view is hidden (parent navigated to SessionDetail). Kept
   * mounted so state is preserved for scroll restoration on back-nav. */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// WorkspaceView
// ---------------------------------------------------------------------------

export function WorkspaceView({ hidden = false }: Props) {
  const navigate = useNavigate();
  const { data: sessionData, isLoading: sessionsLoading, error: sessionsError, refetch } = useSessionList();
  const { data: worktreeData, isFetching: worktreesFetching } = useWorktreeList();
  // Subscribe to server-sent events -- triggers immediate refetch when sessions change
  useWorkspaceEvents();

  const [scope, setScope] = useState<Scope>('active');
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [archive, setArchive] = useState<ArchiveState | null>(null);

  // Scroll restoration: capture scroll position before navigating to SessionDetail,
  // restore on return. Sessions are always visible so no accordion key to restore.
  const scrollYRef = useRef<number>(0);
  const isFirstRender = useRef(true);

  // Expand state for branch panels (changed files, unpushed commits).
  // Hoisted here so SSE-driven re-renders that unmount/remount BranchGroup and
  // WorktreeOnlyRow do not reset the user's open panels. Keyed by
  // `branch + '\0' + repoRoot` -- same composite key used by the join.
  const expandStateRef = useRef<ExpandStateMap>(new Map());

  const wrappedSelectSession = useCallback(
    (sessionId: string) => {
      scrollYRef.current = window.scrollY;
      navigate({ to: '/session/$sessionId', params: { sessionId } });
    },
    [navigate],
  );

  // Restore scroll position when returning from SessionDetail.
  // Skip on first mount -- page is already at 0 and there is nothing to restore.
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
  }, [hidden]);

  const { liveItems, attentionItems, recentItems, orderedItems, archiveRepos } = useMemo(() => {
    const nowMs = Date.now();
    const empty = {
      liveItems: [] as WorkspaceItem[],
      attentionItems: [] as WorkspaceItem[],
      recentItems: [] as WorkspaceItem[],
      orderedItems: [] as WorkspaceItem[],
      archiveRepos: [] as Array<[string, string]>,
    };
    if (!sessionData) return empty;

    const worktreeRepos = worktreeData?.repos ?? [];
    const joined = joinSessionsAndWorktrees(sessionData.sessions, worktreeRepos);

    const reposSeen = new Map<string, string>();
    for (const item of joined) {
      if (!reposSeen.has(item.repoRoot)) reposSeen.set(item.repoRoot, item.repoName);
    }

    const allSorted = sortItemsForRepo(joined, scope, nowMs);
    const live = allSorted.filter(i => i.primarySession?.status === 'in_progress');
    const attention = allSorted.filter(i => i.primarySession?.status === 'blocked');
    const recent = allSorted.filter(i => {
      const s = i.primarySession?.status;
      return s !== 'in_progress' && s !== 'blocked';
    });

    return {
      liveItems: live,
      attentionItems: attention,
      recentItems: recent,
      orderedItems: [...live, ...attention, ...recent],
      archiveRepos: [...reposSeen.entries()] as Array<[string, string]>,
    };
  }, [sessionData, worktreeData, scope]);

  // Reset keyboard focus when the item list changes length (e.g. after scope toggle).
  // Prevents focusedIndex pointing to a different item than the user expects.
  useEffect(() => {
    setFocusedIndex(-1);
  }, [orderedItems.length]);

  // Keyboard navigation -- disabled while hidden (e.g. SessionDetail overlaid on top)
  useWorkspaceKeyboard({
    items: orderedItems,
    focusedIndex,
    setFocusedIndex,
    onSelectSession: wrappedSelectSession,
    scope,
    setScope,
    refetch,
    archive,
    setArchive,
    disabled: hidden,
  });

  const hasAnySessions = (sessionData?.totalCount ?? 0) > 0;

  if (sessionsLoading) {
    return (
      <div className={`flex items-center justify-center py-32 ${hidden ? 'hidden' : ''}`}>
        <span className="font-mono text-[11px] text-[var(--text-muted)] uppercase tracking-[0.25em] animate-pulse">
          // LOADING WORKSPACE...
        </span>
      </div>
    );
  }

  if (sessionsError) {
    return (
      <div
        className={`p-4 ${hidden ? 'hidden' : ''}`}
        style={{ borderLeft: '3px solid var(--error)' }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--error)] block mb-1">
          // ERROR
        </span>
        <span className="text-sm text-[var(--text-secondary)]">
          Failed to load workspace: {sessionsError.message}
        </span>
      </div>
    );
  }

  // Archive view (inline SessionList)
  if (archive !== null) {
    return (
      <div className={`space-y-4 ${hidden ? 'hidden' : ''}`}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setArchive(null)}
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
          onSelectSession={wrappedSelectSession}
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
          {/* Page header: SectionHeader left + ScopeToggle right */}
          <div className="flex items-center justify-between">
            <SectionHeader label="Workspace" count={orderedItems.length} countLabel="session" showRule={false} />
            <ScopeToggle scope={scope} onChange={setScope} />
          </div>

          {orderedItems.length === 0 ? (
            <p className="font-mono text-[11px] text-[var(--text-muted)] text-center py-8">
              // no sessions match current filter
            </p>
          ) : (
            <>
              {/* LIVE OPERATIONS band */}
              {liveItems.length > 0 && (
                <section aria-label="Live operations">
                  <SectionHeader label="Live Operations" count={liveItems.length} countLabel="session" />
                  <LiveBand
                    items={liveItems}
                    focusedOffset={0}
                    focusedIndex={focusedIndex}
                    worktreesFetching={worktreesFetching}
                    onSelectSession={wrappedSelectSession}
                    expandStateRef={expandStateRef}
                  />
                </section>
              )}

              {/* NEEDS ATTENTION band */}
              {attentionItems.length > 0 && (
                <section aria-label="Needs attention">
                  <SectionHeader label="Needs Attention" count={attentionItems.length} countLabel="session" />
                  <div className="space-y-1">
                    {attentionItems.map((item, idx) => (
                      <BandSessionRow
                        key={`${item.branch}\0${item.repoRoot}`}
                        item={item}
                        band="attention"
                        isFocused={focusedIndex === liveItems.length + idx}
                        worktreesFetching={worktreesFetching}
                        onSelectSession={wrappedSelectSession}
                        expandStateRef={expandStateRef}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* RECENT band */}
              {recentItems.length > 0 && (
                <section aria-label="Recent sessions">
                  <SectionHeader label="Recent" count={recentItems.length} countLabel="session" />
                  <div className="space-y-1">
                    {recentItems.map((item, idx) => (
                      <BandSessionRow
                        key={`${item.branch}\0${item.repoRoot}`}
                        item={item}
                        band="recent"
                        isFocused={focusedIndex === liveItems.length + attentionItems.length + idx}
                        worktreesFetching={worktreesFetching}
                        onSelectSession={wrappedSelectSession}
                        expandStateRef={expandStateRef}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          <ArchiveLinks repos={archiveRepos} onOpen={(repoName) => setArchive({ repoName })} />
        </>
      )}
      <TipCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeroSessionCard -- for in_progress items in the LIVE band
// ---------------------------------------------------------------------------

function HeroSessionCard({
  item,
  isFocused,
  onSelect,
}: {
  readonly item: WorkspaceItem;
  readonly isFocused: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const session = item.primarySession!;
  const timeAgo = formatRelativeTime(session.lastModifiedMs);
  const workflowLabel = session.workflowName ?? session.workflowId ?? null;
  const goalTitle = session.sessionTitle?.trim() || workflowLabel || session.sessionId.slice(0, 8);

  return (
    <button
      type="button"
      onClick={() => onSelect(session.sessionId)}
      className="relative block w-full text-left h-[120px] group"
      style={isFocused ? { outline: '2px solid var(--accent)', outlineOffset: '2px' } : undefined}
      aria-label={goalTitle}
    >
      <CutCornerBox
        cut={16}
        borderColor="rgba(0, 219, 233, 0.45)"
        background="rgba(15, 19, 31, 0.9)"
        dropShadow="drop-shadow(0 0 20px rgba(0, 219, 233, 0.12))"
        className="absolute inset-0"
      >
        <div className="p-4 flex flex-col h-full">
          {/* Row 1: LIVE badge + time ago */}
          <div className="flex items-center justify-between mb-2">
            <BracketBadge
              label="LIVE"
              color="var(--accent-strong)"
              pulse={true}
            />
            <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
              {timeAgo}
            </span>
          </div>

          {/* Row 2: goal title */}
          <p className="text-sm text-[var(--text-primary)] group-hover:text-[var(--accent-strong)] transition-colors line-clamp-2 flex-1">
            {goalTitle}
          </p>

          {/* Row 3: branch + workflow + gaps */}
          <div className="flex items-center gap-2 mt-auto min-w-0">
            <span className="font-mono text-[10px] text-[var(--text-muted)] truncate flex-1">
              {item.branch}
            </span>
            {workflowLabel && workflowLabel !== goalTitle && (
              <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0 truncate max-w-[120px]">
                {workflowLabel}
              </span>
            )}
            {session.hasUnresolvedGaps && (
              <span title="Unresolved gaps" className="text-[10px] text-[var(--warning)] shrink-0">&#x26A0;</span>
            )}
          </div>
        </div>
      </CutCornerBox>
    </button>
  );
}

// ---------------------------------------------------------------------------
// LiveBand -- hero grid + overflow disclosure
// ---------------------------------------------------------------------------

const HERO_CAP = 3;

function LiveBand({
  items,
  focusedOffset,
  focusedIndex,
  worktreesFetching,
  onSelectSession,
  expandStateRef,
}: {
  readonly items: readonly WorkspaceItem[];
  readonly focusedOffset: number;
  readonly focusedIndex: number;
  readonly worktreesFetching: boolean;
  readonly onSelectSession: (id: string) => void;
  readonly expandStateRef: RefObject<ExpandStateMap>;
}) {
  const [showOverflow, setShowOverflow] = useState(false);
  const heroItems = items.slice(0, HERO_CAP);
  const overflowItems = items.slice(HERO_CAP);

  return (
    <div className="space-y-3">
      {/* Hero grid: 1-col if single item, 2-col otherwise */}
      <div className={`grid gap-3 ${heroItems.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {heroItems.map((item, idx) => (
          <HeroSessionCard
            key={`${item.branch}\0${item.repoRoot}`}
            item={item}
            isFocused={focusedIndex === focusedOffset + idx}
            onSelect={onSelectSession}
          />
        ))}
      </div>

      {/* Overflow disclosure */}
      {overflowItems.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowOverflow(s => !s)}
            className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors mb-2"
          >
            {showOverflow
              ? '// COLLAPSE'
              : `+ ${overflowItems.length} MORE RUNNING`}
          </button>
          {showOverflow && (
            <div className="space-y-1">
              {overflowItems.map((item, idx) => (
                <BandSessionRow
                  key={`${item.branch}\0${item.repoRoot}`}
                  item={item}
                  band="live"
                  isFocused={focusedIndex === focusedOffset + HERO_CAP + idx}
                  worktreesFetching={worktreesFetching}
                  onSelectSession={onSelectSession}
                  expandStateRef={expandStateRef}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BandSessionRow -- replaces SessionRow, uses ConsoleCard variant="list"
// ---------------------------------------------------------------------------

function BandSessionRow({
  item,
  band,
  isFocused,
  worktreesFetching,
  onSelectSession,
  expandStateRef,
}: {
  readonly item: WorkspaceItem;
  readonly band: Band;
  readonly isFocused: boolean;
  readonly worktreesFetching: boolean;
  readonly onSelectSession: (id: string) => void;
  readonly expandStateRef: RefObject<ExpandStateMap>;
}) {
  // Worktree-only items (no sessions): delegate to WorktreeOnlyRow
  if (item.allSessions.length === 0) {
    return (
      <WorktreeOnlyRow
        item={item}
        isFocused={isFocused}
        worktreesFetching={worktreesFetching}
        expandStateRef={expandStateRef}
      />
    );
  }

  const session = item.primarySession!;
  const workflowLabel = session.workflowName ?? session.workflowId ?? null;
  const goalTitle = session.sessionTitle?.trim() || workflowLabel || session.sessionId.slice(0, 8);
  const timeAgo = formatRelativeTime(session.lastModifiedMs);
  const multiSessionCount = item.allSessions.length;

  const borderAccent =
    band === 'attention' ? 'var(--blocked)' :
    band === 'live' ? 'var(--accent-strong)' :
    'rgba(244, 196, 48, 0.2)';

  return (
    <div style={isFocused ? { outline: '2px solid var(--accent)', outlineOffset: '2px' } : undefined}>
      <ConsoleCard
        variant="list"
        onClick={() => onSelectSession(session.sessionId)}
        className="px-4 py-3"
        style={{ borderLeft: `3px solid ${borderAccent}` }}
        aria-label={goalTitle}
      >
        {/* Row 1: goal title | gaps | +N badge | StatusBadge | time ago */}
        <div className="flex items-center gap-2 min-w-0 mb-1">
          <span className="text-sm text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors flex-1 truncate">
            {goalTitle}
          </span>
          {session.hasUnresolvedGaps && (
            <span title="Unresolved gaps" className="text-[10px] text-[var(--warning)] shrink-0">&#x26A0;</span>
          )}
          {multiSessionCount > 1 && (
            <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0 tabular-nums">
              +{multiSessionCount - 1}
            </span>
          )}
          <StatusBadge status={session.status} />
          <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
            {timeAgo}
          </span>
        </div>

        {/* Row 2: branch | workflow label | GitBadges | MergedBadge */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] text-[var(--text-muted)] truncate flex-1">
            {item.branch}
          </span>
          {workflowLabel && workflowLabel !== goalTitle && (
            <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0 truncate max-w-[120px]">
              {workflowLabel}
            </span>
          )}
          <GitBadges item={item} fetching={worktreesFetching} compact />
          {item.worktree?.isMerged && item.worktree.branch !== null && item.worktree.branch !== 'main' && (
            <MergedBadge />
          )}
        </div>
      </ConsoleCard>
    </div>
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
  if (fetching && item.worktree === undefined) {
    // Show skeleton shimmer while worktree data loads
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
    <span className="inline-block h-5 w-20 rounded bg-[var(--bg-tertiary)] animate-pulse" />
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
          // ALL {repoName.toUpperCase()} &rarr;
        </button>
      ))}
      {repos.length !== 1 && (
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

// ---------------------------------------------------------------------------
// Keyboard navigation hook
// ---------------------------------------------------------------------------

interface KeyboardOptions {
  readonly items: readonly WorkspaceItem[];
  readonly focusedIndex: number;
  readonly setFocusedIndex: (i: number) => void;
  /** Called when Enter/Space is pressed on a focused item -- navigates to session detail */
  readonly onSelectSession: (sessionId: string) => void;
  readonly scope: Scope;
  readonly setScope: (scope: Scope) => void;
  readonly refetch: () => void;
  readonly archive: ArchiveState | null;
  readonly setArchive: (state: ArchiveState | null) => void;
  readonly disabled: boolean;
}

function useWorkspaceKeyboard({
  items,
  focusedIndex,
  setFocusedIndex,
  onSelectSession,
  scope,
  setScope,
  refetch,
  archive,
  setArchive,
  disabled,
}: KeyboardOptions) {
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const onSelectSessionRef = useRef(onSelectSession);
  onSelectSessionRef.current = onSelectSession;

  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;

  const archiveRef = useRef(archive);
  archiveRef.current = archive;

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // (no expandedKeyRef -- sessions are always visible, no accordion state)

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip when the workspace view is hidden behind SessionDetail
      if (disabledRef.current) return;

      // Skip when modifier keys are held -- let browser shortcuts like Cmd+R pass through
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Skip if focus is inside an input or textarea (avoid interfering with typing)
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
      ) {
        return;
      }

      // Close archive on Escape
      if (e.key === 'Escape' && archiveRef.current !== null) {
        setArchive(null);
        return;
      }

      const items = itemsRef.current;
      const focusedIndex = focusedIndexRef.current;

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          const next = Math.min(focusedIndex + 1, items.length - 1);
          setFocusedIndex(next);
          break;
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          const prev = Math.max(focusedIndex - 1, 0);
          setFocusedIndex(prev);
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < items.length) {
            const item = items[focusedIndex];
            const sessionId = item.primarySession?.sessionId;
            if (sessionId) {
              onSelectSessionRef.current(sessionId);
            }
          }
          break;
        }
        case 'Escape': {
          // Escape with archive open closes it; otherwise no-op (no accordion to collapse)
          break;
        }
        case '/': {
          e.preventDefault();
          setArchive({ repoName: undefined });
          break;
        }
        case 'r': {
          e.preventDefault();
          refetch();
          break;
        }
        case 'a': {
          e.preventDefault();
          setScope(scopeRef.current === 'active' ? 'all' : 'active');
          break;
        }
      }
    }

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setFocusedIndex, setScope, refetch, setArchive]);
}
// build-1775224304
