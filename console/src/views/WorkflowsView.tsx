import { useWorkflowList } from '../api/hooks';
import type { ConsoleWorkflowSummary } from '../api/types';
import { CATALOG_TAGS, TAG_DISPLAY } from '../config/tags';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  readonly selectedTag: string | null;
  readonly onSelectTag: (tag: string | null) => void;
  readonly onSelectWorkflow: (workflowId: string) => void;
}

// ---------------------------------------------------------------------------
// WorkflowsView
// ---------------------------------------------------------------------------

export function WorkflowsView({ selectedTag, onSelectTag, onSelectWorkflow }: Props) {
  const { data, isLoading, isError, error, refetch } = useWorkflowList();

  // Filter: exclude routines tag; apply selected tag filter
  const allWorkflows = data?.workflows.filter((w) => !w.tags.includes('routines')) ?? [];
  const visibleWorkflows = selectedTag
    ? allWorkflows.filter((w) => w.tags.includes(selectedTag))
    : allWorkflows;

  // Derive which tag pills have at least one workflow (for future count badges).
  // Computed here so pills can degrade gracefully if a category empties.
  const tagsWithWorkflows = new Set(allWorkflows.flatMap((w) => w.tags));

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
          isActive={selectedTag === null}
          disabled={isLoading}
          onClick={() => onSelectTag(null)}
        />
        {CATALOG_TAGS.filter((t) => tagsWithWorkflows.has(t.id) || !data).map((tag) => (
          <TagPill
            key={tag.id}
            label={tag.label}
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
        <p className="text-sm text-[var(--text-muted)] py-8 text-center">
          No workflows in this category.
        </p>
      ) : (
        <div className="space-y-px">
          {visibleWorkflows.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              onSelect={() => onSelectWorkflow(workflow.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag pill
// ---------------------------------------------------------------------------

function TagPill({
  label,
  isActive,
  disabled,
  onClick,
}: {
  readonly label: string;
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
        'px-3 py-2 min-w-[44px] rounded-full text-xs font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        isActive
          ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
      ].join(' ')}
    >
      {label}
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
  readonly onSelect: () => void;
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
    <button
      type="button"
      onClick={onSelect}
      aria-label={accessibleName}
      className="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded hover:bg-[var(--bg-card)] transition-colors group"
    >
      <div className="flex-1 min-w-0 space-y-1">
        {/* Name */}
        <p className="text-sm text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors leading-snug truncate">
          {workflow.name}
        </p>

        {/* Description */}
        <p className="text-xs text-[var(--text-secondary)] truncate">
          {workflow.description}
        </p>

        {/* Badges row -- non-interactive display only */}
        <div className="flex items-center gap-2">
          {displayTags.map((label) => (
            <span
              key={label}
              aria-hidden="true"
              className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)]"
            >
              {label}
            </span>
          ))}
          <span
            aria-hidden="true"
            className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]"
          >
            {workflow.source.displayName}
          </span>
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function WorkflowListSkeleton() {
  return (
    <div className="space-y-px animate-pulse" aria-busy="true" aria-label="Loading workflows">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="px-3 py-3 space-y-1.5">
          <div className="h-4 w-2/3 rounded bg-[var(--bg-tertiary)]" />
          <div className="h-3 w-full rounded bg-[var(--bg-tertiary)]" />
          <div className="flex gap-1.5">
            <div className="h-4 w-14 rounded bg-[var(--bg-tertiary)]" />
            <div className="h-4 w-16 rounded bg-[var(--bg-tertiary)]" />
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
