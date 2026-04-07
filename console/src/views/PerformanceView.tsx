import { useState, useMemo } from 'react';
import { usePerfToolCalls } from '../api/hooks';
import type { ToolCallTiming } from '../api/types';
import { formatRelativeTime } from '../utils/time';

// ---------------------------------------------------------------------------
// PerformanceView
// ---------------------------------------------------------------------------

export function PerformanceView() {
  const result = usePerfToolCalls();
  const [sortOrder, setSortOrder] = useState<'recent' | 'slowest'>('recent');

  if (result.state === 'loading') {
    return <PerfSkeleton />;
  }

  if (result.state === 'devModeOff') {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-[var(--text-secondary)] text-center max-w-md">
          Performance tracing is not active. Start the WorkRail server with{' '}
          <code className="font-mono">WORKRAIL_DEV=1</code> to enable tool call timing.
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
  readonly sortOrder: 'recent' | 'slowest';
  readonly onSortChange: (order: 'recent' | 'slowest') => void;
}) {
  const sorted = useMemo(() => {
    const copy = [...observations];
    if (sortOrder === 'recent') {
      copy.sort((a, b) => b.startedAtMs - a.startedAtMs);
    } else {
      copy.sort((a, b) => b.durationMs - a.durationMs);
    }
    return copy;
  }, [observations, sortOrder]);

  const maxDuration = useMemo(
    () => (sorted.length > 0 ? Math.max(...sorted.map((o) => o.durationMs)) : 0),
    [sorted],
  );

  const errorCount = observations.filter(
    (o) => o.outcome === 'error' || o.outcome === 'unknown_tool',
  ).length;

  const avgMs =
    observations.length > 0
      ? Math.round(observations.reduce((sum, o) => sum + o.durationMs, 0) / observations.length)
      : null;

  const lastCallMs =
    observations.length > 0 ? Math.max(...observations.map((o) => o.startedAtMs)) : null;

  return (
    <div className="space-y-3">
      {/* Summary line */}
      <p className="text-sm text-[var(--text-secondary)]">
        {observations.length} recorded
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

      {/* Sort controls */}
      <div role="group" aria-label="Sort order" className="flex items-center gap-1">
        <SortButton
          label="Recent first"
          isActive={sortOrder === 'recent'}
          onClick={() => onSortChange('recent')}
        />
        <SortButton
          label="Slowest first"
          isActive={sortOrder === 'slowest'}
          onClick={() => onSortChange('slowest')}
        />
      </div>

      {/* Table */}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-[var(--text-muted)] border-b border-[var(--border)]">
            <th className="text-left py-2 pr-4 font-medium" style={{ minWidth: '180px' }}>
              Tool
            </th>
            <th className="text-left py-2 pr-4 font-medium" style={{ width: '220px' }}>
              Duration
            </th>
            <th className="text-left py-2 pr-4 font-medium" style={{ width: '100px' }}>
              Started
            </th>
            <th className="text-left py-2 font-medium">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={4}
                className="py-8 text-center text-sm text-[var(--text-muted)]"
              >
                No tool calls recorded yet. Run a workflow to see timing data.
              </td>
            </tr>
          ) : (
            sorted.map((obs, i) => (
              <TimingRow key={i} obs={obs} maxDuration={maxDuration} />
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
  const isErrorRow = obs.outcome === 'error' || obs.outcome === 'unknown_tool';
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

type Outcome = 'success' | 'error' | 'unknown_tool';

const OUTCOME_CONFIG: Record<
  Outcome,
  { readonly color: string; readonly label: string }
> = {
  success: { color: 'var(--success)', label: 'OK' },
  error: { color: 'var(--error)', label: 'Error' },
  unknown_tool: { color: 'var(--warning)', label: 'Unknown' },
};

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
// SortButton
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
      onClick={onClick}
      aria-pressed={isActive}
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
