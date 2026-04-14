/**
 * Pure use-case functions and constants for the SessionList view.
 *
 * No React imports. All functions are deterministic: same inputs always
 * produce the same output. These are the only place business logic lives
 * for the session list -- keep them here, not in hooks or components.
 *
 * Sort / group axis definitions:
 * Adding a new sort or group axis requires a single entry in SORT_AXES or
 * GROUP_AXES -- no edits to switch statements or separate type unions.
 */
import type { ConsoleSessionSummary, ConsoleSessionStatus } from '../api/types';

// ---------------------------------------------------------------------------
// Types (exported so reducer and ViewModel can import without duplication)
// ---------------------------------------------------------------------------

export type StatusFilter = 'all' | ConsoleSessionStatus;

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATUS_SORT_ORDER: Record<ConsoleSessionStatus, number> = {
  in_progress: 0,
  blocked: 1,
  dormant: 2,
  complete_with_gaps: 3,
  complete: 4,
};

export const SORT_AXES = [
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

export const GROUP_AXES = [
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

export type SortField = (typeof SORT_AXES)[number]['value'];
export type GroupBy = (typeof GROUP_AXES)[number]['value'];

export const STATUS_FILTER_OPTIONS: readonly { readonly value: StatusFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'dormant', label: 'Dormant' },
  { value: 'complete', label: 'Complete' },
  { value: 'complete_with_gaps', label: 'Gaps' },
  { value: 'blocked', label: 'Blocked' },
];

export const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Pure use-case functions
// ---------------------------------------------------------------------------

/**
 * Filters sessions by status and search query.
 *
 * Search matches against: sessionTitle, workflowName, workflowId, sessionId, gitBranch.
 * Returns a new array; does not mutate the input.
 */
export function filterSessions(
  sessions: readonly ConsoleSessionSummary[],
  search: string,
  statusFilter: StatusFilter,
): readonly ConsoleSessionSummary[] {
  let filtered: readonly ConsoleSessionSummary[] = sessions;

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

/**
 * Sorts sessions by the given sort axis.
 * Returns a new array; does not mutate the input.
 */
export function sortSessions(
  sessions: readonly ConsoleSessionSummary[],
  sort: SortField,
): readonly ConsoleSessionSummary[] {
  const axis = SORT_AXES.find((a) => a.value === sort) ?? SORT_AXES[0];
  return [...sessions].sort(axis.compareFn);
}

/**
 * Groups sessions by the given group axis.
 * Returns an array of { label, sessions } groups.
 * Does not mutate the input.
 */
export function groupSessions(
  sessions: readonly ConsoleSessionSummary[],
  groupBy: GroupBy,
): readonly { readonly label: string; readonly sessions: readonly ConsoleSessionSummary[] }[] {
  const axis = GROUP_AXES.find((a) => a.value === groupBy) ?? GROUP_AXES[0];
  if (!axis.keyFn) return [{ label: '', sessions }];

  const groups = new Map<string, ConsoleSessionSummary[]>();

  for (const s of sessions) {
    const key = (axis.keyFn as (s: ConsoleSessionSummary) => string)(s);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  // Cast to the base interface to access the optional groupCompareFn field.
  const compareFn = (axis as GroupAxisDef<string>).groupCompareFn ?? ((a: string, b: string) => a.localeCompare(b));
  return Array.from(groups.entries())
    .sort(([a], [b]) => compareFn(a, b))
    .map(([label, groupedSessions]) => ({ label, sessions: groupedSessions }));
}

/**
 * Computes per-status session counts from the FULL unfiltered session list.
 *
 * Invariant: this must always receive the complete session list, not the
 * post-filter subset. Status filter pills show counts for ALL sessions
 * regardless of the active filter.
 *
 * Returns a record mapping each StatusFilter value to its count.
 * 'all' is always the total session count.
 */
export function computeStatusCounts(
  sessions: readonly ConsoleSessionSummary[],
): Record<StatusFilter, number> {
  const counts: Record<string, number> = { all: sessions.length };
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  return counts as Record<StatusFilter, number>;
}
