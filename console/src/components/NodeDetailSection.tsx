import { useState } from 'react';
import { useNodeDetail } from '../api/hooks';
import { MarkdownView } from './MarkdownView';
import { MonoLabel } from './MonoLabel';
import { TraceBadge } from './TraceBadge';
import { getNodeRoutingItems } from '../views/session-detail-use-cases';
import type {
  ConsoleNodeDetail,
  ConsoleRunStatus,
  ConsoleValidationResult,
  ConsoleAdvanceOutcome,
  ConsoleNodeGap,
  ConsoleArtifact,
  ConsoleExecutionTraceSummary,
  ConsoleExecutionTraceItem,
} from '../api/types';

interface Props {
  readonly sessionId: string;
  readonly nodeId: string | null;
  readonly runStatus?: ConsoleRunStatus;
  readonly currentNodeId?: string | null;
  readonly executionTraceSummary?: ConsoleExecutionTraceSummary | null;
}

export function NodeDetailSection({
  sessionId,
  nodeId,
  runStatus = 'complete',
  currentNodeId = null,
  executionTraceSummary = null,
}: Props) {
  const { data, isLoading, error } = useNodeDetail(sessionId, nodeId);

  if (!nodeId) {
    return (
      <div className="px-5 py-8 text-sm text-[var(--text-secondary)]">
        Select a node in the lineage to inspect its recap, validations, gaps, and artifacts.
      </div>
    );
  }

  return (
    <div>
      <SectionHeader stepLabel={data?.stepLabel ?? null} nodeId={nodeId} />
      <div className="p-4 space-y-4">
        {isLoading && (
          <div className="text-[var(--text-secondary)] text-sm">Loading...</div>
        )}
        {error && (
          <div className="text-[var(--error)] text-sm bg-[var(--bg-primary)] border border-[var(--border)] px-4 py-3">
            {error.message}
          </div>
        )}
        {data && (
          <NodeDetailContent
            detail={data}
            runStatus={runStatus}
            currentNodeId={currentNodeId}
            executionTraceSummary={executionTraceSummary}
          />
        )}
      </div>
    </div>
  );
}

