import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkflowList } from '../api/hooks';
import type { ConsoleWorkflowSummary } from '../api/types';
import { CATALOG_TAGS, TAG_DISPLAY } from '../config/tags';
import { SectionHeader } from '../components/SectionHeader';
import { ConsoleCard } from '../components/ConsoleCard';
import { CutCornerBox } from '../components/CutCornerBox';
import { WorkflowDetail } from './WorkflowDetail';
import { useGridKeyNav, type UseGridKeyNavResult } from '../hooks/useGridKeyNav';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  readonly selectedTag: string | null;
  readonly onSelectTag: (tag: string | null) => void;
  readonly onSelectWorkflow: (workflowId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WorkflowGroup {
  readonly tagId: string | null;
  readonly label: string;
  readonly workflows: readonly ConsoleWorkflowSummary[];
}

/**
 * Groups workflows by their first recognized non-routines tag, in CATALOG_TAGS order.
 * Workflows with no recognized tag are placed in an "Other" group at the end.
 */
function groupWorkflowsByTag(workflows: readonly ConsoleWorkflowSummary[]): WorkflowGroup[] {
  const knownTagIds = new Set(CATALOG_TAGS.map((t) => t.id));

  const buckets = new Map<string, ConsoleWorkflowSummary[]>();
  const other: ConsoleWorkflowSummary[] = [];

  for (const w of workflows) {
    const firstKnownTag = w.tags.find((t) => t !== 'routines' && knownTagIds.has(t));
    if (firstKnownTag) {
      const bucket = buckets.get(firstKnownTag) ?? [];
      bucket.push(w);
      buckets.set(firstKnownTag, bucket);
    } else {
      other.push(w);
    }
  }

  const groups: WorkflowGroup[] = CATALOG_TAGS
    .filter((t) => buckets.has(t.id))
    .map((t) => ({ tagId: t.id, label: t.label, workflows: buckets.get(t.id)! }));

  if (other.length > 0) {
    groups.push({ tagId: null, label: 'Other', workflows: other });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// WorkflowsView
// ---------------------------------------------------------------------------

export function WorkflowsView({ selectedTag, onSelectTag, onSelectWorkflow: _onSelectWorkflow }: Props) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const modalPanelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isAnimatingRef = useRef(false);
  const pendingNavRef = useRef<number | null>(null);
  const [scanlineKey, setScanlineKey] = useState(0);
  const [crtOffset, setCrtOffset] = useState(0);
  const [contentAnimClass, setContentAnimClass] = useState('');
  const [borderFlashing, setBorderFlashing] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const { data, isLoading, isError, error, refetch } = useWorkflowList();

  // Issue #6: Restore focus to the card that opened the modal when it closes.
  useEffect(() => {
    if (!selectedWorkflowId && triggerRef.current) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [selectedWorkflowId]);

  // Issue #4: Lock body scroll when modal is open, preserving scroll position.
  // Setting overflow:hidden alone resets scroll to top -- position:fixed preserves it.
  useEffect(() => {
    if (!selectedWorkflowId) return;

    const scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';

    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  }, [selectedWorkflowId]);

  // Issue #5: Close modal on Escape key.
  useEffect(() => {
    if (!selectedWorkflowId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedWorkflowId(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedWorkflowId]);

  // Filter: exclude routines tag; apply selected tag + source filters
  const allWorkflows = useMemo(
    () => data?.workflows.filter((w) => !w.tags.includes('routines')) ?? [],
    [data],
  );

  const availableSources = useMemo(() => {
    const sources = new Set(allWorkflows.map((w) => w.source.displayName));
    return [...sources].sort();
  }, [allWorkflows]);

  const visibleWorkflows = useMemo(() => {
    let filtered = selectedTag
      ? allWorkflows.filter((w) => w.tags.includes(selectedTag))
      : allWorkflows;
    if (selectedSource) {
      filtered = filtered.filter((w) => w.source.displayName === selectedSource);
    }
    return filtered;
  }, [allWorkflows, selectedTag, selectedSource]);

  // Flatten into a single ordered array matching the visual card order.
  // When selectedTag is set the list is already flat. When showing all tags,
  // the order must match the grouped rendering below.
  const flatWorkflows = useMemo((): readonly ConsoleWorkflowSummary[] => {
    if (selectedTag) return visibleWorkflows;
    return groupWorkflowsByTag(visibleWorkflows).flatMap((g) => g.workflows);
  }, [visibleWorkflows, selectedTag]);

  const currentIndex = flatWorkflows.findIndex((w) => w.id === selectedWorkflowId);

  // Issue #6: Store the trigger element before opening the modal.
  const handleCardSelect = useCallback((id: string, triggerEl: HTMLButtonElement) => {
    triggerRef.current = triggerEl;
    setSelectedWorkflowId(id);
    triggerEl.blur();
  }, []);

  const navigateModal = useCallback((direction: 'prev' | 'next', axis: 'horizontal' | 'vertical') => {
    if (flatWorkflows.length <= 1) return;
    const current = flatWorkflows.findIndex((w) => w.id === selectedWorkflowId);
    if (current === -1) return;

    const nextIndex = direction === 'next'
      ? (current + 1) % flatWorkflows.length
      : (current - 1 + flatWorkflows.length) % flatWorkflows.length;

    if (isAnimatingRef.current) {
      pendingNavRef.current = nextIndex;
      return;
    }

    startModalTransition(nextIndex, direction, axis);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatWorkflows, selectedWorkflowId]);

  function startModalTransition(nextIndex: number, direction: 'prev' | 'next', axis: 'horizontal' | 'vertical') {
    isAnimatingRef.current = true;
    setBorderFlashing(true);
    setScanlineKey((k) => k + 1);
    // Random offset within the 4px repeating pitch so lines land at different pixels each time
    setCrtOffset(Math.floor(Math.random() * 4));
    const exitClass = axis === 'horizontal'
      ? (direction === 'next' ? 'modal-content--exit-h-next' : 'modal-content--exit-h-prev')
      : (direction === 'next' ? 'modal-content--exit-v-next' : 'modal-content--exit-v-prev');
    setContentAnimClass(exitClass);

    // Reset scroll position immediately
    if (scrollRef.current) scrollRef.current.scrollTop = 0;

    // At midpoint (80ms), swap the workflow ID and start enter animation
    setTimeout(() => {
      setSelectedWorkflowId(flatWorkflows[nextIndex]!.id);
      const enterClass = axis === 'horizontal'
        ? (direction === 'next' ? 'modal-content--enter-h-next' : 'modal-content--enter-h-prev')
        : (direction === 'next' ? 'modal-content--enter-v-next' : 'modal-content--enter-v-prev');
      setContentAnimClass(enterClass);
      setBorderFlashing(false);
    }, 80);

    // After full animation, clear
    setTimeout(() => {
      setContentAnimClass('');
      isAnimatingRef.current = false;
      if (pendingNavRef.current !== null) {
        const pending = pendingNavRef.current;
        pendingNavRef.current = null;
        // determine direction for pending
        const cur = flatWorkflows.findIndex((w) => w.id === selectedWorkflowId);
        const dir = pending > cur ? 'next' : 'prev';
        startModalTransition(pending, dir, 'vertical');
      }
    }, 240);
  }

  // Keyboard navigation between workflows while modal is open.
  useEffect(() => {
    if (!selectedWorkflowId) return;

    // Show keyboard hint briefly
    setHintVisible(true);
    const hintTimer = setTimeout(() => setHintVisible(false), 3000);

    const activeKeys = ['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'];
    const suppressedKeys = ['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S'];

    const handler = (e: KeyboardEvent) => {
      if (suppressedKeys.includes(e.key)) {
        // Block grid keyboard nav from firing while modal is open
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!activeKeys.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const isPrev = ['ArrowLeft', 'a', 'A'].includes(e.key);
      navigateModal(isPrev ? 'prev' : 'next', 'horizontal');
    };

    document.addEventListener('keydown', handler, { capture: true });
    return () => {
      document.removeEventListener('keydown', handler, { capture: true });
      clearTimeout(hintTimer);
    };
  }, [selectedWorkflowId, navigateModal]);

  // Issue #7: Keyboard navigation -- roving tabindex + arrow keys + WASD + Enter/Space.
  const { getItemProps, containerProps } = useGridKeyNav({
    count: flatWorkflows.length,
    cols: 'auto',
    onActivate: useCallback((i: number) => {
      // When Enter/Space fires, document.activeElement is the focused button.
      // We use it as the trigger element for focus-restoration on modal close.
      const triggerEl = document.activeElement as HTMLButtonElement;
      handleCardSelect(flatWorkflows[i].id, triggerEl);
    }, [flatWorkflows, handleCardSelect]),
  });

  // Derive which tag pills have at least one workflow and count per tag.
  const tagsWithWorkflows = new Set(allWorkflows.flatMap((w) => w.tags));
  const countByTag = new Map(CATALOG_TAGS.map((t) => [t.id, allWorkflows.filter((w) => w.tags.includes(t.id)).length]));

  return (
    <div className="space-y-4" aria-busy={isLoading}>
      {/* Tag filter pills */}
      <div
        role="group"
        aria-label="Filter workflows by category"
        className="flex flex-wrap gap-1.5"
      >
        <TagPill
          label="All"
          count={allWorkflows.length}
          isActive={selectedTag === null}
          disabled={isLoading}
          onClick={() => onSelectTag(null)}
        />
        {CATALOG_TAGS.filter((t) => tagsWithWorkflows.has(t.id) || !data).map((tag) => (
          <TagPill
            key={tag.id}
            label={tag.label}
            count={countByTag.get(tag.id) ?? 0}
            isActive={selectedTag === tag.id}
            disabled={isLoading}
            onClick={() => onSelectTag(selectedTag === tag.id ? null : tag.id)}
          />
        ))}
      </div>

      {/* Source filter pills */}
      {availableSources.length > 1 && (
        <div
          role="group"
          aria-label="Filter workflows by source"
          className="flex flex-wrap gap-1.5"
        >
          <TagPill
            label="All Sources"
            count={allWorkflows.length}
            isActive={selectedSource === null}
            disabled={isLoading}
            onClick={() => setSelectedSource(null)}
          />
          {availableSources.map((source) => (
            <TagPill
              key={source}
              label={source}
              count={allWorkflows.filter((w) => w.source.displayName === source).length}
              isActive={selectedSource === source}
              disabled={isLoading}
              onClick={() => setSelectedSource(selectedSource === source ? null : source)}
            />
          ))}
        </div>
      )}

      {/* Content area */}
      {isLoading ? (
        <WorkflowListSkeleton />
      ) : isError ? (
        <WorkflowListError
          message={error instanceof Error ? error.message : 'Could not load workflows.'}
          onRetry={() => void refetch()}
        />
      ) : visibleWorkflows.length === 0 ? (
        <div className="py-8 text-center space-y-3">
          <p className="text-sm text-[var(--text-muted)]">
            No workflows in this category.
          </p>
          {selectedTag !== null && (
            <button
              type="button"
              onClick={() => onSelectTag(null)}
              className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
            >
              Clear filter
            </button>
          )}
        </div>
      ) : selectedTag !== null ? (
        // Single selected tag: one section header + card grid
        <div className="space-y-2">
          <SectionHeader
            label={TAG_DISPLAY[selectedTag] ?? selectedTag}
            count={visibleWorkflows.length}
            showRule={true}
          />
          <div {...containerProps} className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {visibleWorkflows.map((workflow, i) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                onSelect={(triggerEl) => handleCardSelect(workflow.id, triggerEl)}
                navProps={getItemProps(i)}
                isActive={workflow.id === selectedWorkflowId}
              />
            ))}
          </div>
        </div>
      ) : (
        // All: grouped by tag with section headers.
        // Cards are indexed sequentially across all groups to match flatWorkflows.
        <div className="space-y-6">
          {(() => {
            let flatIndex = 0;
            return groupWorkflowsByTag(visibleWorkflows).map((group) => (
              <div key={group.tagId ?? '__other__'} className="space-y-2">
                <SectionHeader label={group.label} count={group.workflows.length} showRule />
                <div {...containerProps} className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  {group.workflows.map((workflow) => {
                    const i = flatIndex++;
                    return (
                      <WorkflowCard
                        key={workflow.id}
                        workflow={workflow}
                        onSelect={(triggerEl) => handleCardSelect(workflow.id, triggerEl)}
                        navProps={getItemProps(i)}
                        isActive={workflow.id === selectedWorkflowId}
                      />
                    );
                  })}
                </div>
              </div>
            ));
          })()}
        </div>
      )}
      {/* Workflow detail modal */}
      <div
        className="fixed inset-0 z-50 flex items-end justify-center p-4 pointer-events-none"
        aria-hidden={!selectedWorkflowId}
      >
        {/* Backdrop */}
        {selectedWorkflowId && (
          <div
            className="absolute inset-0 pointer-events-auto"
            style={{ background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(2px)' }}
            onClick={() => setSelectedWorkflowId(null)}
          />
        )}

        {/* Modal panel */}
        <div
          ref={modalPanelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={`Workflow detail${selectedWorkflowId ? `: ${flatWorkflows.find((w) => w.id === selectedWorkflowId)?.name ?? ''}` : ''}`}
          className={`relative w-full max-w-3xl ${selectedWorkflowId ? "pointer-events-auto" : "pointer-events-none"}${borderFlashing ? ' modal-border-flashing' : ''}`}
          style={{
            height: '85vh',
            transform: selectedWorkflowId ? 'translateY(0) scale(1)' : 'translateY(24px) scale(0.97)',
            opacity: selectedWorkflowId ? 1 : 0,
            transition: 'transform 250ms ease-out, opacity 250ms ease-out',
            /* backdrop-filter here, not inside CutCornerBox -- clip-path breaks backdrop-filter */
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
          }}
        >
          <CutCornerBox
            cut={20}
            borderColor="rgba(244, 196, 48, 0.45)"
            background="rgba(15, 19, 31, 0.50)"
            dropShadow="drop-shadow(0 4px 24px rgba(244,196,48,0.15))"
            className="h-full flex flex-col"
          >
            {/* Modal header */}
            <div
              className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0 console-blueprint-grid"
              style={{ background: 'rgba(15, 19, 31, 0.55)' }}
            >
              <div className="flex items-center gap-4">
                <span className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-secondary)]">
                  Workflow
                </span>
                {currentIndex >= 0 && (
                  <span className="font-mono text-[10px] tracking-[0.20em] text-[var(--text-secondary)]">
                    [ {currentIndex + 1} / {flatWorkflows.length} ]
                  </span>
                )}
                <span
                  className="font-mono text-[9px] tracking-[0.15em] text-[var(--text-secondary)] transition-opacity duration-600"
                  style={{ opacity: hintVisible ? 0.5 : 0 }}
                  aria-hidden="true"
                >
                  [ A / D ] NAV
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedWorkflowId(null)}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors text-xl leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            {/* Scrollable content */}
            <div
              ref={scrollRef}
              className={`flex-1 overflow-auto overscroll-contain px-6 py-5 ${contentAnimClass}`}
              style={{ '--text-muted': 'var(--text-secondary)' } as React.CSSProperties}
            >
              {/* CRT scanline overlay -- re-mounts on each navigation via key prop; --crt-offset randomises line position */}
              {scanlineKey > 0 && (
                <div
                  key={scanlineKey}
                  className="modal-scanline"
                  aria-hidden="true"
                  style={{ '--crt-offset': `${crtOffset}px` } as React.CSSProperties}
                />
              )}

              {/* Screen reader announcement */}
              <div aria-live="polite" aria-atomic="true" className="sr-only">
                {flatWorkflows.find((w) => w.id === selectedWorkflowId)?.name ?? ''}
              </div>

              {selectedWorkflowId && (
                <WorkflowDetail
                  workflowId={selectedWorkflowId}
                  activeTag={selectedTag}
                  onBack={() => setSelectedWorkflowId(null)}
                />
              )}
            </div>
          </CutCornerBox>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag pill
// ---------------------------------------------------------------------------

function TagPill({
  label,
  count,
  isActive,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly count: number;
  readonly isActive: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isActive}
      className={[
        'px-3 py-2 min-w-[44px] min-h-[44px] rounded-none text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        isActive
          ? 'border border-[var(--accent)] text-[var(--accent)] bg-transparent'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-card)]',
      ].join(' ')}
    >
      {label} &middot; {count}
      {isActive && <span className="sr-only">(selected)</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Workflow card
// ---------------------------------------------------------------------------

function WorkflowCard({
  workflow,
  onSelect,
  navProps,
  isActive,
}: {
  readonly workflow: ConsoleWorkflowSummary;
  readonly onSelect: (triggerEl: HTMLButtonElement) => void;
  readonly navProps?: ReturnType<UseGridKeyNavResult['getItemProps']>;
  readonly isActive?: boolean;
}) {
  const displayTags = workflow.tags
    .filter((t) => t !== 'routines')
    .map((t) => TAG_DISPLAY[t] ?? t);

  const accessibleName = [
    workflow.name,
    workflow.description,
    displayTags.length > 0 ? `Tag: ${displayTags.join(', ')}` : null,
    `Source: ${workflow.source.displayName}`,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <ConsoleCard
      variant="grid"
      onClick={(e) => onSelect(e.currentTarget as HTMLButtonElement)}
      aria-label={accessibleName}
      style={isActive ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px rgba(244,196,48,0.4), 0 0 16px rgba(244,196,48,0.12)' } : undefined}
      {...navProps}
    >
      <div className="flex flex-col flex-1 p-4 gap-2 min-w-0">
        {/* Name */}
        <p className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors leading-snug line-clamp-2">
          {workflow.name}
        </p>

        {/* Description */}
        <p className="text-xs text-[var(--text-secondary)] line-clamp-3 leading-relaxed flex-1">
          {workflow.description}
        </p>

        {/* Footer: step count + source */}
        <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-[var(--border)]">
          <div className="flex flex-wrap gap-1.5">
            {displayTags.slice(0, 1).map((label) => (
              <span key={label} className="font-mono text-[9px] px-1.5 py-0.5 bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                {label}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {workflow.stepCount != null && workflow.stepCount > 0 && (
              <span className="font-mono text-[9px] text-[var(--text-muted)]">
                {workflow.stepCount}s
              </span>
            )}
            <span className="font-mono text-[9px] text-[var(--text-muted)] max-w-[80px] truncate">
              src: {workflow.source.displayName}
            </span>
          </div>
        </div>
      </div>
    </ConsoleCard>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function WorkflowListSkeleton() {
  return (
    <div className="space-y-6 motion-safe:animate-pulse">
      {[0, 1].map((section) => (
        <div key={section} className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-3 w-24 bg-[var(--bg-tertiary)]" />
            <div className="flex-1 h-px bg-[var(--bg-tertiary)]" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {[0, 1, 2, 3, 4, 5].map((card) => (
              <div key={card} className="min-h-[160px] bg-[var(--bg-card)] border border-[var(--border)] flex flex-col">
                <div className="h-[3px] bg-[var(--bg-tertiary)]" />
                <div className="p-4 flex flex-col gap-2 flex-1">
                  <div className="h-4 w-3/4 bg-[var(--bg-tertiary)]" />
                  <div className="h-3 w-full bg-[var(--bg-tertiary)]" />
                  <div className="h-3 w-5/6 bg-[var(--bg-tertiary)]" />
                  <div className="mt-auto pt-2 border-t border-[var(--border)] flex justify-between">
                    <div className="h-3 w-12 bg-[var(--bg-tertiary)]" />
                    <div className="h-3 w-16 bg-[var(--bg-tertiary)]" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function WorkflowListError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="space-y-3 py-8 text-center">
      <p className="text-sm text-[var(--error)]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
