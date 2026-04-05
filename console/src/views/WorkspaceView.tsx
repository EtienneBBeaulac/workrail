import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSessionList, useWorktreeList, useWorkspaceEvents } from '../api/hooks';
import { SessionList } from './SessionList';
import type { ConsoleSessionSummary, ConsoleSessionStatus, FileChangeStatus, ChangedFile } from '../api/types';
import {
  type WorkspaceItem,
  type Scope,
  joinSessionsAndWorktrees,
  sortItemsForRepo,
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

/** Branches grouped by repo, sorted for display within their repo section. */
interface RepoGroup {
  readonly repoRoot: string;
  readonly repoName: string;
  readonly sortedItems: readonly WorkspaceItem[];
}

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
  const [attentionFilter, setAttentionFilter] = useState(false);
  const [archive, setArchive] = useState<ArchiveState | null>(null);

  // Scroll restoration: capture scroll position before navigating to SessionDetail,
  // restore on return. Sessions are always visible so no accordion key to restore.
  const scrollYRef = useRef<number>(0);
  const isFirstRender = useRef(true);

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

  const { repoGroups, orderedItems, needsAttentionCount, archiveRepos } = useMemo(() => {
    const nowMs = Date.now();
    const empty = { repoGroups: [] as RepoGroup[], orderedItems: [] as WorkspaceItem[], needsAttentionCount: 0, archiveRepos: [] as Array<[string, string]> };
    if (!sessionData) return empty;

    const worktreeRepos = worktreeData?.repos ?? [];
    const joined = joinSessionsAndWorktrees(sessionData.sessions, worktreeRepos);

    // Derive archive repos from the full joined list so ArchiveLinks always shows
    // all repos even when attentionFilter hides some.
    const reposSeen = new Map<string, string>(); // repoRoot -> repoName
    for (const item of joined) {
      if (!reposSeen.has(item.repoRoot)) {
        reposSeen.set(item.repoRoot, item.repoName);
      }
    }

    // Pre-filter for attention (blocked/dormant only) before grouping
    const attentionFiltered = attentionFilter
      ? joined.filter((item) => {
          const s = item.primarySession?.status;
          return s === 'blocked' || s === 'dormant';
        })
      : joined;

    // Group by repo, sort within each group using sortItemsForRepo
    const byRepo = new Map<string, WorkspaceItem[]>();
    for (const item of attentionFiltered) {
      const existing = byRepo.get(item.repoRoot);
      if (existing) {
        existing.push(item);
      } else {
        byRepo.set(item.repoRoot, [item]);
      }
    }

    // Sort repos: repos with active sessions first, then alphabetical
    const groups: RepoGroup[] = [...byRepo.entries()]
      .map(([repoRoot, repoItems]) => ({
        repoRoot,
        repoName: repoItems[0]!.repoName,
        sortedItems: sortItemsForRepo(repoItems, scope, nowMs),
      }))
      .filter((g) => g.sortedItems.length > 0)
      .sort((a, b) => {
        const aActive = a.sortedItems.some(
          (i) => i.primarySession?.status === 'in_progress' || i.primarySession?.status === 'blocked',
        ) ? 0 : 1;
        const bActive = b.sortedItems.some(
          (i) => i.primarySession?.status === 'in_progress' || i.primarySession?.status === 'blocked',
        ) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return a.repoName.localeCompare(b.repoName);
      });

    // Flat ordered list for keyboard navigation -- must match visual order
    const flat = groups.flatMap((g) => g.sortedItems);

    return {
      repoGroups: groups,
      orderedItems: flat,
      needsAttentionCount: countNeedsAttention(joined),
      archiveRepos: [...reposSeen.entries()] as Array<[string, string]>,
    };
  }, [sessionData, worktreeData, scope, attentionFilter]);

  // Reset keyboard focus when the item list changes length (e.g. after scope toggle).
  // Prevents focusedIndex pointing to a different item than the user expects.
  useEffect(() => {
    setFocusedIndex(-1);
  }, [orderedItems.length]);

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
    <div className={`space-y-5 ${hidden ? 'hidden' : ''}`}>
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

          {/* Repo sections -- one per repo, header shown only when 2+ repos */}
          {repoGroups.length === 0 ? (
            <div className="text-sm text-[var(--text-muted)] py-8 text-center">
              No branches match the current filter.
            </div>
          ) : (
            <div className="space-y-6">
              {repoGroups.map((group, groupIndex) => {
                // Compute the flat offset of this group's first item in orderedItems
                const groupOffset = repoGroups
                  .slice(0, groupIndex)
                  .reduce((sum, g) => sum + g.sortedItems.length, 0);
                return (
                  <RepoSection
                    key={group.repoRoot}
                    group={group}
                    showHeader={repoGroups.length > 1}
                    focusedIndex={focusedIndex}
                    groupOffset={groupOffset}
                    worktreesFetching={worktreesFetching}
                    onSelectSession={wrappedSelectSession}
                  />
                );
              })}
            </div>
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
// Repo section
// ---------------------------------------------------------------------------

const SECTION_COLLAPSE_THRESHOLD = 12;

function RepoSection({
  group,
  showHeader,
  focusedIndex,
  groupOffset,
  worktreesFetching,
  onSelectSession,
}: {
  readonly group: RepoGroup;
  readonly showHeader: boolean;
  readonly focusedIndex: number;
  readonly groupOffset: number;
  readonly worktreesFetching: boolean;
  readonly onSelectSession: (sessionId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleItems = showAll
    ? group.sortedItems
    : group.sortedItems.slice(0, SECTION_COLLAPSE_THRESHOLD);
  const hiddenCount = group.sortedItems.length - SECTION_COLLAPSE_THRESHOLD;

  const activeCount = group.sortedItems.filter(
    (i) => i.primarySession?.status === 'in_progress' || i.primarySession?.status === 'blocked',
  ).length;
  const uncommittedCount = group.sortedItems.filter(
    (i) => (i.worktree?.changedCount ?? 0) > 0,
  ).length;

  return (
    <section>
      {showHeader && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] pb-2 mb-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] font-mono">
            {group.repoName}
          </h3>
          {activeCount > 0 && (
            <span className="text-xs font-medium text-[var(--accent)]">
              ● {activeCount} active
            </span>
          )}
          {uncommittedCount > 0 && (
            <span className="text-xs font-medium text-orange-400">
              · {uncommittedCount} uncommitted
            </span>
          )}
        </div>
      )}
      <div className="space-y-px">
        {visibleItems.map((item, idx) => {
          const absoluteIndex = groupOffset + idx;
          const isFocused = focusedIndex === absoluteIndex;

          // Worktree-only branch (no sessions): compact git-state row
          if (item.allSessions.length === 0) {
            return (
              <WorktreeOnlyRow
                key={`${item.branch}\0${item.repoRoot}`}
                item={item}
                isFocused={isFocused}
                worktreesFetching={worktreesFetching}
              />
            );
          }

          // Multi-session branch: collapsible group with branch label as toggle
          if (item.allSessions.length > 1) {
            return (
              <BranchGroup
                key={`${item.branch}\0${item.repoRoot}`}
                item={item}
                isFocused={isFocused}
                worktreesFetching={worktreesFetching}
                onSelectSession={onSelectSession}
              />
            );
          }

          // Single-session branch: one flat row (goal headline + branch subscript)
          const session = item.allSessions[0]!;
          return (
            <div key={`${item.branch}\0${item.repoRoot}`} className={isFocused ? 'ring-2 ring-[var(--accent)] ring-offset-1 rounded' : ''}>
              <SessionRow
                session={session}
                item={item}
                showBranch={true}
                onSelect={() => onSelectSession(session.sessionId)}
              />
            </div>
          );
        })}
        {!showAll && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full text-left px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            show {hiddenCount} more {hiddenCount === 1 ? 'branch' : 'branches'} &rarr;
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Branch group -- collapsible container for multi-session branches
// ---------------------------------------------------------------------------

// Session sort: matches sortPriority() order in workspace-types.ts
// in_progress=dormant(0) > blocked(1) > everything else(2), then by recency -- dormant matches STATUS_PRIORITY (F2 fix)
const SESSION_SORT = (a: ConsoleSessionSummary, b: ConsoleSessionSummary) => {
  const priority = (s: ConsoleSessionSummary) =>
    s.status === 'in_progress' || s.status === 'dormant' ? 0 :
    s.status === 'blocked' ? 1 :
    2;
  const diff = priority(a) - priority(b);
  if (diff !== 0) return diff;
  return b.lastModifiedMs - a.lastModifiedMs;
};

function BranchGroup({
  item,
  isFocused,
  worktreesFetching,
  onSelectSession,
}: {
  readonly item: WorkspaceItem;
  readonly isFocused: boolean;
  readonly worktreesFetching: boolean;
  readonly onSelectSession: (sessionId: string) => void;
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const sorted = [...item.allSessions].sort(SESSION_SORT);

  // Active sessions (in_progress/blocked/dormant) are always visible.
  // Dormant = stalled but not done, so it stays visible alongside active work.
  // Completed sessions are collapsed behind a toggle -- they're history, not current work.
  const activeSessions = sorted.filter(
    (s) => s.status === 'in_progress' || s.status === 'blocked' || s.status === 'dormant',
  );
  const historySessions = sorted.filter(
    (s) => s.status !== 'in_progress' && s.status !== 'blocked' && s.status !== 'dormant',
  );

  return (
    <div className={isFocused ? 'ring-2 ring-[var(--accent)] ring-offset-1 rounded' : ''}>
      <BranchLabel
        item={item}
        worktreesFetching={worktreesFetching}
        filesExpanded={filesExpanded}
        onToggleFiles={() => setFilesExpanded((e) => !e)}
      />
      {filesExpanded && item.worktree && item.worktree.changedFiles.length > 0 && (
        <ChangedFilesPanel files={item.worktree.changedFiles} />
      )}
      {activeSessions.map((session) => (
        <SessionRow
          key={session.sessionId}
          session={session}
          showBranch={false}
          onSelect={() => onSelectSession(session.sessionId)}
        />
      ))}
      {historySessions.length > 0 && (
        <>
          {historyExpanded && historySessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              showBranch={false}
              onSelect={() => onSelectSession(session.sessionId)}
            />
          ))}
          <button
            type="button"
            onClick={() => setHistoryExpanded((e) => !e)}
            className="w-full text-left px-3 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {historyExpanded
              ? 'hide history ▴'
              : `${historySessions.length} completed workflow${historySessions.length !== 1 ? 's' : ''} ▾`}
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session row -- one per session, always visible, click opens SessionDetail
// ---------------------------------------------------------------------------

function SessionRow({
  session,
  item,
  showBranch,
  onSelect,
}: {
  readonly session: ConsoleSessionSummary;
  /** The parent WorkspaceItem -- needed for branch subscript and git badges on single-session rows */
  readonly item?: WorkspaceItem;
  /** Show branch name as subscript (true for single-session rows; false for multi-session children) */
  readonly showBranch: boolean;
  readonly onSelect: () => void;
}) {
  const accent = STATUS_ACCENT[session.status];
  const isDormant = session.status === 'dormant';
  const workflowLabel = session.workflowName ?? session.workflowId ?? null;
  const timeAgo = formatRelativeTime(session.lastModifiedMs);

  // Goal title: session title (from goal field) or fallback
  const goalTitle = session.sessionTitle?.trim() || workflowLabel || session.sessionId.slice(0, 8);
  const recapSubtitle = session.recapSnippet && !session.sessionTitle
    ? excerptRecap(session.recapSnippet, 100)
    : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded hover:bg-[var(--bg-card)] transition-colors group"
    >
      {/* Status dot -- hollow ring for dormant */}
      {isDormant ? (
        <div
          className="w-1.5 h-1.5 rounded-full shrink-0 mt-[3px] border-2 bg-transparent"
          style={{ borderColor: accent }}
          title={STATUS_DOT_LABEL['dormant']}
        />
      ) : (
        <div
          className="w-1.5 h-1.5 rounded-full shrink-0 mt-[3px]"
          style={{ backgroundColor: accent }}
          title={STATUS_DOT_LABEL[session.status]}
        />
      )}

      <div className="flex-1 min-w-0">
        {/* Goal headline -- full width, wraps naturally */}
        <p className="text-sm text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors leading-snug mb-0.5 max-w-prose line-clamp-2">
          {goalTitle}
        </p>

        {/* Meta row: branch (if single-session) + workflow + time + gaps */}
        <div className="flex items-center gap-2 min-w-0">
          {showBranch && item && (
            <span className="font-mono text-xs text-[var(--text-muted)] truncate flex-1">
              {item.branch}
            </span>
          )}
          {!showBranch && workflowLabel && (
            <span className="text-[10px] text-[var(--text-muted)] shrink-0">
              {workflowLabel}
            </span>
          )}
          {session.hasUnresolvedGaps && (
            <span title="Unresolved gaps" className="text-[10px] text-[var(--warning)] shrink-0">&#x26A0;</span>
          )}
          <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0 ml-auto">{timeAgo}</span>
        </div>

        {/* Recap subtitle (when no goal title but recap exists) */}
        {recapSubtitle && (
          <p className="text-xs text-[var(--text-muted)] truncate leading-snug">{recapSubtitle}</p>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Branch label -- visual separator for multi-session branches
// Shows branch name + git state. Not clickable -- sessions are the action target.
// ---------------------------------------------------------------------------

function BranchLabel({
  item,
  worktreesFetching,
  filesExpanded,
  onToggleFiles,
}: {
  readonly item: WorkspaceItem;
  readonly worktreesFetching: boolean;
  readonly filesExpanded?: boolean;
  readonly onToggleFiles?: () => void;
}) {
  const timeAgo = formatRelativeTime(item.activityMs);
  return (
    <div className="flex items-center gap-2 px-3 pt-2 pb-1">
      <span className="font-mono text-xs font-medium text-[var(--text-secondary)] truncate flex-1">
        {item.branch}
      </span>
      <GitBadges
        item={item}
        fetching={worktreesFetching}
        compact
        filesExpanded={filesExpanded}
        onToggleFiles={onToggleFiles}
      />
      <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">{timeAgo}</span>
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
}: {
  readonly item: WorkspaceItem;
  readonly isFocused: boolean;
  readonly worktreesFetching: boolean;
}) {
  const [filesExpanded, setFilesExpanded] = useState(false);
  const timeAgo = formatRelativeTime(item.activityMs);
  return (
    // Outer wrapper enables the file panel to be a sibling of the flex row.
    // The isFocused ring stays on the inner flex row so it does not wrap the panel.
    <div>
      <div
        className={`flex items-center gap-3 px-3 py-2 rounded ${isFocused ? 'ring-2 ring-[var(--accent)] ring-offset-1' : ''}`}
      >
        <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--border)]" title="No sessions" />
        <span className="font-mono text-xs text-[var(--text-muted)] truncate flex-1">
          {item.branch}
        </span>
        <GitBadges
          item={item}
          fetching={worktreesFetching}
          compact
          filesExpanded={filesExpanded}
          onToggleFiles={() => setFilesExpanded((e) => !e)}
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
}: {
  readonly item: WorkspaceItem;
  readonly fetching: boolean;
  readonly compact?: boolean;
  /** When provided, the uncommitted badge becomes a toggle button. */
  readonly filesExpanded?: boolean;
  readonly onToggleFiles?: () => void;
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
            className={`${badgeClass} cursor-pointer hover:bg-orange-500/20 transition-colors${filesExpanded ? ' ring-1 ring-orange-500/40' : ''}`}
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
// Skeleton badge
// ---------------------------------------------------------------------------

function SkeletonBadge() {
  return (
    <span className="inline-block h-5 w-20 rounded bg-[var(--bg-tertiary)] animate-pulse" />
  );
}

// ---------------------------------------------------------------------------
// Session row list (accordion content)
// (SessionRowList removed -- sessions are now rendered directly as SessionRow components)

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
  }, [setFocusedIndex, setScope, refetch, setArchive]);
}
// build-1775224304
