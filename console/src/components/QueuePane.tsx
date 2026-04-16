/**
 * QueuePane
 *
 * Right column of the AUTO tab. Shows autonomous sessions (isAutonomous === true):
 * - Status band: [N RUNNING] [N BLOCKED] [N COMPLETED]
 * - Expandable session rows with recap and DAG link
 *
 * Pure presenter: uses useSessionList() hook for data.
 */

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BracketBadge } from './BracketBadge';
import { MonoLabel } from './MonoLabel';
import { StatusBadge } from './StatusBadge';
import { useSessionList } from '../api/hooks';
import { formatRelativeTime } from '../utils/time';
import type { ConsoleSessionSummary } from '../api/types';

// ---------------------------------------------------------------------------
// Status counts
// ---------------------------------------------------------------------------

function countByStatus(sessions: readonly ConsoleSessionSummary[]) {
  let running = 0;
  let blocked = 0;
  let completed = 0;

  for (const s of sessions) {
    if (s.status === 'in_progress') running++;
    else if (s.status === 'blocked') blocked++;
    else if (s.status === 'complete' || s.status === 'complete_with_gaps') completed++;
  }

  return { running, blocked, completed };
}

// ---------------------------------------------------------------------------
// QueuePane
// ---------------------------------------------------------------------------

export function QueuePane() {
  const { data, isLoading, isError } = useSessionList();

  const allSessions = data?.sessions ?? [];
  const autonomousSessions = allSessions.filter((s) => s.isAutonomous);

  const { running, blocked, completed } = countByStatus(autonomousSessions);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[var(--text-secondary)] text-sm">Loading sessions...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-[var(--error)] bg-[var(--bg-card)] rounded-lg p-4 text-sm">
        Failed to load sessions
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <MonoLabel color="var(--accent)">Queue</MonoLabel>
      </div>

      {/* Status band */}
      <div className="flex items-center gap-3 flex-wrap">
        <StatusBandChip count={running} label="RUNNING" color="var(--accent)" pulse />
        <StatusBandChip count={blocked} label="BLOCKED" color="var(--blocked)" />
        <StatusBandChip count={completed} label="COMPLETED" color="var(--success)" />
      </div>

      {/* Session list */}
      {autonomousSessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-[var(--text-secondary)] text-sm">No autonomous sessions yet</p>
          <p className="text-[var(--text-muted)] text-xs mt-1">
            Dispatch a workflow from the left pane to start.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {autonomousSessions.map((session) => (
            <QueueRow key={session.sessionId} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status band chip
// ---------------------------------------------------------------------------

function StatusBandChip({
  count,
  label,
  color,
  pulse,
}: {
  count: number;
  label: string;
  color: string;
  pulse?: boolean;
}) {
  return (
    <BracketBadge
      label={`${count} ${label}`}
      color={count > 0 ? color : 'var(--text-muted)'}
      pulse={pulse && count > 0}
    />
  );
}

// ---------------------------------------------------------------------------
// QueueRow
// ---------------------------------------------------------------------------

function QueueRow({ session }: { session: ConsoleSessionSummary }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();

  const title = session.sessionTitle ?? session.workflowName ?? session.workflowId ?? 'Unnamed session';
  const timeAgo = formatRelativeTime(session.lastModifiedMs);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
      {/* Row header -- clickable to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left cursor-pointer hover:bg-[var(--bg-secondary)] transition-colors group"
      >
        {/* Chevron */}
        <span
          className="text-[var(--text-muted)] text-xs transition-transform duration-150 shrink-0"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          ▶
        </span>

        {/* Title */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
            {title}
          </div>
          <div className="font-mono text-[10px] text-[var(--text-muted)] opacity-60 truncate">
            {session.sessionId}
          </div>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{timeAgo}</span>
          {session.isLive && (
            <BracketBadge label="LIVE" pulse color="var(--accent)" aria-label="Actively running" />
          )}
          <StatusBadge status={session.status} />
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-[var(--border)] pt-3 space-y-3">
          {/* Recap snippet */}
          {session.recapSnippet ? (
            <div className="text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap leading-relaxed">
              {session.recapSnippet}
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">No recap available yet.</div>
          )}

          {/* Open in DAG link */}
          <button
            onClick={() => void navigate({ to: '/session/$sessionId', params: { sessionId: session.sessionId } })}
            className="cursor-pointer"
          >
            <BracketBadge label="OPEN IN DAG" color="var(--accent)" />
          </button>
        </div>
      )}
    </div>
  );
}
