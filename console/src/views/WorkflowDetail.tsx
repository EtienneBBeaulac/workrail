import { useState } from 'react';
import { PathBreadcrumb } from '../components/PathBreadcrumb';
import { MarkdownView } from '../components/MarkdownView';
import type { ConsoleWorkflowDetail as WorkflowDetailData, ConsoleWorkflowSourceInfo } from '../api/types';
import type { UseWorkflowDetailViewModelResult } from '../hooks/useWorkflowDetailViewModel';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  readonly viewModel: UseWorkflowDetailViewModelResult;
}

// ---------------------------------------------------------------------------
// WorkflowDetail
// ---------------------------------------------------------------------------

export function WorkflowDetail({ viewModel }: Props) {
  const { state } = viewModel;

  if (state.kind === 'not_found') {
    return (
      <div className="space-y-5 max-w-3xl">
        <DetailError
          message=""
          is404={true}
          onRetry={() => undefined}
          onBack={state.onBack}
        />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="space-y-5 max-w-3xl">
        <DetailError
          message={state.message}
          is404={false}
          onRetry={state.onRetry}
          onBack={state.onBack}
        />
      </div>
    );
  }

  if (state.kind === 'loading') {
    const { cached, activeTagLabel, onBack } = state;
    return (
      <div className="space-y-5 max-w-3xl">
        <PathBreadcrumb
          segments={
            activeTagLabel
              ? [{ label: 'Workflows', onClick: onBack }, { label: activeTagLabel }]
              : [{ label: 'Workflows', onClick: onBack }]
          }
        />
        {cached ? (
          <>
            <WorkflowHeader
              name={cached.name}
              description={cached.description}
              tags={cached.tags}
              source={cached.source}
              stepCount={undefined}
            />
            <div className="space-y-4">
              <SectionSkeleton />
            </div>
          </>
        ) : (
          <DetailSkeleton />
        )}
      </div>
    );
  }

  // kind === 'ready'
  const {
    workflow,
    name,
    description,
    tags,
    source,
    activeTagLabel,
    onPrev,
    onNext,
    onBack,
  } = state;

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Back link */}
      <PathBreadcrumb
        segments={
          activeTagLabel
            ? [{ label: 'Workflows', onClick: onBack }, { label: activeTagLabel }]
            : [{ label: 'Workflows', onClick: onBack }]
        }
      />

      {/* Header */}
      <WorkflowHeader
        name={name}
        description={description}
        tags={tags}
        source={source}
        stepCount={workflow.stepCount}
      />

      {/* Adjacent navigation */}
      {(onPrev ?? onNext) && (
        <div className="flex items-center gap-4">
          {onPrev && (
            <button
              type="button"
              onClick={onPrev}
              className="font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
            >
              {'<'} PREV
            </button>
          )}
          {onNext && (
            <button
              type="button"
              onClick={onNext}
              className="font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
            >
              NEXT {'>'}
            </button>
          )}
        </div>
      )}

      {/* Detail content */}
      <DetailContent detail={workflow} name={name} />

      {/* Second back link at bottom */}
      <PathBreadcrumb
        segments={[{ label: 'Workflows', onClick: onBack }]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow header (shared between loading-with-cache and ready states)
// ---------------------------------------------------------------------------

function WorkflowHeader({
  name,
  description,
  tags,
  source,
  stepCount,
}: {
  readonly name: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly source: ConsoleWorkflowSourceInfo | null;
  readonly stepCount: number | undefined;
}) {
  return (
    <div className="border border-[var(--border)] px-5 py-5 console-blueprint-grid">
      {/* Designation label */}
      <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-[var(--text-muted)] mb-2">
        // Workflow
      </p>

      {/* Title */}
      <h2
        className="font-mono text-xl font-bold uppercase tracking-[0.08em] leading-tight mb-3"
        style={{
          color: 'var(--accent)',
          textShadow: '0 0 24px rgba(244,196,48,0.45), 0 0 48px rgba(244,196,48,0.15)',
        }}
      >
        {name}
      </h2>

      {/* Badges row -- step count inline with tags */}
      <div className="flex flex-wrap items-center gap-2">
        {stepCount != null && stepCount > 0 && (
          <span className="font-mono text-[10px] px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-secondary)]">
            {stepCount} step{stepCount !== 1 ? 's' : ''}
          </span>
        )}
        {tags.filter((t) => t !== 'routines').map((tag) => (
          <span
            key={tag}
            aria-hidden="true"
            className="font-mono text-[10px] px-1.5 py-0.5 bg-[var(--bg-secondary)] text-[var(--text-muted)]"
          >
            {tag}
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

      {/* Short description */}
      {description && (
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed mt-3">
          {description}
        </p>
      )}
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
                  &quot;{example}&quot;
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
    <div className="space-y-3 motion-safe:animate-pulse">
      <div className="h-3 w-16 rounded bg-[var(--bg-tertiary)]" />
      <div className="h-4 w-full rounded bg-[var(--bg-tertiary)]" />
      <div className="h-4 w-5/6 rounded bg-[var(--bg-tertiary)]" />
      <div className="h-4 w-4/6 rounded bg-[var(--bg-tertiary)]" />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6 motion-safe:animate-pulse">
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
    <div className="space-y-4 bg-[var(--bg-card)] border border-[var(--border)] p-4">
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
