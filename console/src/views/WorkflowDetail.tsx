import { useQueryClient } from '@tanstack/react-query';
import { useWorkflowDetail, HttpError } from '../api/hooks';
import { MarkdownView } from '../components/MarkdownView';
import type { ConsoleWorkflowListResponse, ConsoleWorkflowSummary, ConsoleWorkflowDetail as WorkflowDetailData } from '../api/types';
import { TAG_DISPLAY } from '../config/tags';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  readonly workflowId: string;
  readonly activeTag?: string | null;
  readonly onBack: () => void;
}

// ---------------------------------------------------------------------------
// WorkflowDetail
// ---------------------------------------------------------------------------

export function WorkflowDetail({ workflowId, activeTag, onBack }: Props) {
  const queryClient = useQueryClient();

  // Optimistic partial data: use cached list entry while detail fetch completes.
  const listData = queryClient.getQueryData<ConsoleWorkflowListResponse>(['workflows']);
  const cached: ConsoleWorkflowSummary | undefined = listData?.workflows.find(
    (w) => w.id === workflowId,
  );

  const { data: detail, isLoading, isError, error, refetch } = useWorkflowDetail(workflowId);

  const tag = activeTag && TAG_DISPLAY[activeTag] ? TAG_DISPLAY[activeTag] : null;
  const backLabel = tag
    ? `WORKFLOWS // ${tag.toUpperCase()}`
    : 'WORKFLOWS';

  // Use detail data when available, fall back to cached list data for header fields.
  const name = detail?.name ?? cached?.name ?? workflowId;
  const description = detail?.description ?? cached?.description ?? null;
  const tags = detail?.tags ?? cached?.tags ?? [];
  const source = detail?.source ?? cached?.source ?? null;

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors text-sm"
      >
        &larr; {backLabel}
      </button>

      {/* Header */}
      <div className="space-y-2 console-blueprint-grid corner-brackets px-5 py-4">
        <h2 className="text-xl font-semibold text-[var(--text-primary)] leading-snug">
          {name}
        </h2>

        {/* Badges row */}
        <div className="flex flex-wrap items-center gap-2">
          {tags.filter((t) => t !== 'routines').map((tag) => (
            <span
              key={tag}
              aria-hidden="true"
              className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            >
              {TAG_DISPLAY[tag] ?? tag}
            </span>
          ))}
          {source && (
            <span
              aria-hidden="true"
              className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border)]"
            >
              {source.displayName}
            </span>
          )}
          {detail && (
            <span className="text-[10px] text-[var(--text-muted)]">
              {detail.stepCount} {detail.stepCount === 1 ? 'step' : 'steps'}
            </span>
          )}
        </div>

        {/* Short description (full text, not truncated) */}
        {description && (
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            {description}
          </p>
        )}
      </div>

      {/* Detail sections -- loading, error, or content */}
      {isLoading && !cached ? (
        <DetailSkeleton />
      ) : isError ? (
        <DetailError
          message={error instanceof Error ? error.message : 'Could not load workflow details.'}
          is404={error instanceof HttpError && error.status === 404}
          onRetry={() => void refetch()}
          onBack={onBack}
        />
      ) : detail ? (
        <DetailContent detail={detail} />
      ) : (
        // Optimistic state: cached partial data shown, detail still loading
        <div className="space-y-4">
          <SectionSkeleton />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail content sections
// ---------------------------------------------------------------------------

function DetailContent({
  detail,
}: {
  readonly detail: WorkflowDetailData;
}) {
  const hasAbout = detail.about !== undefined && detail.about.length > 0;
  const hasExamples = detail.examples !== undefined && detail.examples.length > 0;
  const hasPreconditions = detail.preconditions !== undefined && detail.preconditions.length > 0;
  const hasAnyContent = hasAbout || hasExamples || hasPreconditions;

  if (!hasAnyContent) {
    return (
      <p className="text-sm text-[var(--text-muted)] italic">
        No extended description available for this workflow.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {hasAbout && (
        <section>
          <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            About
          </h3>
          <MarkdownView>{detail.about!}</MarkdownView>
        </section>
      )}

      {hasExamples && (
        <section>
          <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Try it with:
          </h3>
          <ul className="space-y-2">
            {detail.examples!.map((example) => (
              <li
                key={example}
                className="flex items-start gap-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3"
              >
                <div
                  className="w-0.5 shrink-0 self-stretch rounded-full"
                  style={{ backgroundColor: 'var(--accent)' }}
                />
                <span className="text-sm text-[var(--text-secondary)] leading-relaxed">
                  "{example}"
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasPreconditions && (
        <section>
          <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Before you start:
          </h3>
          <ul className="space-y-1.5">
            {detail.preconditions!.map((p) => (
              <li key={p} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                <span className="shrink-0 text-[var(--text-muted)] mt-0.5">&#x2022;</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading / error skeletons
// ---------------------------------------------------------------------------

function SectionSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-3 w-16 rounded bg-[var(--bg-tertiary)]" />
      <div className="h-4 w-full rounded bg-[var(--bg-tertiary)]" />
      <div className="h-4 w-5/6 rounded bg-[var(--bg-tertiary)]" />
      <div className="h-4 w-4/6 rounded bg-[var(--bg-tertiary)]" />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-6 w-1/2 rounded bg-[var(--bg-tertiary)]" />
        <div className="flex gap-2">
          <div className="h-5 w-16 rounded bg-[var(--bg-tertiary)]" />
          <div className="h-5 w-24 rounded bg-[var(--bg-tertiary)]" />
        </div>
        <div className="h-4 w-full rounded bg-[var(--bg-tertiary)]" />
      </div>
      <SectionSkeleton />
    </div>
  );
}

function DetailError({
  message,
  is404,
  onRetry,
  onBack,
}: {
  readonly message: string;
  readonly is404: boolean;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}) {
  return (
    <div className="space-y-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      <p className="text-sm text-[var(--error)]">
        {is404 ? 'Workflow not found.' : message}
      </p>
      <div className="flex gap-3">
        {!is404 && (
          <button
            type="button"
            onClick={onRetry}
            className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
          >
            Try again
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to workflows list"
          className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          &larr; Back to Workflows
        </button>
      </div>
    </div>
  );
}
