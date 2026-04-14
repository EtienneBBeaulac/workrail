import { useCallback, useEffect, useRef } from 'react';
import type { ConsoleWorkflowSummary } from '../api/types';
import { useModalTransition } from '../hooks/useModalTransition';
import { CATALOG_TAGS, TAG_DISPLAY } from '../config/tags';
import { SectionHeader } from '../components/SectionHeader';
import { ConsoleCard } from '../components/ConsoleCard';
import { CutCornerBox, cutCornerPath } from '../components/CutCornerBox';
import { WorkflowDetail } from './WorkflowDetail';
import { useGridKeyNav, type UseGridKeyNavResult } from '../hooks/useGridKeyNav';
import type { UseWorkflowsViewModelResult } from '../hooks/useWorkflowsViewModel';
import { useWorkflowDetailViewModel } from '../hooks/useWorkflowDetailViewModel';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  readonly viewModel: UseWorkflowsViewModelResult;
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
 *
 * This is a UI grouping helper (not a use case) because it directly references
 * CATALOG_TAGS, a UI configuration constant.
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

export function WorkflowsView({ viewModel }: Props) {
  const { state, dispatch, triggerRef, onCardSelect } = viewModel;

  // modalPanelRef: focus target for rAF when modal opens. Pure UI concern -- stays here.
  const modalPanelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // useModalTransition owns pure CRT/glitch animation state.
  // It stays in the view because it is purely visual and has no data concerns.
  const modalTransition = useModalTransition();

  // Focus management: move focus into the modal panel when it opens.
  // The ViewModel handles restore-to-trigger on close.
  // rAF defers until after the opacity transition starts so the panel is visible.
  const selectedWorkflowId = state.kind === 'ready' ? state.selectedWorkflowId : null;

  useEffect(() => {
    if (selectedWorkflowId) {
      const id = requestAnimationFrame(() => modalPanelRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [selectedWorkflowId]);

  if (state.kind === 'loading') {
    return <WorkflowListSkeleton />;
  }

  if (state.kind === 'error') {
    return (
      <WorkflowListError
        message={state.message}
        onRetry={state.onRetry}
      />
    );
  }

  // state.kind === 'ready'
  const {
    selectedTag,
    selectedSource,
    hintVisible,
    filteredWorkflows,
    flatWorkflows,
    availableSources,
  } = state;

  const knownTagIds = new Set(CATALOG_TAGS.map((t) => t.id));
  const tagsWithWorkflows = new Set(filteredWorkflows.flatMap((w) => w.tags));
  const countByTag = new Map(CATALOG_TAGS.map((t) => [t.id, filteredWorkflows.filter((w) => w.tags.includes(t.id)).length]));
  const otherCount = filteredWorkflows.filter((w) => !w.tags.some((t) => t !== 'routines' && knownTagIds.has(t))).length;

  const currentIndex = flatWorkflows.findIndex((w) => w.id === selectedWorkflowId);

  return (
    <WorkflowsReadyView
      selectedWorkflowId={selectedWorkflowId}
      selectedTag={selectedTag}
      selectedSource={selectedSource}
      hintVisible={hintVisible}
      filteredWorkflows={filteredWorkflows}
      flatWorkflows={flatWorkflows}
      availableSources={availableSources}
      tagsWithWorkflows={tagsWithWorkflows}
      countByTag={countByTag}
      otherCount={otherCount}
      currentIndex={currentIndex}
      dispatch={dispatch}
      onCardSelect={onCardSelect}
      triggerRef={triggerRef}
      modalPanelRef={modalPanelRef}
      scrollRef={scrollRef}
      modalTransition={modalTransition}
    />
  );
}

// ---------------------------------------------------------------------------
// WorkflowsReadyView -- rendered when state.kind === 'ready'
// ---------------------------------------------------------------------------

interface ReadyViewProps {
  readonly selectedWorkflowId: string | null;
  readonly selectedTag: string | null;
  readonly selectedSource: string | null;
  readonly hintVisible: boolean;
  readonly filteredWorkflows: readonly ConsoleWorkflowSummary[];
  readonly flatWorkflows: readonly ConsoleWorkflowSummary[];
  readonly availableSources: readonly { readonly id: string; readonly displayName: string }[];
  readonly tagsWithWorkflows: Set<string>;
  readonly countByTag: Map<string, number>;
  readonly otherCount: number;
  readonly currentIndex: number;
  readonly dispatch: UseWorkflowsViewModelResult['dispatch'];
  readonly onCardSelect: UseWorkflowsViewModelResult['onCardSelect'];
  readonly triggerRef: UseWorkflowsViewModelResult['triggerRef'];
  readonly modalPanelRef: React.RefObject<HTMLDivElement | null>;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly modalTransition: ReturnType<typeof useModalTransition>;
}

function WorkflowsReadyView({
  selectedWorkflowId,
  selectedTag,
  selectedSource,
  hintVisible,
  filteredWorkflows,
  flatWorkflows,
  availableSources,
  tagsWithWorkflows,
  countByTag,
  otherCount,
  currentIndex,
  dispatch,
  onCardSelect,
  modalPanelRef,
  scrollRef,
  modalTransition,
}: ReadyViewProps) {
  // ViewModel for the workflow detail modal. The modal's onBack closes the modal
  // and onNavigateToWorkflow dispatches workflow_selected to switch to another
  // workflow without leaving the modal. The keyboard handler in the ViewModel is
  // effectively suppressed by WorkflowsView's capture-phase handler above it.
  const workflowDetailViewModel = useWorkflowDetailViewModel({
    workflowId: selectedWorkflowId,
    activeTag: selectedTag,
    onBack: () => dispatch({ type: 'modal_closed' }),
    onNavigateToWorkflow: (id) => dispatch({ type: 'workflow_selected', id }),
  });

  const navigateModal = useCallback(
    (direction: 'prev' | 'next', axis: 'horizontal' | 'vertical') => {
      modalTransition.navigate(
        selectedWorkflowId,
        flatWorkflows,
        direction,
        axis,
        (nextId) => {
          dispatch({ type: 'workflow_selected', id: nextId });
          modalTransition.selectedWorkflowIdRef.current = nextId;
        },
        scrollRef,
      );
    },
    [flatWorkflows, selectedWorkflowId, modalTransition, dispatch, scrollRef],
  );

  // Keyboard navigation between workflows while modal is open.
  useEffect(() => {
    if (!selectedWorkflowId) return;

    const activeKeys = ['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'];
    const suppressedKeys = ['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S'];

    const handler = (e: KeyboardEvent) => {
      if (suppressedKeys.includes(e.key)) {
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
    };
  }, [selectedWorkflowId, navigateModal]);

  const { getItemProps, containerProps } = useGridKeyNav({
    count: flatWorkflows.length,
    cols: 'auto',
    onActivate: useCallback((i: number) => {
      const workflow = flatWorkflows[i];
      if (!workflow) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLButtonElement)) return;
      onCardSelect(workflow.id, active);
    }, [flatWorkflows, onCardSelect]),
  });

  return (
    <div className="space-y-4">
      {/* Page title */}
      <div>
        <h1
          className="font-mono text-2xl font-bold uppercase tracking-[0.12em] leading-none"
          style={{ color: 'var(--accent)', textShadow: '0 0 28px rgba(244,196,48,0.35)' }}
        >
          Workflows
        </h1>
        <p className="font-mono text-[10px] tracking-[0.25em] text-[var(--text-muted)] mt-1.5">
          // {filteredWorkflows.length} available
        </p>
      </div>

      {/* Tag filter pills */}
      <div
        role="group"
        aria-label="Filter workflows by category"
        className="flex flex-wrap gap-1.5"
      >
        <TagPill
          label="All"
          count={filteredWorkflows.length}
          isActive={selectedTag === null}
          disabled={false}
          onClick={() => dispatch({ type: 'tag_changed', tag: null })}
        />
        {CATALOG_TAGS.filter((t) => tagsWithWorkflows.has(t.id)).map((tag) => (
          <TagPill
            key={tag.id}
            label={tag.label}
            count={countByTag.get(tag.id) ?? 0}
            isActive={selectedTag === tag.id}
            disabled={false}
            onClick={() => dispatch({ type: 'tag_changed', tag: selectedTag === tag.id ? null : tag.id })}
          />
        ))}
        {otherCount > 0 && (
          <TagPill
            label="Other"
            count={otherCount}
            isActive={selectedTag === '__other__'}
            disabled={false}
            onClick={() => dispatch({ type: 'tag_changed', tag: selectedTag === '__other__' ? null : '__other__' })}
          />
        )}
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
            count={filteredWorkflows.length}
            isActive={selectedSource === null}
            disabled={false}
            onClick={() => dispatch({ type: 'source_changed', source: null })}
          />
          {availableSources.map((source) => (
            <TagPill
              key={source.id}
              label={source.displayName}
              count={filteredWorkflows.filter((w) => w.source.displayName === source.displayName).length}
              isActive={selectedSource === source.displayName}
              disabled={false}
              onClick={() => dispatch({ type: 'source_changed', source: selectedSource === source.displayName ? null : source.displayName })}
            />
          ))}
        </div>
      )}

      {/* Content area */}
      {filteredWorkflows.length === 0 ? (
        <div className="py-8 text-center space-y-3">
          <p className="text-sm text-[var(--text-muted)]">
            No workflows in this category.
          </p>
          {selectedTag !== null && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'tag_changed', tag: null })}
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
            label={selectedTag === '__other__' ? 'Other' : (TAG_DISPLAY[selectedTag] ?? selectedTag)}
            count={filteredWorkflows.length}
            showRule={true}
          />
          <div {...containerProps} className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredWorkflows.map((workflow, i) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                onSelect={(triggerEl) => onCardSelect(workflow.id, triggerEl)}
                navProps={getItemProps(i)}
                isActive={workflow.id === selectedWorkflowId}
              />
            ))}
          </div>
        </div>
      ) : (
        // All: grouped by tag with section headers.
        <div className="space-y-6">
          {(() => {
            let flatIndex = 0;
            return groupWorkflowsByTag(filteredWorkflows).map((group) => (
              <div key={group.tagId ?? '__other__'} className="space-y-2">
                <SectionHeader label={group.label} count={group.workflows.length} showRule />
                <div {...containerProps} className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  {group.workflows.map((workflow) => {
                    const i = flatIndex++;
                    return (
                      <WorkflowCard
                        key={workflow.id}
                        workflow={workflow}
                        onSelect={(triggerEl) => onCardSelect(workflow.id, triggerEl)}
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
            onClick={() => dispatch({ type: 'modal_closed' })}
          />
        )}

        {/* Modal panel */}
        <div
          ref={modalPanelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={`Workflow detail${selectedWorkflowId ? `: ${flatWorkflows.find((w) => w.id === selectedWorkflowId)?.name ?? ''}` : ''}`}
          className={`relative w-full max-w-3xl ${selectedWorkflowId ? "pointer-events-auto" : "pointer-events-none"}${modalTransition.state.borderFlashing ? ' modal-border-flashing' : ''}`}
          style={{
            height: '85vh',
            transform: selectedWorkflowId ? 'translateY(0) scale(1)' : 'translateY(24px) scale(0.97)',
            opacity: selectedWorkflowId ? 1 : 0,
            transition: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'opacity 150ms ease-out'
              : 'transform 250ms ease-out, opacity 250ms ease-out',
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
            {/* CRT scanline overlay */}
            {modalTransition.state.scanline !== null && (
              <div
                key={modalTransition.state.scanline.key}
                className="modal-scanline"
                aria-hidden="true"
                style={{
                  '--crt-offset': `${modalTransition.state.scanline.crtOffset}px`,
                  '--glitch-y': `${modalTransition.state.scanline.glitchY}%`,
                  '--glitch-y2': `${modalTransition.state.scanline.glitchY2}%`,
                  '--glitch-w': `${modalTransition.state.scanline.glitchW}px`,
                  '--glitch-w2': `${modalTransition.state.scanline.glitchW2}px`,
                  clipPath: cutCornerPath(20),
                } as React.CSSProperties}
              />
            )}

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
                onClick={() => dispatch({ type: 'modal_closed' })}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors text-xl leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            {/* Scrollable content */}
            <div
              ref={scrollRef}
              className={`flex-1 overflow-auto overscroll-contain px-6 py-5 ${modalTransition.state.contentAnimClass}`}
              style={{ '--text-muted': 'var(--text-secondary)' } as React.CSSProperties}
            >
              {/* Screen reader announcement */}
              <div aria-live="polite" aria-atomic="true" className="sr-only">
                {flatWorkflows.find((w) => w.id === selectedWorkflowId)?.name ?? ''}
              </div>

              {selectedWorkflowId && (
                <WorkflowDetail viewModel={workflowDetailViewModel} />
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
