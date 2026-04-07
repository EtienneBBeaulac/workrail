import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSessionList } from '../api/hooks';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBadge } from '../components/HealthBadge';
import { MetaChip } from '../components/MetaChip';
import type { ConsoleSessionSummary, ConsoleSessionStatus } from '../api/types';
import { formatRelativeTime } from '../utils/time';

interface Props {
  onSelectSession: (sessionId: string) => void;
  /** Pre-seed the search field (e.g. branch name from worktree click-through). */
  initialSearch?: string;
}

// ---------------------------------------------------------------------------
// Sort / group axis definitions
//
// Adding a new sort or group axis requires a single entry in SORT_AXES or
// GROUP_AXES -- no edits to switch statements or separate type unions.
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | ConsoleSessionStatus;

const STATUS_SORT_ORDER: Record<ConsoleSessionStatus, number> = {
  in_progress: 0,
  blocked: 1,
  dormant: 2,
  complete_with_gaps: 3,
  complete: 4,
};

// Parameterised so that `value` is inferred as a literal type rather than
// widened to `string`. This lets TypeScript catch typos in SortField/GroupBy
// assignments at compile time.
interface SortAxisDef<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly compareFn: (a: ConsoleSessionSummary, b: ConsoleSessionSummary) => number;
}

interface GroupAxisDef<V extends string> {
  readonly value: V;
  readonly label: string;
  // Returns the group key for a session, or null for the "ungrouped" sentinel.
  readonly keyFn: ((s: ConsoleSessionSummary) => string) | null;
  // Optional comparator for group labels. Defaults to localeCompare.
  readonly groupCompareFn?: (a: string, b: string) => number;
}

const SORT_AXES = [
  {
    value: 'recent' as const,
    label: 'Recent',
    compareFn: (a: ConsoleSessionSummary, b: ConsoleSessionSummary) => b.lastModifiedMs - a.lastModifiedMs,
  },
  {
    value: 'status' as const,
    label: 'Status',
    compareFn: (a: ConsoleSessionSummary, b: ConsoleSessionSummary) =>
      STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status] || b.lastModifiedMs - a.lastModifiedMs,
  },
  {
    value: 'workflow' as const,
    label: 'Workflow',
    compareFn: (a: ConsoleSessionSummary, b: ConsoleSessionSummary) =>
      (a.workflowName ?? a.workflowId ?? '').localeCompare(b.workflowName ?? b.workflowId ?? '') ||
      b.lastModifiedMs - a.lastModifiedMs,
  },
  {
    value: 'nodes' as const,
    label: 'Node count',
    compareFn: (a: ConsoleSessionSummary, b: ConsoleSessionSummary) =>
      b.nodeCount - a.nodeCount || b.lastModifiedMs - a.lastModifiedMs,
  },
] as const satisfies readonly SortAxisDef<string>[];

const GROUP_AXES = [
  { value: 'none' as const, label: 'No grouping', keyFn: null },
  { value: 'workflow' as const, label: 'Workflow', keyFn: (s: ConsoleSessionSummary) => s.workflowName ?? s.workflowId ?? 'Unknown workflow' },
  {
    value: 'status' as const,
    label: 'Status',
    keyFn: (s: ConsoleSessionSummary) => s.status,
    // Sort status groups by severity order rather than alphabetically.
    groupCompareFn: (a: string, b: string) =>
      (STATUS_SORT_ORDER[a as ConsoleSessionStatus] ?? 99) - (STATUS_SORT_ORDER[b as ConsoleSessionStatus] ?? 99),
  },
  { value: 'branch' as const, label: 'Branch', keyFn: (s: ConsoleSessionSummary) => s.gitBranch ?? 'No branch' },
] as const satisfies readonly GroupAxisDef<string>[];

type SortField = (typeof SORT_AXES)[number]['value'];
type GroupBy = (typeof GROUP_AXES)[number]['value'];

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'dormant', label: 'Dormant' },
  { value: 'complete', label: 'Complete' },
  { value: 'complete_with_gaps', label: 'Gaps' },
  { value: 'blocked', label: 'Blocked' },
];

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function filterSessions(
  sessions: readonly ConsoleSessionSummary[],
  search: string,
  statusFilter: StatusFilter,
): ConsoleSessionSummary[] {
  let filtered = [...sessions];

  if (statusFilter !== 'all') {
    filtered = filtered.filter((s) => s.status === statusFilter);
  }

  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter((s) =>
      (s.sessionTitle ?? '').toLowerCase().includes(q) ||
      (s.workflowName ?? '').toLowerCase().includes(q) ||
      (s.workflowId ?? '').toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q) ||
      (s.gitBranch ?? '').toLowerCase().includes(q)
    );
  }

  return filtered;
}

function sortSessions(sessions: ConsoleSessionSummary[], sort: SortField): ConsoleSessionSummary[] {
  const axis = SORT_AXES.find((a) => a.value === sort) ?? SORT_AXES[0];
  return [...sessions].sort(axis.compareFn);
}

