import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { useSessionList } from '../api/hooks';
import { useWorktreeList } from '../api/hooks';
import { SessionList } from './SessionList';
import type { ConsoleSessionSummary, ConsoleSessionStatus } from '../api/types';
import {
  type WorkspaceItem,
  type Scope,
  type SectionKind,
  joinSessionsAndWorktrees,
  sortWorkspaceItems,
  sectionFor,
  countNeedsAttention,
} from './workspace-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_ACCENT: Record<ConsoleSessionStatus, string> = {
  blocked: 'var(--blocked)',
  dormant: 'var(--text-muted)',
  complete_with_gaps: 'var(--warning)',
  in_progress: 'var(--accent)',
  complete: 'var(--success)',
};

const STATUS_DOT_LABEL: Record<ConsoleSessionStatus, string> = {
  in_progress: 'In progress',
  dormant: 'Dormant',
  blocked: 'Blocked',
  complete_with_gaps: 'Complete with gaps',
  complete: 'Complete',
};

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
// Text utilities (same as Homepage.tsx)
// ---------------------------------------------------------------------------

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function excerptRecap(md: string, maxLen = 220): string {
  const plain = stripMarkdown(md);
  if (plain.length <= maxLen) return plain;
  const cut = plain.lastIndexOf(' ', maxLen);
  return plain.slice(0, cut > 0 ? cut : maxLen) + '\u2026';
}

function formatRelativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ---------------------------------------------------------------------------
// Archive state
// ---------------------------------------------------------------------------

