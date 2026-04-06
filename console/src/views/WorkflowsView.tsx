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

export function WorkflowsView({ selectedTag, onSelectTag, onSelectWorkflow }: Props) {
  const { data, isLoading, isError, error, refetch } = useWorkflowList();

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
        // Single selected tag: one section header + flat list
        <div className="space-y-2">
          <SectionHeader
            label={TAG_DISPLAY[selectedTag] ?? selectedTag}
            count={visibleWorkflows.length}
            showRule={true}
          />
          <div className="space-y-2">
            {visibleWorkflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                onSelect={() => onSelectWorkflow(workflow.id)}
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
              <div className="space-y-2">
                {group.workflows.map((workflow) => (
                  <WorkflowCard
                    key={workflow.id}
                    workflow={workflow}
                    onSelect={() => onSelectWorkflow(workflow.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({
  label,
  count,
  showRule,
}: {
  readonly label: string;
  readonly count: number;
  readonly showRule: boolean;
}) {
  return (
    <div className="flex items-center gap-3 mb-3 mt-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
        {label}&nbsp;&nbsp;·&nbsp;&nbsp;{count} workflow{count !== 1 ? 's' : ''}
      </span>
      {showRule && <div className="flex-1 h-px bg-[var(--border)]" />}
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
      className="w-full text-left flex items-stretch gap-0 bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors group focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none"
    >
      {/* Left accent stripe */}
      <div className="w-[3px] shrink-0 self-stretch bg-[var(--accent)] opacity-60 group-hover:opacity-100 transition-opacity" />

      <div className="flex-1 min-w-0 px-4 py-3">
        {/* Name */}
        <p className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors leading-snug mb-1">
          {workflow.name}
        </p>

        {/* Description -- 2 lines */}
        <p className="text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed mb-2">
          {workflow.description}
        </p>

        {/* Badges row */}
        <div className="flex items-center gap-2 flex-wrap">
          {displayTags.map((label) => (
            <span key={label} className="font-mono text-[10px] px-1.5 py-0.5 bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
              {label}
            </span>
          ))}
          <span className="font-mono text-[10px] px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-secondary)] max-w-[160px] truncate">
            src: {workflow.source.displayName}
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
    <div className="space-y-6" aria-busy="true" aria-label="Loading workflows">
      {[0, 1, 2].map((section) => (
        <div key={section} className="space-y-2">
          {/* Section header skeleton */}
          <div className="flex items-center gap-3 mb-3">
            <div className="h-3 w-24 rounded bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
            <div className="flex-1 h-px bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
          </div>
          {/* Card skeletons */}
          {[0, 1, 2, 3].map((card) => (
            <div key={card} className="flex bg-[var(--bg-card)] border border-[var(--border)]">
              <div className="w-[3px] bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
              <div className="flex-1 px-4 py-3 space-y-2">
                <div className="h-4 w-2/3 rounded bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
                <div className="h-3 w-full rounded bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
                <div className="h-3 w-4/5 rounded bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
                <div className="flex gap-1.5">
                  <div className="h-4 w-14 rounded bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
                  <div className="h-4 w-16 rounded bg-[var(--bg-tertiary)] motion-safe:animate-pulse" />
                </div>
              </div>
            </div>
          ))}
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
