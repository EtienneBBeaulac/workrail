import { useState, useMemo } from 'react';
import { usePerfToolCalls } from '../api/hooks';
import type { ToolCallTiming } from '../api/types';
import { formatRelativeTime } from '../utils/time';

// ---------------------------------------------------------------------------
// Column configuration (A1)
// Drives thead rendering; TimingRow still renders hardcoded cells but this
// documents the column contract and makes header generation extend-safe.
// ---------------------------------------------------------------------------

interface ColumnDef {
  readonly key: string;
  readonly label: string;
  readonly width?: string;
  readonly minWidth?: string;
}

const COLUMNS: readonly ColumnDef[] = [
  { key: 'tool', label: 'Tool', minWidth: '180px' },
  { key: 'duration', label: 'Duration', width: '220px' },
  { key: 'started', label: 'Started', width: '100px' },
  { key: 'outcome', label: 'Outcome' },
];

// ---------------------------------------------------------------------------
// Sort configuration (A2)
// ---------------------------------------------------------------------------

type SortOrder = 'recent' | 'slowest';

interface SortOption {
  readonly value: SortOrder;
  readonly label: string;
  readonly compareFn: (a: ToolCallTiming, b: ToolCallTiming) => number;
}

const SORT_OPTIONS: readonly SortOption[] = [
  { value: 'recent', label: 'Recent first', compareFn: (a, b) => b.startedAtMs - a.startedAtMs },
  { value: 'slowest', label: 'Slowest first', compareFn: (a, b) => b.durationMs - a.durationMs },
];

// ---------------------------------------------------------------------------
// Outcome configuration (M6 single source of truth)
// ---------------------------------------------------------------------------

type Outcome = 'success' | 'error' | 'unknown_tool';

const OUTCOME_CONFIG: Record<
  Outcome,
  { readonly color: string; readonly label: string; readonly isError: boolean }
> = {
  success: { color: 'var(--success)', label: 'OK', isError: false },
  error: { color: 'var(--error)', label: 'Error', isError: true },
  unknown_tool: { color: 'var(--warning)', label: 'Unknown', isError: true },
};

// ---------------------------------------------------------------------------
// PerformanceView
// ---------------------------------------------------------------------------