interface ArchiveState {
  readonly repoName: string | undefined;
  readonly repoRoot: string | undefined;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  onSelectSession: (sessionId: string) => void;
  /** When true, the view is hidden (parent navigated to SessionDetail). Kept
   * mounted so state is preserved for scroll restoration on back-nav. */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// WorkspaceView
// ---------------------------------------------------------------------------

export function WorkspaceView({ onSelectSession, hidden = false }: Props) {
  const { data: sessionData, isLoading: sessionsLoading, error: sessionsError, refetch } = useSessionList();
  const { data: worktreeData, isFetching: worktreesFetching } = useWorktreeList();

  const [scope, setScope] = useState<Scope>('active');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [attentionFilter, setAttentionFilter] = useState(false);
  const [archive, setArchive] = useState<ArchiveState | null>(null);

  // Scroll restoration: capture before navigating away, restore on re-show
  const scrollYRef = useRef<number>(0);
  const expandedKeyBeforeNavRef = useRef<string | null>(null);
  // Track first render so scroll restoration doesn't fire on mount (would scroll to 0 needlessly)
  const isFirstRender = useRef(true);

  const wrappedSelectSession = useCallback(
    (sessionId: string) => {
      scrollYRef.current = window.scrollY;
      expandedKeyBeforeNavRef.current = expandedKey;
      onSelectSession(sessionId);
    },
    [onSelectSession, expandedKey],
  );

  // Restore scroll and expanded state when returning from SessionDetail.
  // Skip on first mount -- page is already at 0 and there is nothing to restore.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!hidden) {
      setExpandedKey(expandedKeyBeforeNavRef.current);
      // Defer scroll restoration until after paint
      const id = requestAnimationFrame(() => {
        window.scrollTo({ top: scrollYRef.current });
      });
      return () => cancelAnimationFrame(id);
    }
  }, [hidden]);

  const { items, needsAttentionCount, archiveRepos } = useMemo(() => {
    const nowMs = Date.now();
    if (!sessionData) return { items: [], needsAttentionCount: 0, archiveRepos: [] as Array<[string, string]> };
    const repos = worktreeData?.repos ?? [];
    const joined = joinSessionsAndWorktrees(sessionData.sessions, repos);
    const sorted = sortWorkspaceItems(joined, scope, nowMs);
    const filtered = attentionFilter
      ? sorted.filter((item) => {
          const s = item.primarySession?.status;
          return s === 'blocked' || s === 'dormant';
        })
      : sorted;

    // Derive archive repos from the full joined list (not filtered) so that ArchiveLinks
    // shows all repos even when the attention filter hides some of their items.
    const reposSeen = new Map<string, string>(); // repoRoot -> repoName
    for (const item of joined) {
      if (!reposSeen.has(item.repoRoot)) {
        reposSeen.set(item.repoRoot, item.repoName);
      }
    }

    return {
      items: filtered,
      needsAttentionCount: countNeedsAttention(joined),
      archiveRepos: [...reposSeen.entries()] as Array<[string, string]>,
    };
  }, [sessionData, worktreeData, scope, attentionFilter]);

  const activeItems = useMemo(() => {
    const nowMs = Date.now();
    return items.filter((item) => sectionFor(item, scope, nowMs) === 'active');
  }, [items, scope]);

  const recentItems = useMemo(() => {
    const nowMs = Date.now();
    return items.filter((item) => sectionFor(item, scope, nowMs) === 'recent');
  }, [items, scope]);

  // Flat ordered list for keyboard navigation
  const orderedItems = useMemo(() => [...activeItems, ...recentItems], [activeItems, recentItems]);

  // Reset keyboard focus when the item list changes length (e.g. after scope toggle).
  // Prevents focusedIndex pointing to a different item than the user expects.
  useEffect(() => {
    setFocusedIndex(-1);
  }, [orderedItems.length]);

  const handleToggleExpand = useCallback((key: string) => {
    // Single expand only: only one item expanded at a time
    setExpandedKey((prev) => (prev === key ? null : key));
  }, []);

  const handleAlertClick = useCallback(() => {
    setAttentionFilter((prev) => {
      const next = !prev;
      // Activating the filter forces All scope so hidden branches become visible.
      // Deactivating resets scope back to Active -- the ScopeToggle pill must match reality.
      setScope(next ? 'all' : 'active');
      return next;
    });
  }, []);

  // Keyboard navigation -- disabled while hidden (e.g. SessionDetail overlaid on top)
  useWorkspaceKeyboard({
    items: orderedItems,
    focusedIndex,
    setFocusedIndex,
    expandedKey,
    setExpandedKey,
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
        <div className="text-[var(--text-muted)] text-sm">Loading workspace...</div>
      </div>
    );
  }

  if (sessionsError) {
    return (
      <div className={`text-[var(--error)] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 text-sm ${hidden ? 'hidden' : ''}`}>
        Failed to load workspace: {sessionsError.message}
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
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors text-sm"
          >
            &larr; Back to Workspace
          </button>
          {archive.repoName && (
            <span className="text-sm text-[var(--text-muted)] font-mono">{archive.repoName}</span>
          )}
        </div>
        <SessionList
          onSelectSession={wrappedSelectSession}
          initialRepoRoot={archive.repoRoot ?? null}
        />
      </div>
    );
  }

  return (
    <div className={`space-y-5 max-w-3xl ${hidden ? 'hidden' : ''}`}>
      {!hasAnySessions ? (
        <>
          <FullEmptyState prompt={pickRandom(ACTION_PROMPTS)} />
          <TipCard />
        </>
      ) : (
        <>
          {/* Alert strip */}
          {needsAttentionCount > 0 && (
            <AlertStrip
              count={needsAttentionCount}
              active={attentionFilter}
              onFocusAttention={handleAlertClick}
            />
          )}

          {/* Scope toggle */}
          <ScopeToggle scope={scope} onChange={setScope} />

          {/* Active section */}
          <WorkspaceSection
            kind="active"
            items={activeItems}
            expandedKey={expandedKey}
            focusedIndex={focusedIndex}
            focusedOffset={0}
            worktreesFetching={worktreesFetching}
            onToggle={handleToggleExpand}
            onSelectSession={wrappedSelectSession}
          />

          {/* Recent / All branches section */}
          {recentItems.length > 0 && (
            <WorkspaceSection
              kind="recent"
              items={recentItems}
              expandedKey={expandedKey}
              focusedIndex={focusedIndex}
              focusedOffset={activeItems.length}
              worktreesFetching={worktreesFetching}
              scopeLabel={scope === 'all' ? 'All branches' : 'Recent'}
              onToggle={handleToggleExpand}
              onSelectSession={wrappedSelectSession}
            />
          )}

          {/* Archive links -- uses unfiltered archiveRepos so all repos are always reachable */}
          <ArchiveLinks
            repos={archiveRepos}
            onOpen={(repoName, repoRoot) => setArchive({ repoName, repoRoot })}
          />
        </>
      )}

      <TipCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace section (Active or Recent)
// ---------------------------------------------------------------------------

function WorkspaceSection({
  kind,
  items,
  expandedKey,
  focusedIndex,
  focusedOffset,
  worktreesFetching,
  scopeLabel,
  onToggle,
  onSelectSession,
}: {
  readonly kind: SectionKind;
  readonly items: readonly WorkspaceItem[];
  readonly expandedKey: string | null;
  readonly focusedIndex: number;
  readonly focusedOffset: number;
  readonly worktreesFetching: boolean;
  readonly scopeLabel?: string;
  readonly onToggle: (key: string) => void;
  readonly onSelectSession: (sessionId: string) => void;
}) {
  if (items.length === 0 && kind === 'active') {
    return <WorkspaceEmptyActive />;
  }
  if (items.length === 0) return null;

  const label = scopeLabel ?? (kind === 'active' ? 'Active' : 'Recent');

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
        {label}
      </h2>
      <div className={kind === 'active' ? 'flex flex-col gap-3' : 'space-y-px'}>
        {items.map((item, idx) => {
          const key = `${item.branch}\0${item.repoRoot}`;
          const isFocused = focusedIndex === focusedOffset + idx;
          const isExpanded = expandedKey === key;

          if (kind === 'active') {
            return (
              <FeaturedCard
                key={key}
                item={item}
                isExpanded={isExpanded}
                isFocused={isFocused}
                worktreesFetching={worktreesFetching}
                onToggle={() => onToggle(key)}
                onSelectSession={onSelectSession}
              />
            );
          }
          return (
            <CompactRow
              key={key}
              item={item}
              isExpanded={isExpanded}
              isFocused={isFocused}
              worktreesFetching={worktreesFetching}
              onToggle={() => onToggle(key)}
              onSelectSession={onSelectSession}
            />
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Featured card (Active section)
// ---------------------------------------------------------------------------

function FeaturedCard({
  item,
  isExpanded,
  isFocused,
  worktreesFetching,
  onToggle,
  onSelectSession,
}: {
  readonly item: WorkspaceItem;
  readonly isExpanded: boolean;
  readonly isFocused: boolean;
  readonly worktreesFetching: boolean;
  readonly onToggle: () => void;
  readonly onSelectSession: (sessionId: string) => void;
}) {
  // Lifted here so showAll survives accordion collapse/reopen
  const [showAll, setShowAll] = useState(false);
  const session = item.primarySession;
  const accent = session ? STATUS_ACCENT[session.status] : 'var(--border)';
  const workflowLabel = session?.workflowName ?? session?.workflowId ?? null;
  const excerpt = session?.recapSnippet ? excerptRecap(session.recapSnippet) : null;
  const timeAgo = formatRelativeTime(item.activityMs);
  const multiRepo = true; // always show repo badge in featured cards

  return (
    <div
      className={`bg-[var(--bg-card)] border rounded-lg overflow-hidden transition-colors ${
        isFocused ? 'border-[var(--accent)]' : 'border-[var(--border)]'
      }`}
    >
      {/* Card header -- click to expand/collapse */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left flex overflow-hidden hover:bg-[var(--bg-secondary)] transition-colors group"
        aria-expanded={isExpanded}
      >
        {/* Status stripe */}
        <div className="w-[3px] shrink-0 self-stretch" style={{ backgroundColor: accent }} />

        <div className="flex-1 p-4 min-w-0">
          {/* Header row: branch + repo badge + time */}
          <div className="flex items-center gap-2 mb-2 min-w-0">
            <span className="font-mono text-sm font-medium text-[var(--text-primary)] truncate flex-1">
              {item.branch}
            </span>
            {multiRepo && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0">
                {item.repoName}
              </span>
            )}
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
              {timeAgo}
            </span>
          </div>

          {/* Status + workflow row */}
          {session && (
            <div className="flex items-center gap-2 mb-2">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: accent }}
                title={STATUS_DOT_LABEL[session.status]}
              />
              <span className="text-xs" style={{ color: accent }}>
                {STATUS_DOT_LABEL[session.status]}
              </span>
              {workflowLabel && (
                <>
                  <span className="text-[var(--text-muted)] text-xs">·</span>
                  <span className="text-xs text-[var(--text-muted)] truncate">
                    {workflowLabel}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Recap or commit message */}
          {excerpt ? (
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed group-hover:text-[var(--text-primary)] transition-colors mb-3">
              {excerpt}
            </p>
          ) : item.worktree?.headMessage ? (
            <p className="text-sm text-[var(--text-muted)] leading-snug mb-3 truncate">
              {item.worktree.headMessage}
            </p>
          ) : null}

          {/* Footer: git badges + session count */}
          <div className="flex items-center gap-2 flex-wrap">
            <GitBadges item={item} fetching={worktreesFetching} />

            {session?.hasUnresolvedGaps && (
              <span
                title="This session flagged unresolved gaps -- open questions it could not answer."
                className="text-xs px-1.5 py-0.5 rounded bg-[var(--warning)]/10 text-[var(--warning)] border border-[var(--warning)]/20 cursor-default"
              >
                &#x26A0; gaps
              </span>
            )}

            {session?.health === 'corrupt' && (
              <span
                title="This session's event log may be incomplete -- some steps may not display correctly."
                className="text-xs px-1.5 py-0.5 rounded bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/20 cursor-default"
              >
                &#x26A0;
              </span>
            )}

            {item.allSessions.length > 0 && (
              <span className="text-xs text-[var(--text-muted)] ml-auto">
                {item.allSessions.length} session{item.allSessions.length !== 1 ? 's' : ''}{' '}
                <span className="text-[10px]">{isExpanded ? '▴' : '▾'}</span>
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Accordion: inline session list */}
      {isExpanded && (
        <SessionRowList
          sessions={item.allSessions}
          showAll={showAll}
          onShowAll={() => setShowAll(true)}
          onSelectSession={onSelectSession}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact row (Recent section)
// ---------------------------------------------------------------------------

function CompactRow({
  item,
  isExpanded,
  isFocused,
  worktreesFetching,
  onToggle,
  onSelectSession,
}: {
  readonly item: WorkspaceItem;
  readonly isExpanded: boolean;
  readonly isFocused: boolean;
  readonly worktreesFetching: boolean;
  readonly onToggle: () => void;
  readonly onSelectSession: (sessionId: string) => void;
}) {
  // Lifted here so showAll survives accordion collapse/reopen
  const [showAll, setShowAll] = useState(false);
  const session = item.primarySession;
  const accent = session ? STATUS_ACCENT[session.status] : 'var(--border)';
  const timeAgo = formatRelativeTime(item.activityMs);
  const tipCount = item.allSessions.reduce((sum, s) => sum + (s.tipCount ?? 0), 0);

  return (
    <div className={isFocused ? 'ring-2 ring-[var(--accent)] ring-offset-1 rounded' : ''}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left flex items-center gap-3 px-3 py-2 rounded hover:bg-[var(--bg-card)] transition-colors group"
        aria-expanded={isExpanded}
      >
        {/* Status dot */}
        <div
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: accent }}
          title={session ? STATUS_DOT_LABEL[session.status] : 'No sessions'}
        />

        {/* Branch name */}
        <span className="font-mono text-sm text-[var(--text-secondary)] truncate flex-1 group-hover:text-[var(--text-primary)] transition-colors">
          {item.branch}
        </span>

        {/* Repo badge (when multi-repo) */}
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0 hidden sm:inline">
          {item.repoName}
        </span>

        {/* Git badges */}
        <GitBadges item={item} fetching={worktreesFetching} compact />

        {/* Tip count badge */}
        {tipCount > 1 && (
          <span
            title={`${tipCount} execution paths -- the agent explored different routes or this session was resumed from multiple checkpoints`}
            className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0 tabular-nums"
          >
            {tipCount} tips
          </span>
        )}

        {/* Time */}
        <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
          {timeAgo}
        </span>

        {/* Expand indicator */}
        <span className="text-[10px] text-[var(--text-muted)] shrink-0">
          {isExpanded ? '▴' : '▾'}
        </span>
      </button>

      {/* Accordion */}
      {isExpanded && (
        <SessionRowList
          sessions={item.allSessions}
          showAll={showAll}
          onShowAll={() => setShowAll(true)}
          onSelectSession={onSelectSession}
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
}: {
  readonly item: WorkspaceItem;
  readonly fetching: boolean;
  readonly compact?: boolean;
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

  return (
    <span className="flex items-center gap-1">
      {changedCount > 0 && (
        <span
          title={`${changedCount} file${changedCount === 1 ? '' : 's'} edited but not yet committed`}
          className={`text-xs px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20 tabular-nums${compact ? ' text-[10px]' : ''}`}
        >
          {changedCount} uncommitted
        </span>
      )}
      {aheadCount > 0 && (
        <span
          title={`${aheadCount} commit${aheadCount === 1 ? '' : 's'} not yet pushed`}
          className={`text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 tabular-nums${compact ? ' text-[10px]' : ''}`}
        >
          {aheadCount} unpushed
        </span>
      )}
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
// Session row list (accordion content)
// ---------------------------------------------------------------------------

const MAX_INLINE_SESSIONS = 5;

function SessionRowList({
  sessions,
  showAll,
  onShowAll,
  onSelectSession,
}: {
  readonly sessions: readonly ConsoleSessionSummary[];
  readonly showAll: boolean;
  readonly onShowAll: () => void;
  readonly onSelectSession: (sessionId: string) => void;
}) {
  const visible = showAll ? sessions : sessions.slice(0, MAX_INLINE_SESSIONS);

  if (sessions.length === 0) {
    return (
      <div className="border-t border-[var(--border)] px-4 py-3">
        <p className="text-xs text-[var(--text-muted)]">No sessions recorded for this branch.</p>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border)]">
      {visible.map((session) => {
        const accent = STATUS_ACCENT[session.status];
        const label =
          session.sessionTitle ??
          session.workflowName ??
          session.workflowId ??
          'Unnamed session';
        const timeAgo = formatRelativeTime(session.lastModifiedMs);

        return (
          <button
            key={session.sessionId}
            type="button"
            onClick={() => onSelectSession(session.sessionId)}
            className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-secondary)] transition-colors group"
          >
            <div
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: accent }}
              title={STATUS_DOT_LABEL[session.status]}
            />
            <span className="text-sm text-[var(--text-secondary)] truncate flex-1 group-hover:text-[var(--text-primary)] transition-colors">
              {label}
            </span>
            {session.hasUnresolvedGaps && (
              <span
                title="Unresolved gaps"
                className="text-xs text-[var(--warning)] shrink-0"
              >
                &#x26A0;
              </span>
            )}
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
              {timeAgo}
            </span>
          </button>
        );
      })}

      {!showAll && sessions.length > MAX_INLINE_SESSIONS && (
        <button
          type="button"
          onClick={onShowAll}
          className="w-full text-left px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          show {sessions.length - MAX_INLINE_SESSIONS} more &rarr;
        </button>
      )}
    </div>
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
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors capitalize ${
            scope === s
              ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          {s === 'active' ? 'Active' : 'All'}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alert strip (clickable)
// ---------------------------------------------------------------------------

function AlertStrip({
  count,
  active,
  onFocusAttention,
}: {
  readonly count: number;
  readonly active: boolean;
  readonly onFocusAttention: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFocusAttention}
      className={`w-full flex items-center gap-3 bg-[var(--bg-card)] border rounded-lg px-4 py-2.5 overflow-hidden text-left transition-colors hover:border-[var(--blocked)] ${
        active ? 'border-[var(--blocked)]' : 'border-[var(--border)]'
      }`}
      style={{ borderLeftColor: 'var(--blocked)', borderLeftWidth: '3px' }}
      title={active ? 'Click to show all branches' : 'Click to focus on sessions needing attention'}
    >
      <span className="text-sm font-medium" style={{ color: 'var(--blocked)' }}>
        {count} session{count !== 1 ? 's' : ''} {count !== 1 ? 'need' : 'needs'} attention
      </span>
      <span className="text-xs text-[var(--text-muted)]">
        {active ? '-- click to clear filter' : '-- click to focus'}
      </span>
    </button>
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
  // regardless of attention filter or scope.
  readonly repos: ReadonlyArray<readonly [string, string]>;
  readonly onOpen: (repoName: string | undefined, repoRoot: string | undefined) => void;
}) {

  // Always show at least the global link so users with only null-repoRoot sessions
  // (pre-dating the repoRoot observation) can still reach the full archive.
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-[var(--border)]">
      {repos.map(([repoRoot, repoName]) => (
        <button
          key={repoRoot}
          type="button"
          onClick={() => onOpen(repoName, repoRoot)}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors text-left"
        >
          All {repoName} sessions &rarr;
        </button>
      ))}
      {/* Global link: always shown so null-repoRoot sessions are always reachable */}
      {repos.length !== 1 && (
        <button
          type="button"
          onClick={() => onOpen(undefined, undefined)}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors text-left"
        >
          All sessions &rarr;
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace empty active state
// ---------------------------------------------------------------------------

function WorkspaceEmptyActive() {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-6 text-center">
      <p className="text-sm text-[var(--text-muted)]">
        No active work. Start a workflow with your agent to see it here.
      </p>
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
        <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3">
          Ready when you are
        </h2>
        <p className="text-sm text-[var(--text-muted)] max-w-sm leading-relaxed">
          Sessions appear here when your agent runs a workflow. Start one by telling your agent:
        </p>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-6 py-5 max-w-lg w-full text-left">
        <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
          Try this prompt
        </p>
        <p className="text-[var(--text-primary)] text-sm leading-relaxed">
          "Use the{' '}
          <span className="text-[var(--accent)] font-medium">{prompt.workflow}</span>
          {' '}to {prompt.task}"
        </p>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        Prompts rotate each visit -- there are {ACTION_PROMPTS.length} to discover.
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
    <div className="flex items-start gap-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
      <div
        className="w-0.5 shrink-0 self-stretch rounded-full"
        style={{ backgroundColor: 'var(--accent)' }}
      />
      <div style={{ opacity: fading ? 0 : 1, transition: 'opacity 300ms' }}>
        <span className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-widest">
          Tip
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
  readonly expandedKey: string | null;
  readonly setExpandedKey: (key: string | null) => void;
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
  expandedKey,
  setExpandedKey,
  scope,
  setScope,
  refetch,
  archive,
  setArchive,
  disabled,
}: KeyboardOptions) {
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const expandedKeyRef = useRef(expandedKey);
  expandedKeyRef.current = expandedKey;

  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;

  const archiveRef = useRef(archive);
  archiveRef.current = archive;

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip when the workspace view is hidden behind SessionDetail
      if (disabledRef.current) return;

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
      const expandedKey = expandedKeyRef.current;
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
            const key = `${item.branch}\0${item.repoRoot}`;
            setExpandedKey(expandedKey === key ? null : key);
          }
          break;
        }
        case 'Escape': {
          if (expandedKey !== null) {
            e.preventDefault();
            setExpandedKey(null);
          }
          break;
        }
        case '/': {
          e.preventDefault();
          setArchive({ repoName: undefined, repoRoot: undefined });
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
  }, [setFocusedIndex, setExpandedKey, setScope, refetch, setArchive]);
}
