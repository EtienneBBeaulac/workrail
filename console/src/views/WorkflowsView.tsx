import { useEffect, useRef, useState } from 'react';
import { useWorkflowList } from '../api/hooks';
import type { ConsoleWorkflowSummary } from '../api/types';
import { CATALOG_TAGS, TAG_DISPLAY } from '../config/tags';
import { SectionHeader } from '../components/SectionHeader';
import { ConsoleCard } from '../components/ConsoleCard';
import { CutCornerBox } from '../components/CutCornerBox';
import { WorkflowDetail } from './WorkflowDetail';

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
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

  // Issue #6: Store the trigger element before opening the modal.
  const handleCardSelect = (id: string, triggerEl: HTMLButtonElement) => {
    triggerRef.current = triggerEl;
    setSelectedWorkflowId(id);
  };

  // Filter: exclude routines tag; apply selected tag filter
  const allWorkflows = data?.workflows.filter((w) => !w.tags.includes('routines')) ?? [];
  const visibleWorkflows = selectedTag
    ? allWorkflows.filter((w) => w.tags.includes(selectedTag))
    : allWorkflows;

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
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {visibleWorkflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                onSelect={(triggerEl) => handleCardSelect(workflow.id, triggerEl)}
              />
            ))}
          </div>
        </div>
      ) : (
        // All: grouped by tag with section headers
        <div className="space-y-6">
          {groupWorkflowsByTag(visibleWorkflows).map((group) => (
            <div key={group.tagId ?? '__other__'} className="space-y-2">
              <SectionHeader label={group.label} count={group.workflows.length} showRule />
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {group.workflows.map((workflow) => (
                  <WorkflowCard
                    key={workflow.id}
                    workflow={workflow}
                    onSelect={(triggerEl) => handleCardSelect(workflow.id, triggerEl)}
                  />
                ))}
              </div>
            </div>
          ))}
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
            style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
            onClick={() => setSelectedWorkflowId(null)}
          />
        )}

        {/* Modal panel */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Workflow detail"
          className={`relative w-full max-w-3xl ${selectedWorkflowId ? "pointer-events-auto" : "pointer-events-none"}`}
          style={{
            height: '85vh',
            transform: selectedWorkflowId ? 'translateY(0) scale(1)' : 'translateY(24px) scale(0.97)',
            opacity: selectedWorkflowId ? 1 : 0,
            transition: 'transform 250ms ease-out, opacity 250ms ease-out',
            /* backdrop-filter here, not inside CutCornerBox -- clip-path breaks backdrop-filter */
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
          }}
        >
          <CutCornerBox
            cut={20}
            borderColor="rgba(244, 196, 48, 0.4)"
            background="rgba(15, 19, 31, 0.85)"
            dropShadow="drop-shadow(0 24px 64px rgba(0,0,0,0.9)) drop-shadow(0 4px 16px rgba(244,196,48,0.15))"
            className="h-full flex flex-col"
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0 console-blueprint-grid">
              <span className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-muted)]">
                Workflow
              </span>
              <button
                type="button"
                onClick={() => setSelectedWorkflowId(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-xl leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-auto overscroll-contain px-6 py-5">
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
}: {
  readonly workflow: ConsoleWorkflowSummary;
  readonly onSelect: (triggerEl: HTMLButtonElement) => void;
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
    <ConsoleCard variant="grid" onClick={(e) => onSelect(e.currentTarget as HTMLButtonElement)} aria-label={accessibleName}>
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