function groupSessions(
  sessions: ConsoleSessionSummary[],
  groupBy: GroupBy,
): { label: string; sessions: ConsoleSessionSummary[] }[] {
  const axis = GROUP_AXES.find((a) => a.value === groupBy) ?? GROUP_AXES[0];
  if (!axis.keyFn) return [{ label: '', sessions }];

  const groups = new Map<string, ConsoleSessionSummary[]>();

  for (const s of sessions) {
    const key = axis.keyFn(s);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  // Cast to the base interface to access the optional groupCompareFn field.
  // `as const satisfies` narrows each element to its exact literal shape, so
  // the optional field is only present in the union members that define it.
  const compareFn = (axis as GroupAxisDef<string>).groupCompareFn ?? ((a: string, b: string) => a.localeCompare(b));
  return Array.from(groups.entries())
    .sort(([a], [b]) => compareFn(a, b))
    .map(([label, groupedSessions]) => ({ label, sessions: groupedSessions }));
}

// ---------------------------------------------------------------------------
// Debounce hook
// Separates UI-responsive input state from the computationally expensive
// filter/sort/group pipeline. Delays are applied only to the search field.
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [value, delayMs]);

  return debouncedValue;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function SessionList({ onSelectSession, initialSearch = '' }: Props) {
  const { data, isLoading, error } = useSessionList();

  const [search, setSearch] = useState(initialSearch);
  const [sort, setSort] = useState<SortField>('recent');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);

  // Debounce the search input so that filter/sort/group computation does not
  // fire on every keystroke. The raw `search` value drives the input display;
  // `debouncedSearch` drives the data pipeline.
  const debouncedSearch = useDebounce(search, 200);

  // Reset page when filters change
  const handleSearchChange = useCallback((v: string) => { setSearch(v); setPage(0); }, []);
  const handleSortChange = useCallback((v: SortField) => { setSort(v); setPage(0); }, []);
  const handleGroupChange = useCallback((v: GroupBy) => { setGroupBy(v); setPage(0); }, []);
  const handleStatusChange = useCallback((v: StatusFilter) => { setStatusFilter(v); setPage(0); }, []);

  const processed = useMemo(() => {
    if (!data) return { groups: [], total: 0, filtered: 0 };
    const filtered = filterSessions(data.sessions, debouncedSearch, statusFilter);
    const sorted = sortSessions(filtered, sort);
    const groups = groupSessions(sorted, groupBy);
    return { groups, total: data.sessions.length, filtered: filtered.length };
  }, [data, debouncedSearch, statusFilter, sort, groupBy]);

  // Status counts for filter pills
  const statusCounts = useMemo(() => {
    if (!data) return {} as Record<StatusFilter, number>;
    const counts: Record<string, number> = { all: data.sessions.length };
    for (const s of data.sessions) {
      counts[s.status] = (counts[s.status] ?? 0) + 1;
    }
    return counts as Record<StatusFilter, number>;
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[var(--text-secondary)] text-sm">Loading sessions...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-[var(--error)] bg-[var(--bg-card)] rounded-lg p-4">
        Failed to load sessions: {error.message}
      </div>
    );
  }

  if (!data || data.sessions.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-[var(--text-secondary)] text-lg">No v2 sessions found</p>
        <p className="text-[var(--text-muted)] text-sm mt-2">
          Sessions will appear here when workflows are executed with v2 tools enabled.
        </p>
      </div>
    );
  }

  // Flatten groups for pagination when not grouped
  const isGrouped = groupBy !== 'none';
  const pageStart = page * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;
  const totalPages = Math.ceil(processed.filtered / PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-[var(--text-primary)]">
          Sessions
          <span className="text-[var(--text-muted)] font-normal ml-2 text-sm">
            {processed.filtered === processed.total
              ? processed.total
              : `${processed.filtered} / ${processed.total}`}
          </span>
        </h2>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search sessions..."
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
          />
          {search && (
            <button
              onClick={() => handleSearchChange('')}
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
          options={SORT_AXES}
          onChange={handleSortChange}
        />

        {/* Group */}
        <ToolbarSelect
          label="Group"
          value={groupBy}
          options={GROUP_AXES}
          onChange={handleGroupChange}
        />
      </div>

      {/* Status filter pills */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTER_OPTIONS.map((opt) => {
          const count = statusCounts[opt.value] ?? 0;
          if (opt.value !== 'all' && count === 0) return null;
          const active = statusFilter === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleStatusChange(opt.value)}
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
      {processed.filtered === 0 ? (
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
          <div className="space-y-2">
            {processed.groups[0]?.sessions.slice(pageStart, pageEnd).map((session) => (
              <SessionCard
                key={session.sessionId}
                session={session}
                onClick={() => onSelectSession(session.sessionId)}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
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
  sessions: ConsoleSessionSummary[];
  sort: SortField;
  statusFilter: StatusFilter;
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

  const totalPages = Math.ceil(sessions.length / PAGE_SIZE);
  const pageStart = page * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;
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

function SessionCard({ session, onClick }: { session: ConsoleSessionSummary; onClick: () => void }) {
  const title = session.sessionTitle;
  const workflowLabel = session.workflowName ?? session.workflowId;
  const timeAgo = formatRelativeTime(session.lastModifiedMs);

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3 hover:border-[var(--accent)] transition-colors cursor-pointer group"
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
            ⚠ gaps
          </span>
        )}
      </div>

      {/* Row 3: Session ID (subtle) */}
      <div className="mt-1.5 font-mono text-[10px] text-[var(--text-muted)] opacity-60 group-hover:opacity-100 transition-opacity truncate">
        {session.sessionId}
      </div>
    </button>
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