export function PerformanceView() {
  const result = usePerfToolCalls();
  const [sortOrder, setSortOrder] = useState<SortOrder>('recent');

  if (result.state === 'loading') {
    return <PerfSkeleton />;
  }

  if (result.state === 'devModeOff') {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-[var(--text-muted)] text-center">
          nothing to see here
        </p>
      </div>
    );
  }

  if (result.state === 'error') {
    return (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-[var(--error)]">{result.message}</p>
        <button
          type="button"
          onClick={result.retry}
          className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  const { observations } = result.data;

  return (
    <PerfContent
      observations={observations}
      sortOrder={sortOrder}
      onSortChange={setSortOrder}
    />
  );
}

// ---------------------------------------------------------------------------
// PerfContent -- populated + empty state
// ---------------------------------------------------------------------------

function PerfContent({
  observations,
  sortOrder,
  onSortChange,
}: {
  readonly observations: readonly ToolCallTiming[];
  readonly sortOrder: SortOrder;
  readonly onSortChange: (order: SortOrder) => void;
}) {
  const sorted = useMemo(() => {
    // A2: find the matching SortOption and use its compareFn
    const option = SORT_OPTIONS.find((o) => o.value === sortOrder)!;
    return [...observations].sort(option.compareFn);
  }, [observations, sortOrder]);

  // M2: use reduce to avoid Math.max(...spread) latent crash on large arrays
  const maxDuration = useMemo(
    () => sorted.reduce((max, o) => Math.max(max, o.durationMs), 0),
    [sorted],
  );

  const errorCount = observations.filter((o) => OUTCOME_CONFIG[o.outcome].isError).length;

  const avgMs =
    observations.length > 0
      ? Math.round(observations.reduce((sum, o) => sum + o.durationMs, 0) / observations.length)
      : null;

  // M2: use reduce to avoid Math.max(...spread) latent crash on large arrays
  const lastCallMs =
    observations.length > 0
      ? observations.reduce((max, o) => Math.max(max, o.startedAtMs), 0)
      : null;

  // M4: show truncation indicator when ring buffer contains more than the window
  const countLabel = `${observations.length} recorded`;

  return (
    <div className="space-y-3">
      {/* Summary line */}
      <p className="text-sm text-[var(--text-secondary)]">
        {countLabel}
        {' | '}
        <span
          style={{ color: errorCount > 0 ? 'var(--error)' : 'var(--text-muted)' }}
        >
          {errorCount} errors
        </span>
        {' | '}
        avg {avgMs !== null ? `${avgMs}ms` : '--'}
        {' | '}
        last call {lastCallMs !== null ? formatRelativeTime(lastCallMs) : 'no calls yet'}
      </p>

      {/* Sort controls (M5: radiogroup for mutually-exclusive selection) */}
      <div role="radiogroup" aria-label="Sort order" className="flex items-center gap-1">
        {SORT_OPTIONS.map((opt) => (
          <SortButton
            key={opt.value}
            label={opt.label}
            isActive={sortOrder === opt.value}
            onClick={() => onSortChange(opt.value)}
          />
        ))}
      </div>

      {/* Table */}
      <table className="w-full text-sm border-collapse">
        <thead>
          {/* A1: headers driven from COLUMNS; P1: scope="col" on every th */}
          <tr className="text-xs text-[var(--text-muted)] border-b border-[var(--border)]">
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                scope="col"
                className="text-left py-2 pr-4 font-medium"
                style={{ width: col.width, minWidth: col.minWidth }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={COLUMNS.length}
                className="py-8 text-center text-sm text-[var(--text-muted)]"
              >
                No tool calls recorded yet. Run a workflow to see timing data.
              </td>
            </tr>
          ) : (
            sorted.map((obs, i) => (
              // M1: stable composite key; i as tiebreaker for same-tool same-ms edge case
              <TimingRow key={`${obs.startedAtMs}-${obs.toolName}-${i}`} obs={obs} maxDuration={maxDuration} />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimingRow
// ---------------------------------------------------------------------------

function TimingRow({
  obs,
  maxDuration,
}: {
  readonly obs: ToolCallTiming;
  readonly maxDuration: number;
}) {
  // M6: derive isError from OUTCOME_CONFIG (single source of truth)
  const isErrorRow = OUTCOME_CONFIG[obs.outcome].isError;
  const barWidth =
    maxDuration > 0 ? Math.round((obs.durationMs / maxDuration) * 120) : 0;

  return (
    <tr
      className="border-b border-[var(--border)] hover:bg-[var(--bg-card)] transition-colors"
      style={{
        borderLeft: isErrorRow
          ? '2px solid var(--error)'
          : '2px solid transparent',
      }}
    >
      {/* Tool name */}
      <td
        className="py-2 pr-4 font-mono text-[var(--text-primary)] overflow-hidden text-ellipsis"
        title={obs.toolName}
        style={{ minWidth: '180px', maxWidth: '240px' }}
      >
        <span className="block truncate">{obs.toolName}</span>
      </td>

      {/* Duration + bar */}
      <td className="py-2 pr-4" style={{ width: '220px' }}>
        <span className="font-mono text-[var(--text-primary)]">{obs.durationMs}ms</span>
        <div
          aria-hidden="true"
          className="h-1 rounded mt-1"
          style={{
            backgroundColor: 'var(--accent)',
            width: `${barWidth}px`,
            maxWidth: '120px',
          }}
        />
      </td>

      {/* Started */}
      <td className="py-2 pr-4 text-[var(--text-secondary)]" style={{ width: '100px' }}>
        {formatRelativeTime(obs.startedAtMs)}
      </td>

      {/* Outcome pill */}
      <td className="py-2">
        <OutcomePill outcome={obs.outcome} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// OutcomePill
// ---------------------------------------------------------------------------

function OutcomePill({ outcome }: { readonly outcome: Outcome }) {
  const config = OUTCOME_CONFIG[outcome];
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-medium"
      style={{
        color: config.color,
        backgroundColor: `color-mix(in srgb, ${config.color} 12%, transparent)`,
      }}
    >
      {config.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SortButton (M5: role="radio" + aria-checked for mutually-exclusive group)
// ---------------------------------------------------------------------------

function SortButton({
  label,
  isActive,
  onClick,
}: {
  readonly label: string;
  readonly isActive: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      onClick={onClick}
      aria-checked={isActive}
      className={[
        'px-3 py-2 rounded text-xs font-medium min-w-[44px] transition-colors',
        isActive
          ? 'text-[var(--text-primary)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function PerfSkeleton() {
  return (
    <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading performance data">
      {/* Summary line skeleton */}
      <div className="h-4 w-64 rounded bg-[var(--bg-tertiary)]" />

      {/* Controls skeleton */}
      <div className="flex gap-1">
        <div className="h-8 w-24 rounded bg-[var(--bg-tertiary)]" />
        <div className="h-8 w-24 rounded bg-[var(--bg-tertiary)]" />
      </div>

      {/* Table header skeleton */}
      <div className="flex gap-4 border-b border-[var(--border)] pb-2">
        <div className="h-3 w-20 rounded bg-[var(--bg-tertiary)]" />
        <div className="h-3 w-16 rounded bg-[var(--bg-tertiary)]" />
        <div className="h-3 w-14 rounded bg-[var(--bg-tertiary)]" />
        <div className="h-3 w-14 rounded bg-[var(--bg-tertiary)]" />
      </div>

      {/* 8 row skeletons */}
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex gap-4 py-2">
          <div className="h-4 rounded bg-[var(--bg-tertiary)]" style={{ minWidth: '180px', width: '180px' }} />
          <div className="space-y-1" style={{ width: '220px' }}>
            <div className="h-4 w-16 rounded bg-[var(--bg-tertiary)]" />
            <div className="h-1 w-20 rounded bg-[var(--bg-tertiary)]" />
          </div>
          <div className="h-4 w-16 rounded bg-[var(--bg-tertiary)]" style={{ width: '100px' }} />
          <div className="h-5 w-12 rounded bg-[var(--bg-tertiary)]" />
        </div>
      ))}
    </div>
  );
}
