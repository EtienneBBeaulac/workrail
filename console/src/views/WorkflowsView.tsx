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

/**
 * Returns a short teaser string from the workflow summary:
 * - First 80 chars of `about` (if present), or
 * - First example wrapped in quotes (if present), or
 * - null
 */
function getTeaserText(workflow: ConsoleWorkflowSummary): string | null {
  if (workflow.about && workflow.about.length > 0) {
    const trimmed = workflow.about.slice(0, 80);
    return trimmed.length < workflow.about.length ? `${trimmed}...` : trimmed;
  }
  if (workflow.examples && workflow.examples.length > 0) {
    return `"${workflow.examples[0]}"`;
  }
  return null;
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
      ) : selectedTag !== null ? (
        // Single selected tag: one section header + flat list
        <div className="space-y-2">
          <SectionHeader
            label={TAG_DISPLAY[selectedTag] ?? selectedTag}
            count={visibleWorkflows.length}
            showRule={false}
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
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
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
        'px-3 py-2 min-w-[44px] rounded-none text-xs font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        isActive
          ? 'bg-[var(--accent)] text-white'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-card)]',
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

  const teaserText = getTeaserText(workflow);

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
      <div className="w-[3px] shrink-0 self-stretch bg-[var(--accent)] opacity-40 group-hover:opacity-100 transition-opacity" />

      <div className="flex-1 min-w-0 px-4 py-3">
        {/* Name */}
        <p className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors leading-snug mb-1">
          {workflow.name}
        </p>

        {/* Description -- 2 lines */}
        <p className="text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed mb-2">
          {workflow.description}
        </p>

        {/* About teaser (first 80 chars of about, or first example in quotes) */}
        {teaserText && (
          <p className="text-xs italic text-[var(--text-muted)] truncate mb-2">
            {teaserText}
          </p>
        )}

        {/* Badges row */}
        <div className="flex items-center gap-2 flex-wrap">
          {displayTags.map((label) => (
            <span key={label} className="font-mono text-[10px] px-1.5 py-0.5 bg-[var(--bg-secondary)] text-[var(--text-muted)]">
              {label}
            </span>
          ))}
          <span className="font-mono text-[10px] px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-muted)] max-w-[120px] truncate">
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
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading workflows">
      {[0, 1].map((section) => (
        <div key={section} className="space-y-2">
          {/* Section header skeleton */}
          <div className="flex items-center gap-3 mb-3">
            <div className="h-3 w-24 rounded bg-[var(--bg-tertiary)]" />
            <div className="flex-1 h-px bg-[var(--bg-tertiary)]" />
          </div>
          {/* Card skeletons */}
          {[0, 1, 2].map((card) => (
            <div key={card} className="flex bg-[var(--bg-card)] border border-[var(--border)]">
              <div className="w-[3px] bg-[var(--bg-tertiary)]" />
              <div className="flex-1 px-4 py-3 space-y-2">
                <div className="h-4 w-2/3 rounded bg-[var(--bg-tertiary)]" />
                <div className="h-3 w-full rounded bg-[var(--bg-tertiary)]" />
                <div className="h-3 w-4/5 rounded bg-[var(--bg-tertiary)]" />
                <div className="flex gap-1.5">
                  <div className="h-4 w-14 rounded bg-[var(--bg-tertiary)]" />
                  <div className="h-4 w-16 rounded bg-[var(--bg-tertiary)]" />
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
