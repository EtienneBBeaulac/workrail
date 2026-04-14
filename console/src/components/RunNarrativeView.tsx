/**
 * RunNarrativeView -- renders the execution trace narrative for a single run.
 *
 * Shows why steps ran, were skipped, or repeated by surfacing the engine's
 * executionTraceSummary in a human-readable list.
 *
 * Responsibilities:
 * - Context facts chip row (pinned, hidden when empty)
 * - Scrollable ordered list of trace entries sorted by recordedAtEventIndex
 * - Loop group collapsing (entered_loop/exited_loop pairs absorbed into groups)
 * - Badge vocabulary per item kind
 * - End marker (complete / blocked / in_progress)
 * - Auto-scroll to bottom when near bottom; [ N NEW ] sticky button when scrolled up
 * - Empty state when no items
 */
import { useEffect, useRef, useState } from 'react';
import type {
  ConsoleExecutionTraceSummary,
  ConsoleExecutionTraceItem,
  ConsoleRunStatus,
} from '../api/types';
import {
  groupTraceEntries,
  isConditionPassed,
  type LoopGroup,
} from '../views/session-detail-use-cases';
import { TraceBadge } from './TraceBadge';
import { camelToSpacedUpper } from '../utils/format';

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

interface Props {
  readonly summary: ConsoleExecutionTraceSummary;
  readonly runStatus: ConsoleRunStatus;
}

// ---------------------------------------------------------------------------
// Badge vocabulary
// ---------------------------------------------------------------------------

interface BadgeConfig {
  readonly label: string;
  readonly color: string;
  readonly bgColor: string;
}

function getBadgeConfig(item: ConsoleExecutionTraceItem): BadgeConfig {
  switch (item.kind) {
    case 'selected_next_step':
      return { label: 'STEP', color: 'var(--accent)', bgColor: 'rgba(244, 196, 48, 0.12)' };
    case 'evaluated_condition': {
      const isTrue = isConditionPassed(item);
      return isTrue
        ? { label: 'CONDITION', color: 'var(--success)', bgColor: 'rgba(34, 197, 94, 0.12)' }
        : { label: 'CONDITION', color: 'var(--text-muted)', bgColor: 'rgba(123, 141, 167, 0.10)' };
    }
    case 'detected_non_tip_advance':
      return { label: 'FORK', color: 'var(--warning)', bgColor: 'rgba(251, 146, 60, 0.12)' };
    case 'divergence':
      return { label: 'DIVERGE', color: 'var(--error)', bgColor: 'rgba(239, 68, 68, 0.12)' };
    case 'entered_loop':
    case 'exited_loop':
      return { label: 'LOOP', color: 'var(--accent)', bgColor: 'rgba(0, 240, 255, 0.10)' };
    case 'context_fact':
      return { label: 'FACT', color: 'var(--text-muted)', bgColor: 'rgba(123, 141, 167, 0.10)' };
    default:
      return { label: 'INFO', color: 'var(--text-secondary)', bgColor: 'rgba(123, 141, 167, 0.08)' };
  }
}

// ---------------------------------------------------------------------------
// Loop group component
// ---------------------------------------------------------------------------

