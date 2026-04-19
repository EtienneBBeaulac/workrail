import { useState, useEffect } from 'react';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBadge } from '../components/HealthBadge';
import { BracketBadge } from '../components/BracketBadge';
import { MetaChip } from '../components/MetaChip';
import { ConsoleCard } from '../components/ConsoleCard';
import { TreeLine } from '../components/TreeLine';
import type { ConsoleSessionSummary } from '../api/types';
import { formatRelativeTime } from '../utils/time';
import type { UseGridKeyNavResult } from '../hooks/useGridKeyNav';
import type { UseSessionListViewModelResult } from '../hooks/useSessionListViewModel';
import type { SessionTree, SessionTreeNode } from './session-list-use-cases';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  viewModel: UseSessionListViewModelResult;
}

// ---------------------------------------------------------------------------
// SessionList -- pure presenter
// ---------------------------------------------------------------------------

export function SessionList({ viewModel }: Props) {
  const { state, dispatch, onSelectSession } = viewModel;

  if (state.kind === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[var(--text-secondary)] text-sm">Loading sessions...</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="text-[var(--error)] bg-[var(--bg-card)] rounded-lg p-4">
        Failed to load sessions: {state.message}
      </div>
    );
  }

  // state.kind === 'ready'
  const {
    rawSearch,
    sort,
    groupBy,
    statusFilter,
    page,
    totalPages,
    isGrouped,
    processed,
    statusCounts,
    flatPageSessions,
    getSessionNavProps,
    sessionContainerProps,
    sortAxes,
    groupAxes,
    statusFilterOptions,
    viewMode,
    sessionTree,
  } = state;

  const isTreeMode = viewMode === 'tree';

  if (processed.total === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-[var(--text-secondary)] text-lg">No v2 sessions found</p>
        <p className="text-[var(--text-muted)] text-sm mt-2">
          Sessions will appear here when workflows are executed with v2 tools enabled.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-[var(--text-primary)]">
          Sessions
          <span className="text-[var(--text-muted)] font-normal ml-2 text-sm">
            {isTreeMode ? processed.total : processed.filtered === processed.total ? processed.total : `${processed.filtered} / ${processed.total}`}
          </span>
        </h2>
        <div className="flex items-center gap-0 border border-[var(--border)] rounded-md overflow-hidden">
          {(['flat', 'tree'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => dispatch({ type: 'view_mode_changed', viewMode: mode })}
              className={`px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors cursor-pointer ${viewMode === mode ? 'bg-[var(--accent)] text-[#0f131f] font-bold' : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
              aria-pressed={viewMode === mode}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Toolbar */}
      <div className={`flex flex-wrap items-center gap-3 ${isTreeMode ? 'opacity-40 pointer-events-none select-none' : ''}`}>
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <input
            type="text"
            value={rawSearch}
            disabled={isTreeMode}
            aria-disabled={isTreeMode}
            onChange={(e) => dispatch({ type: 'search_changed', value: e.target.value })}
            placeholder="Search sessions..."
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
          />
          {rawSearch && (
            <button
              onClick={() => dispatch({ type: 'search_changed', value: '' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs"
            >
              clear
            </button>
          )}
        </div>

        {/* Sort */}
        <ToolbarSelect
          label="Sort"
          value={sort}
          options={sortAxes}
          onChange={(v) => dispatch({ type: 'sort_changed', sort: v })}
        />

        {/* Group */}
        <ToolbarSelect
          label="Group"
          value={groupBy}
          options={groupAxes}
          onChange={(v) => dispatch({ type: 'group_changed', groupBy: v })}
        />
      </div>

      {isTreeMode && (<p className="text-[var(--text-muted)] text-xs font-mono">Tree view -- filters disabled</p>)}
      {/* Status filter pills */}
      <div className="flex flex-wrap gap-1.5">
        {statusFilterOptions.map((opt) => {
          const count = statusCounts[opt.value] ?? 0;
          if (opt.value !== 'all' && count === 0) return null;
          const active = statusFilter === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => dispatch({ type: 'status_changed', statusFilter: opt.value })}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                active
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]'
              }`}
            >
              {opt.label}
              <span className="ml-1 opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Session list */}
      {isTreeMode ? (
        <SessionTreeView sessionTree={sessionTree} onSelectSession={onSelectSession} />
      ) : processed.filtered === 0 ? (
        <div className="text-center py-12 text-[var(--text-muted)] text-sm">
          No sessions match the current filters
        </div>
      ) : isGrouped ? (
        <div className="space-y-6">
          {processed.groups.map((group) => (
            <SessionGroup
              key={group.label + '-' + sort + '-' + statusFilter}
              label={group.label}
              sessions={group.sessions}
              sort={sort}
              statusFilter={statusFilter}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      ) : (
        <>
          <div {...sessionContainerProps} className="space-y-2">
            {flatPageSessions.map((session, i) => (
              <SessionCard
                key={session.sessionId}
                session={session}
                onClick={() => onSelectSession(session.sessionId)}
                navProps={getSessionNavProps(i)}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} onPageChange={(p) => dispatch({ type: 'page_changed', page: p })} />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar select
// ---------------------------------------------------------------------------

function ToolbarSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Session group
// ---------------------------------------------------------------------------

function SessionGroup({
  label,
  sessions,
  sort,
  statusFilter,
  onSelectSession,
}: {
  label: string;
  sessions: readonly ConsoleSessionSummary[];
  sort: string;
  statusFilter: string;
  onSelectSession: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [page, setPage] = useState(0);

  // Reset to page 0 when the sessions list shrinks (e.g. a filter reduces the
  // group to fewer pages than the current page). Without this, the user sees a
  // blank group after applying a filter that removes the last page they were on.
  useEffect(() => setPage(0), [sessions.length]);

  // Suppress the unused-variable lint warning -- sort and statusFilter are only
  // used via the key prop on the SessionGroup instance to reset state.
  void sort;
  void statusFilter;

  const PAGE_SIZE_LOCAL = 25;
  const totalPages = Math.ceil(sessions.length / PAGE_SIZE_LOCAL);
  const pageStart = page * PAGE_SIZE_LOCAL;
  const pageEnd = pageStart + PAGE_SIZE_LOCAL;
  const visibleSessions = sessions.slice(pageStart, pageEnd);

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 mb-2 cursor-pointer group"
      >
        <span className="text-[var(--text-muted)] text-xs transition-transform duration-150"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
        >
          ▼
        </span>
        <span className="text-sm font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
          {label}
        </span>
        <span className="text-xs text-[var(--text-muted)]">({sessions.length})</span>
      </button>
      {!collapsed && (
        <div className="ml-4">
          <div className="space-y-2">
            {visibleSessions.map((session) => (
              <SessionCard
                key={session.sessionId}
                session={session}
                onClick={() => onSelectSession(session.sessionId)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-2">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 pt-2">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page === 0}
        className="px-3 py-1.5 text-xs rounded-md bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[var(--bg-card)] transition-colors cursor-pointer"
      >
        Prev
      </button>
      <span className="text-xs text-[var(--text-muted)]">
        {page + 1} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages - 1}
        className="px-3 py-1.5 text-xs rounded-md bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[var(--bg-card)] transition-colors cursor-pointer"
      >
        Next
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session card (redesigned)
// ---------------------------------------------------------------------------

function SessionCard({
  session,
  onClick,
  navProps,
}: {
  session: ConsoleSessionSummary;
  onClick: () => void;
  navProps?: ReturnType<UseGridKeyNavResult['getItemProps']>;
}) {
  const title = session.sessionTitle;
  const workflowLabel = session.workflowName ?? session.workflowId;
  const timeAgo = formatRelativeTime(session.lastModifiedMs);

  return (
    <ConsoleCard
      variant="list"
      onClick={onClick}
      tabIndex={navProps?.tabIndex}
      onKeyDown={navProps?.onKeyDown}
      onFocus={navProps?.onFocus}
      ref={navProps?.ref as React.Ref<HTMLButtonElement> | undefined}
      className="rounded-lg px-4 py-3"
    >
      {/* Row 1: Title + status + time */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)] line-clamp-1 group-hover:text-[var(--accent)] transition-colors">
            {title ?? workflowLabel ?? 'Unnamed session'}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{timeAgo}</span>
          {session.isAutonomous && session.isLive && (
            <BracketBadge
              label="LIVE"
              pulse={true}
              color="#f4c430"
              aria-label="Autonomous session actively running"
            />
          )}
          <HealthBadge health={session.health} />
          <StatusBadge status={session.status} />
        </div>
      </div>

      {/* Row 2: Metadata chips */}
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        {title && workflowLabel && (
          <Chip>{workflowLabel}</Chip>
        )}
        {session.gitBranch && (
          <Chip icon="branch">{session.gitBranch}</Chip>
        )}
        <Chip icon="graph">{session.nodeCount}N / {session.edgeCount}E</Chip>
        {session.tipCount > 1 && (
          <Chip icon="fork">{session.tipCount} tips</Chip>
        )}
        {session.hasUnresolvedGaps && (
          <span className="inline-flex items-center gap-1 text-[10px] text-[var(--warning)]">
            gaps
          </span>
        )}
      </div>

      {/* Row 3: Session ID (subtle) */}
      <div className="mt-1.5 font-mono text-[10px] text-[var(--text-muted)] opacity-60 group-hover:opacity-100 transition-opacity truncate">
        {session.sessionId}
      </div>
    </ConsoleCard>
  );
}

// ---------------------------------------------------------------------------
// Chip (inline metadata badge)
// ---------------------------------------------------------------------------

const CHIP_ICONS = {
  branch: (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
    </svg>
  ),
  graph: (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.5 2.5 0 0 1 2 11.5Z" />
    </svg>
  ),
  fork: (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
      <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm2.122-.75a2.25 2.25 0 1 0-3.244 0A2.5 2.5 0 0 0 2 5v5.5A2.5 2.5 0 0 0 4.5 13h3.25a.75.75 0 0 0 0-1.5H4.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H8.75Z" />
    </svg>
  ),
} as const;

function Chip({ children, icon }: { children: React.ReactNode; icon?: keyof typeof CHIP_ICONS }) {
  return (
    <MetaChip className="gap-1 rounded text-[var(--text-muted)] max-w-[200px] truncate">
      {icon && CHIP_ICONS[icon]}
      {children}
    </MetaChip>
  );
}


// ---------------------------------------------------------------------------
// Session tree view
// ---------------------------------------------------------------------------

function SessionTreeView({
  sessionTree,
  onSelectSession,
}: {
  readonly sessionTree: SessionTree;
  readonly onSelectSession: (id: string) => void;
}) {
  const { roots } = sessionTree;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    for (const node of roots) {
      if (node.children.length > 0 && node.session.status === 'in_progress') {
        initial.add(node.session.sessionId);
      }
    }
    return initial;
  });

  const toggleExpand = (sessionId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) { next.delete(sessionId); } else { next.add(sessionId); }
      return next;
    });
  };

  if (roots.length === 0) {
    return <div className="text-center py-12 text-[var(--text-muted)] text-sm">No sessions found</div>;
  }

  return (
    <div className="space-y-2">
      {roots.map((node) => (
        <SessionTreeRow
          key={node.session.sessionId}
          node={node}
          isExpanded={expandedIds.has(node.session.sessionId)}
          onToggle={() => toggleExpand(node.session.sessionId)}
          onSelectSession={onSelectSession}
        />
      ))}
    </div>
  );
}

function SessionTreeRow({
  node,
  isExpanded,
  onToggle,
  onSelectSession,
}: {
  readonly node: SessionTreeNode;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly onSelectSession: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div className="flex items-start gap-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} children of ${node.session.sessionTitle ?? node.session.sessionId}`}
            className="flex items-center justify-center w-11 h-11 shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            <span
              className="text-xs transition-transform duration-150"
              style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              &#x25b6;
            </span>
          </button>
        ) : (
          <div className="w-11 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <CoordinatorCard
            session={node.session}
            hasChildren={hasChildren}
            isExpanded={isExpanded}
            childCount={node.children.length}
            onClick={() => onSelectSession(node.session.sessionId)}
          />
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div className="ml-11">
          <TreeLine>
            <div className="space-y-2 pt-1">
              {node.children.map((child) => (
                <ChildSessionCard
                  key={child.sessionId}
                  session={child}
                  onClick={() => onSelectSession(child.sessionId)}
                />
              ))}
            </div>
          </TreeLine>
        </div>
      )}
    </div>
  );
}

function CoordinatorCard({
  session,
  hasChildren,
  isExpanded,
  childCount,
  onClick,
}: {
  readonly session: ConsoleSessionSummary;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  readonly childCount: number;
  readonly onClick: () => void;
}) {
  const title = session.sessionTitle;
  const workflowLabel = session.workflowName ?? session.workflowId;
  const timeAgo = formatRelativeTime(session.lastModifiedMs);

  return (
    <ConsoleCard
      variant="list"
      onClick={onClick}
      className="rounded-lg px-4 py-3"
      style={{ borderLeft: '3px solid var(--accent)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)] line-clamp-1 group-hover:text-[var(--accent)] transition-colors">
            {title ?? workflowLabel ?? 'Unnamed session'}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{timeAgo}</span>
          {session.isAutonomous && session.isLive && (
            <BracketBadge label="LIVE" pulse={true} color="#f4c430" />
          )}
          <BracketBadge label="COORD" color="var(--accent)" />
          <StatusBadge status={session.status} />
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        {title && workflowLabel && (
          <MetaChip className="rounded text-[var(--text-muted)] max-w-[200px] truncate">{workflowLabel}</MetaChip>
        )}
        {hasChildren && !isExpanded && (
          <MetaChip className="rounded text-[var(--accent)]">{childCount} {childCount === 1 ? 'child' : 'children'}</MetaChip>
        )}
      </div>
      <div className="mt-1.5 font-mono text-[10px] text-[var(--text-muted)] opacity-60 group-hover:opacity-100 transition-opacity truncate">
        {session.sessionId}
      </div>
    </ConsoleCard>
  );
}

function ChildSessionCard({
  session,
  onClick,
}: {
  readonly session: ConsoleSessionSummary;
  readonly onClick: () => void;
}) {
  const title = session.sessionTitle;
  const workflowLabel = session.workflowName ?? session.workflowId;
  const timeAgo = formatRelativeTime(session.lastModifiedMs);

  return (
    <ConsoleCard variant="list" onClick={onClick} className="rounded-lg px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)] line-clamp-1 group-hover:text-[var(--accent)] transition-colors">
            {title ?? workflowLabel ?? 'Unnamed session'}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{timeAgo}</span>
          <StatusBadge status={session.status} />
        </div>
      </div>
      <div className="mt-1 font-mono text-[10px] text-[var(--text-muted)] opacity-60 truncate">
        {session.sessionId}
      </div>
    </ConsoleCard>
  );
}