function SectionHeader({ stepLabel, nodeId }: { stepLabel: string | null; nodeId: string }) {
  return (
    <div className="px-5 py-4 border-b border-[var(--border)] console-blueprint-grid">
      <div className="text-base font-semibold text-[var(--text-primary)] leading-tight">
        {stepLabel ?? 'Untitled node'}
      </div>
      <div className="mt-1 font-mono text-[11px] text-[var(--text-muted)] truncate">
        {nodeId}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section registry
//
// Adding a new section requires one entry here -- no edits to NodeDetailContent.
// Each definition declares which grid column it belongs to ('primary' | 'secondary')
// and a render function that returns null to hide the section.
// ---------------------------------------------------------------------------

interface NodeDetailContentProps {
  readonly detail: ConsoleNodeDetail;
  readonly runStatus: ConsoleRunStatus;
  readonly currentNodeId: string | null;
  readonly executionTraceSummary: ConsoleExecutionTraceSummary | null;
}

interface SectionDef {
  readonly id: string;
  readonly column: 'primary' | 'secondary';
  readonly render: (props: NodeDetailContentProps) => React.ReactNode;
}

// ---------------------------------------------------------------------------
// Routing section components (used in SECTION_REGISTRY entries below)
// ---------------------------------------------------------------------------

function RoutingItemRow({ item }: { item: ConsoleExecutionTraceItem }) {
  return (
    <div className="flex items-start gap-2 text-xs py-1">
      <span className="flex-1 text-[var(--text-secondary)] leading-relaxed">{item.summary}</span>
      <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">#{item.recordedAtEventIndex}</span>
    </div>
  );
}

function RoutingSection({
  nodeId,
  nodeKind,
  executionTraceSummary,
}: {
  nodeId: string;
  nodeKind: ConsoleNodeDetail['nodeKind'];
  executionTraceSummary: ConsoleExecutionTraceSummary;
}) {
  const { whySelected, conditions, loops, divergences, forks } = getNodeRoutingItems(
    executionTraceSummary,
    nodeId,
  );

  // Mirror the original check: any item that references this node_id counts,
  // even kinds not rendered explicitly (e.g. context_fact with a node_id ref).
  const hasAnyItems = executionTraceSummary.items.some(
    (item) => item.refs.some((r) => r.kind === 'node_id' && r.value === nodeId),
  );

  // When no items match but trace is non-null: show "no routing trace" message
  if (!hasAnyItems) {
    return (
      <Section title="Routing context">
        {nodeKind === 'blocked_attempt' && whySelected.length === 0 ? (
          <div className="flex items-start gap-2 py-1">
            <TraceBadge label="WHY SELECTED" color="var(--text-muted)" />
            <span className="text-xs text-[var(--text-muted)] leading-relaxed">
              This step was attempted but not selected as the preferred path.
            </span>
          </div>
        ) : (
          <span className="font-mono text-xs text-[var(--text-muted)]">
            // no routing trace for this node
          </span>
        )}
      </Section>
    );
  }

  return (
    <Section title="Routing context">
      <div className="space-y-3">
        {/* WHY SELECTED */}
        {(whySelected.length > 0 || nodeKind === 'blocked_attempt') && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <TraceBadge label="WHY SELECTED" color="var(--accent)" />
            </div>
            {whySelected.length > 0 ? (
              <div className="space-y-1 pl-2 border-l border-[var(--border)]">
                <p className="text-[10px] font-mono text-[var(--text-muted)] mb-1">Engine selected this step because:</p>
                {whySelected.map((item, idx) => (
                  <RoutingItemRow key={idx} item={item} />
                ))}
              </div>
            ) : nodeKind === 'blocked_attempt' ? (
              <div className="pl-2 border-l border-[var(--border)]">
                <span className="text-xs text-[var(--text-muted)]">
                  This step was attempted but not selected as the preferred path.
                </span>
              </div>
            ) : null}
          </div>
        )}

        {/* CONDITIONS EVALUATED -- SKIP conditions first */}
        {conditions.length > 0 && (
          <div>
            <div className="mb-1.5">
              <TraceBadge label="CONDITIONS EVALUATED" color="var(--text-secondary)" />
            </div>
            <div className="space-y-1 pl-2 border-l border-[var(--border)]">
              {/* SKIP conditions first -- surfaces why this path was not taken before confirming what passed */}
              {[
                ...conditions.filter((c) => !/\btrue\b|\bpass/i.test(c.summary)),
                ...conditions.filter((c) => /\btrue\b|\bpass/i.test(c.summary)),
              ].map((item, idx) => {
                const passed = /\btrue\b|\bpass/i.test(item.summary);
                return (
                  <div key={idx} className="flex items-start gap-2 text-xs py-0.5">
                    <TraceBadge
                      label={passed ? 'PASS' : 'SKIP'}
                      color={passed ? 'var(--success)' : 'var(--warning)'}
                    />
                    <span className="flex-1 text-[var(--text-secondary)] leading-relaxed">{item.summary}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* LOOP */}
        {loops.length > 0 && (
          <div>
            <div className="mb-1.5">
              <TraceBadge label="LOOP" color="var(--accent-strong)" />
            </div>
            <div className="space-y-1 pl-2 border-l border-[var(--border)]">
              {loops.map((item, idx) => (
                <RoutingItemRow key={idx} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* DIVERGENCE */}
        {divergences.length > 0 && (
          <div>
            <div className="mb-1.5">
              <TraceBadge label="DIVERGENCE" color="var(--error)" />
            </div>
            <div className="space-y-1 pl-2 border-l border-[var(--border)]">
              {divergences.map((item, idx) => (
                <RoutingItemRow key={idx} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* FORK -- detected_non_tip_advance always carries a node_id ref */}
        {forks.length > 0 && (
          <div>
            <div className="mb-1.5">
              <TraceBadge label="FORK" color="var(--warning)" />
            </div>
            <div className="space-y-1 pl-2 border-l border-[var(--border)]">
              {forks.map((item, idx) => (
                <RoutingItemRow key={idx} item={item} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function RunRoutingSection({ items }: { items: readonly ConsoleExecutionTraceItem[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Section title="Run routing">
      <div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          <TraceBadge label="RUN ROUTING" color="var(--text-muted)" />
          <span className="text-[var(--text-muted)]">// {items.length} ambient items</span>
          <span>{expanded ? '[-]' : '[+]'}</span>
        </button>
        {expanded && (
          <div className="mt-2 space-y-1 pl-2 border-l border-[var(--border)]">
            {items.map((item, idx) => {
              const kindLabel = item.kind.replace(/_/g, ' ').toUpperCase();
              return (
                <div key={idx} className="flex items-start gap-2 text-xs py-0.5">
                  <span
                    className="shrink-0 inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em]"
                    style={{ color: 'var(--text-muted)', backgroundColor: 'rgba(123,141,167,0.08)', border: '1px solid rgba(123,141,167,0.20)' }}
                  >
                    {kindLabel}
                  </span>
                  <span className="flex-1 text-[var(--text-secondary)] leading-relaxed">{item.summary}</span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">#{item.recordedAtEventIndex}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Section>
  );
}

// INVARIANT: routing must remain first -- users need routing context before execution output
// Sections render top-to-bottom in this order. Return null to hide a section.
const SECTION_REGISTRY: readonly SectionDef[] = [
  {
    id: 'routing',
    column: 'primary',
    render: ({ detail, executionTraceSummary }) => {
      // Hidden entirely when executionTraceSummary is null (legacy sessions)
      if (executionTraceSummary === null) return null;
      return (
        <RoutingSection
          key="routing"
          nodeId={detail.nodeId}
          nodeKind={detail.nodeKind}
          executionTraceSummary={executionTraceSummary}
        />
      );
    },
  },
  {
    id: 'run_routing',
    column: 'primary',
    render: ({ executionTraceSummary }) => {
      // Hidden entirely when executionTraceSummary is null (legacy sessions)
      if (executionTraceSummary === null) return null;
      // Ambient items: items that have no node_id ref
      const ambientItems = executionTraceSummary.items.filter(
        (item) => !item.refs.some((r) => r.kind === 'node_id'),
      );
      if (ambientItems.length === 0) return null;
      return (
        <RunRoutingSection
          key="run_routing"
          items={ambientItems}
        />
      );
    },
  },
  {
    id: 'recap',
    column: 'primary',
    render: ({ detail, runStatus, currentNodeId }) => {
      if (detail.recapMarkdown) {
        return <RecapSection key="recap" markdown={detail.recapMarkdown} />;
      }
      const showInProgress =
        runStatus === 'in_progress' &&
        detail.nodeId === currentNodeId &&
        !detail.recapMarkdown;
      if (showInProgress) {
        return <InProgressRecapSection key="recap-in-progress" detail={detail} />;
      }
      return null;
    },
  },
  {
    id: 'validations',
    column: 'primary',
    render: ({ detail }) =>
      detail.validations.length > 0
        ? <ValidationsSection key="validations" validations={detail.validations} />
        : null,
  },
  {
    id: 'gaps',
    column: 'primary',
    render: ({ detail }) =>
      detail.gaps.length > 0
        ? <GapsSection key="gaps" gaps={detail.gaps} />
        : null,
  },
  {
    id: 'advance-outcome',
    column: 'primary',
    render: ({ detail }) =>
      detail.advanceOutcome
        ? <AdvanceOutcomeSection key="advance-outcome" outcome={detail.advanceOutcome} />
        : null,
  },
  {
    id: 'artifacts',
    column: 'primary',
    render: ({ detail }) =>
      detail.artifacts.length > 0
        ? <ArtifactsSection key="artifacts" artifacts={detail.artifacts} />
        : null,
  },
  {
    id: 'node-meta',
    column: 'primary',
    render: ({ detail }) => <NodeMetaSection key="node-meta" detail={detail} />,
  },
] as const;

function NodeDetailContent(props: NodeDetailContentProps) {
  return (
    <div className="space-y-4">
      {SECTION_REGISTRY.map((def) => def.render(props))}
    </div>
  );
}

function InProgressRecapSection({ detail }: { detail: ConsoleNodeDetail }) {
  return (
    <Section title="Recap">
      <div className="space-y-4 text-sm text-[var(--text-secondary)]">
        <div className="flex flex-wrap items-center gap-2">
          <LiveBadge>In progress</LiveBadge>
          <span className="font-mono text-xs text-[var(--text-muted)]">
            event #{detail.createdAtEventIndex}
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <LiveInfoCard
            label="Current focus"
            value={detail.stepLabel ?? 'Current workflow step'}
            supportingText="This step is still running, so the recap will appear once execution finishes."
          />
          <LiveInfoCard
            label="Current state"
            value="Waiting for step completion"
            supportingText="The node has been created and selected as the current workflow position."
            mono
          />
        </div>

        <div className="bg-[var(--bg-primary)] border border-[var(--border)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <MonoLabel>What lands here next</MonoLabel>
          </div>
          <div className="p-4 grid gap-3 md:grid-cols-3">
            <PendingOutputCard
              title="Recap"
              description="A step summary is written when this node completes."
            />
            <PendingOutputCard
              title="Validations"
              description="Validation results appear if this step records contract checks."
            />
            <PendingOutputCard
              title="Artifacts"
              description="Generated outputs show up here after the step produces them."
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

function LiveBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center px-2 py-1 font-medium text-xs"
      style={{ backgroundColor: 'rgba(0, 219, 233, 0.12)', color: 'var(--accent-strong)' }}
    >
      {children}
    </span>
  );
}

function LiveInfoCard({
  label,
  value,
  supportingText,
  mono = false,
}: {
  label: string;
  value: string;
  supportingText: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border)] px-4 py-3 space-y-2">
      <MonoLabel>{label}</MonoLabel>
      <div className={mono ? 'font-mono text-sm text-[var(--text-primary)]' : 'text-[var(--text-primary)]'}>
        {value}
      </div>
      <div className="text-xs text-[var(--text-muted)] leading-relaxed">
        {supportingText}
      </div>
    </div>
  );
}

function PendingOutputCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-3 py-3 space-y-2">
      <MonoLabel color="var(--text-secondary)">{title}</MonoLabel>
      <div className="text-xs text-[var(--text-muted)] leading-relaxed">
        {description}
      </div>
    </div>
  );
}

function NodeMetaSection({ detail }: { detail: ConsoleNodeDetail }) {
  return (
    <Section title="Node details">
      <div className="space-y-3">
        <MetaCard label="Kind" value={<KindBadge kind={detail.nodeKind} />} />
        <MetaCard label="Event index" value={String(detail.createdAtEventIndex)} mono />
        <MetaCard label="Parent" value={detail.parentNodeId ?? 'Root'} mono />
        <MetaCard
          label="Tip state"
          value={detail.isTip ? (detail.isPreferredTip ? 'Preferred tip' : 'Tip') : 'Historical'}
        />
      </div>
    </Section>
  );
}

function RecapSection({ markdown }: { markdown: string }) {
  return (
    <Section title="Recap">
      <MarkdownView>{markdown}</MarkdownView>
    </Section>
  );
}

function AdvanceOutcomeSection({ outcome }: { outcome: ConsoleAdvanceOutcome }) {
  const isAdvanced = outcome.kind === 'advanced';
  return (
    <Section title="Advance outcome">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span
          className="inline-flex items-center px-2 py-1 font-medium"
          style={{
            backgroundColor: isAdvanced ? 'var(--success)20' : 'var(--blocked)20',
            color: isAdvanced ? 'var(--success)' : 'var(--blocked)',
          }}
        >
          {isAdvanced ? 'Advanced' : 'Blocked'}
        </span>
        <span className="text-[var(--text-muted)]">
          attempt {outcome.attemptId.slice(-8)} at event #{outcome.recordedAtEventIndex}
        </span>
      </div>
    </Section>
  );
}

function ValidationsSection({ validations }: { validations: readonly ConsoleValidationResult[] }) {
  return (
    <Section title={`Validations (${validations.length})`}>
      <div className="space-y-2">
        {validations.map((validation) => (
          <ValidationCard key={validation.validationId} validation={validation} />
        ))}
      </div>
    </Section>
  );
}

function ValidationCard({ validation }: { validation: ConsoleValidationResult }) {
  const passed = validation.outcome === 'pass';
  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border)] px-4 py-3 text-xs space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center px-2 py-1 font-medium"
          style={{
            backgroundColor: passed ? 'var(--success)20' : 'var(--error)20',
            color: passed ? 'var(--success)' : 'var(--error)',
          }}
        >
          {passed ? 'Pass' : 'Fail'}
        </span>
        <span className="text-[var(--text-muted)] font-mono">{validation.contractRef}</span>
      </div>
      {validation.issues.length > 0 && (
        <div className="space-y-1">
          <div className="text-[var(--text-muted)] mb-1">Issues</div>
          <ul className="list-disc list-inside text-[var(--error)] space-y-0.5">
            {validation.issues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {validation.suggestions.length > 0 && (
        <div>
          <div className="text-[var(--text-muted)] mb-1">Suggestions</div>
          <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-0.5">
            {validation.suggestions.map((suggestion, index) => (
              <li key={index}>{suggestion}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function GapsSection({ gaps }: { gaps: readonly ConsoleNodeGap[] }) {
  return (
    <Section title={`Gaps (${gaps.length})`}>
      <div className="space-y-2">
        {gaps.map((gap) => (
          <div
            key={gap.gapId}
            className="flex items-start gap-3 text-xs bg-[var(--bg-primary)] border border-[var(--border)] px-3 py-3"
          >
            <span
              className="shrink-0 inline-flex items-center px-2 py-1 font-medium"
              style={{
                backgroundColor: gap.isResolved
                  ? 'var(--success)20'
                  : gap.severity === 'critical'
                    ? 'var(--error)20'
                    : 'var(--warning)20',
                color: gap.isResolved
                  ? 'var(--success)'
                  : gap.severity === 'critical'
                    ? 'var(--error)'
                    : 'var(--warning)',
              }}
            >
              {gap.isResolved ? 'Resolved' : gap.severity === 'critical' ? 'Critical' : 'Non-critical'}
            </span>
            <span className="text-[var(--text-secondary)] leading-relaxed">{gap.summary}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Artifact renderer registry
//
// Keyed by content-type prefix (e.g. 'text/', 'application/json').
// A renderer returns a ReactNode for the artifact content.
// Artifacts over ARTIFACT_SIZE_LIMIT_BYTES are never passed to renderers --
// a truncation notice is shown instead to avoid serialising large payloads.
// ---------------------------------------------------------------------------

const ARTIFACT_SIZE_LIMIT_BYTES = 100_000;

type ArtifactRenderer = (content: unknown) => React.ReactNode;

const ARTIFACT_RENDERERS: ReadonlyArray<{
  readonly prefix: string;
  readonly render: ArtifactRenderer;
}> = [
  {
    prefix: 'text/',
    render: (content) => (
      <pre className="text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto">
        {typeof content === 'string' ? content : String(content)}
      </pre>
    ),
  },
  {
    prefix: 'application/json',
    render: (content) => (
      <pre className="text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto">
        {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
      </pre>
    ),
  },
];

function renderArtifactContent(artifact: ConsoleArtifact): React.ReactNode {
  if (artifact.byteLength > ARTIFACT_SIZE_LIMIT_BYTES) {
    return (
      <div className="text-[var(--text-muted)] italic">
        Content too large to display ({formatBytes(artifact.byteLength)} -- limit {formatBytes(ARTIFACT_SIZE_LIMIT_BYTES)})
      </div>
    );
  }

  const renderer = ARTIFACT_RENDERERS.find((r) => artifact.contentType.startsWith(r.prefix));
  if (renderer) return renderer.render(artifact.content);

  // Fallback: render as JSON if content is an object, otherwise as string.
  return (
    <pre className="text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto">
      {typeof artifact.content === 'string'
        ? artifact.content
        : JSON.stringify(artifact.content, null, 2)}
    </pre>
  );
}

function ArtifactsSection({ artifacts }: { artifacts: readonly ConsoleArtifact[] }) {
  return (
    <Section title={`Artifacts (${artifacts.length})`}>
      <div className="space-y-2">
        {artifacts.map((artifact) => (
          <div key={artifact.sha256} className="bg-[var(--bg-primary)] border border-[var(--border)] px-4 py-3 text-xs space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[var(--text-muted)]">
              <span>{artifact.contentType}</span>
              <span>//</span>
              <span>{formatBytes(artifact.byteLength)}</span>
            </div>
            {renderArtifactContent(artifact)}
          </div>
        ))}
      </div>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2">
        <MonoLabel>{title}</MonoLabel>
      </div>
      {children}
    </div>
  );
}

function MetaCard({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border)] px-4 py-3">
      <MonoLabel>{label}</MonoLabel>
      <div className={mono ? 'mt-2 font-mono text-sm text-[var(--text-secondary)] truncate' : 'mt-2 text-sm text-[var(--text-primary)]'}>
        {value}
      </div>
    </div>
  );
}

const NODE_KIND_LABELS: Record<ConsoleNodeDetail['nodeKind'], { label: string; color: string }> = {
  step: { label: 'Step', color: 'var(--accent)' },
  checkpoint: { label: 'Checkpoint', color: 'var(--success)' },
  blocked_attempt: { label: 'Blocked', color: 'var(--error)' },
};

function KindBadge({ kind }: { kind: ConsoleNodeDetail['nodeKind'] }) {
  const config = NODE_KIND_LABELS[kind];
  return (
    <span
      className="inline-flex items-center px-2 py-1 font-medium"
      style={{ backgroundColor: `${config.color}20`, color: config.color }}
    >
      {config.label}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