function LoopGroupEntry({ group }: { group: LoopGroup }) {
  const [expanded, setExpanded] = useState(group.iterationCount <= 3);
  const n = group.iterationCount;

  return (
    <li className="flex flex-col gap-1 py-1.5 border-b border-[var(--border)] last:border-0">
      <div className="flex items-start gap-3">
        <span
          className="shrink-0 inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.20em]"
          style={{
            color: 'var(--accent)',
            backgroundColor: 'rgba(0, 240, 255, 0.10)',
            border: '1px solid rgba(0, 240, 255, 0.25)',
          }}
        >
          LOOP: {n}
        </span>
        <span className="text-xs text-[var(--text-secondary)] leading-relaxed flex-1">
          {group.enteredItem.summary}
        </span>
        <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">
          #{group.enteredItem.recordedAtEventIndex}
        </span>
      </div>
      <div className="text-[10px] font-mono text-[var(--text-muted)] pl-[calc(theme(spacing.2)+theme(spacing.3)+4ch)]">
        stopped when: {group.exitedItem.summary}
      </div>
      {group.innerItems.length > 0 && (
        <div className="pl-4 mt-1">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="font-mono text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {expanded ? '[ collapse ]' : `[ expand ${group.innerItems.length} inner items ]`}
          </button>
          {expanded && (
            <ol className="mt-1 space-y-1">
              {group.innerItems.map((inner) => {
                const cfg = getBadgeConfig(inner);
                return (
                  <li key={inner.recordedAtEventIndex} className="flex items-start gap-2 text-xs text-[var(--text-muted)]">
                    <TraceBadge label={cfg.label} color={cfg.color} bgColor={cfg.bgColor} />
                    <span className="flex-1 leading-relaxed">{inner.summary}</span>
                    <span className="font-mono text-[10px] shrink-0">#{inner.recordedAtEventIndex}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// End marker
// ---------------------------------------------------------------------------

function EndMarker({ runStatus }: { runStatus: ConsoleRunStatus }) {
  const config: { readonly text: string; readonly color: string } = (() => {
    switch (runStatus) {
      case 'complete':
      case 'complete_with_gaps':
        return { text: '// ------ RUN COMPLETE ------', color: 'var(--success)' };
      case 'blocked':
        return { text: '// ------ RUN BLOCKED ------', color: 'var(--error)' };
      case 'in_progress':
        return { text: '// ------ IN PROGRESS ------', color: 'var(--accent)' };
    }
  })();

  return (
    <div
      className="font-mono text-[11px] text-center py-3 mt-1"
      style={{ color: config.color }}
    >
      {config.text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context facts chip strip
// ---------------------------------------------------------------------------

function ContextFactsRow({ facts }: { facts: ConsoleExecutionTraceSummary['contextFacts'] }) {
  if (facts.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-[var(--border)] bg-[rgba(0,240,255,0.03)]">
      {facts.map((fact) => (
        <div
          key={fact.key}
          className="inline-flex items-center gap-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em]"
          style={{
            color: 'var(--text-muted)',
            backgroundColor: 'rgba(123, 141, 167, 0.08)',
            border: '1px solid rgba(123, 141, 167, 0.20)',
          }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>{camelToSpacedUpper(fact.key)}</span>
          <span style={{ color: 'var(--text-muted)' }}>//</span>
          <span style={{ color: 'var(--text-primary)' }}>{fact.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunNarrativeView
// ---------------------------------------------------------------------------

const NEAR_BOTTOM_THRESHOLD_PX = 80;

export function RunNarrativeView({ summary, runStatus }: Props) {
  const entries = groupTraceEntries(summary.items);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevItemCountRef = useRef(entries.length);
  const [newItemCount, setNewItemCount] = useState(0);
  const [isNearBottom, setIsNearBottom] = useState(true);

  // Auto-scroll to bottom when near bottom and new items arrive
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const prevCount = prevItemCountRef.current;
    const delta = entries.length - prevCount;
    prevItemCountRef.current = entries.length;

    if (delta <= 0) return;

    if (isNearBottom) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      setNewItemCount(0);
    } else {
      setNewItemCount((prev) => prev + delta);
    }
  }, [entries.length, isNearBottom]);

  // Track scroll position to determine if user is near the bottom
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      setIsNearBottom(distFromBottom <= NEAR_BOTTOM_THRESHOLD_PX);
      if (distFromBottom <= NEAR_BOTTOM_THRESHOLD_PX) {
        setNewItemCount(0);
      }
    }

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    setNewItemCount(0);
  };

  if (entries.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="font-mono text-xs text-[var(--text-muted)]">
          // TRACE -- no routing decisions were recorded for this run
        </span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg-primary)] relative">
      <ContextFactsRow facts={summary.contextFacts} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2">
        <ol className="space-y-0">
          {entries.map((entry) => {
            if (entry.kind === 'loop_group') {
              return <LoopGroupEntry key={entry.enteredItem.recordedAtEventIndex} group={entry} />;
            }
            const { item } = entry;
            const cfg = getBadgeConfig(item);
            return (
              <li
                key={item.recordedAtEventIndex}
                className="flex items-start gap-3 py-1.5 border-b border-[var(--border)] last:border-0"
              >
                <TraceBadge label={cfg.label} color={cfg.color} bgColor={cfg.bgColor} />
                <span className="text-xs text-[var(--text-secondary)] leading-relaxed flex-1">
                  {item.summary}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">
                  #{item.recordedAtEventIndex}
                </span>
              </li>
            );
          })}
        </ol>
        <EndMarker runStatus={runStatus} />
      </div>

      {!isNearBottom && newItemCount > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.20em] px-3 py-1.5 transition-colors"
          style={{
            backgroundColor: 'rgba(0, 240, 255, 0.15)',
            border: '1px solid rgba(0, 240, 255, 0.35)',
            color: 'var(--accent)',
          }}
        >
          [ {newItemCount} NEW ]
        </button>
      )}
    </div>
  );
}
