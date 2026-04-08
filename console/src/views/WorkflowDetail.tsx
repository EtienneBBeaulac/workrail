import { useState } from 'react';
import { PathBreadcrumb } from '../components/PathBreadcrumb';
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

  const backLabel = activeTag && TAG_DISPLAY[activeTag]
    ? `Workflows / ${TAG_DISPLAY[activeTag]}`
    : 'Workflows';

  // Use detail data when available, fall back to cached list data for header fields.
  const name = detail?.name ?? cached?.name ?? workflowId;
  const description = detail?.description ?? cached?.description ?? null;
  const tags = detail?.tags ?? cached?.tags ?? [];
  const source = detail?.source ?? cached?.source ?? null;

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Back link */}
      <PathBreadcrumb
        segments={
          activeTag
            ? [{ label: 'Workflows', onClick: onBack }, { label: backLabel.replace('Workflows / ', '') }]
            : [{ label: 'Workflows', onClick: onBack }]
        }
      />

      {/* Header */}
      <div className="border border-[var(--border)] px-5 py-4 console-blueprint-grid">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] leading-snug mb-2">
          {name}
        </h2>

        {/* stepCount as standalone metric */}
        {detail && detail.stepCount != null && detail.stepCount > 0 && (
          <p className="font-mono text-[11px] text-[var(--text-secondary)] mb-2">
            {detail.stepCount} step{detail.stepCount !== 1 ? 's' : ''}
          </p>
        )}

        {/* Badges row */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {tags.filter((t) => t !== 'routines').map((tag) => (
            <span
              key={tag}
              aria-hidden="true"
              className="font-mono text-[10px] px-1.5 py-0.5 bg-[var(--bg-secondary)] text-[var(--text-muted)]"
            >
              {TAG_DISPLAY[tag] ?? tag}
            </span>
          ))}
          {source && (
            <span
              aria-hidden="true"
              className="font-mono text-[10px] px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-muted)]"
            >
              src: {source.displayName}
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
        <DetailContent detail={detail} name={name} />
      ) : (
        // Optimistic state: cached partial data shown, detail still loading
        <div className="space-y-4">
          <SectionSkeleton />
        </div>
      )}

      {/* Second back link at bottom */}
      <PathBreadcrumb
        segments={[{ label: 'Workflows', onClick: onBack }]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail content sections
// ---------------------------------------------------------------------------

function DetailContent({
  detail,
  name,
}: {
  readonly detail: WorkflowDetailData;
  readonly name: string;
}) {
  const hasAbout = detail.about !== undefined && detail.about.length > 0;
  const hasExamples = detail.examples !== undefined && detail.examples.length > 0;
  const hasPreconditions = detail.preconditions !== undefined && detail.preconditions.length > 0;
  const hasAnyContent = hasAbout || hasExamples || hasPreconditions;

  if (!hasAnyContent) {
    return (
      <p className="text-sm text-[var(--text-muted)] italic">
        No additional documentation available.
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
                className="flex items-start gap-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-none px-4 py-3"
              >
                <div
                  aria-hidden="true"
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

      {/* Copy prompt CTA */}
      <CopyPromptCta name={name} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy prompt CTA
// ---------------------------------------------------------------------------

function CopyPromptCta({ name }: { readonly name: string }) {
  const [copied, setCopied] = useState(false);
  const prompt = `Use the ${name} to [your goal]`;

  const handleCopy = () => {
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <section>
      <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
        Start with this prompt
      </h3>
      <div className="flex items-center gap-3 border border-[var(--border)] px-4 py-3">
        <span className="flex-1 text-sm text-[var(--text-secondary)] font-mono truncate">
          &quot;{prompt}&quot;
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 text-xs font-mono text-[var(--accent)] hover:text-[var(--text-primary)] transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </section>
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
          className="font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          {'<'} WORKFLOWS
        </button>
      </div>
    </div>
  );
}
