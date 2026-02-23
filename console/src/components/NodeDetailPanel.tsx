import { useNodeDetail } from '../api/hooks';
import { MarkdownView } from './MarkdownView';
import type {
  ConsoleNodeDetail,
  ConsoleValidationResult,
  ConsoleAdvanceOutcome,
  ConsoleNodeGap,
  ConsoleArtifact,
} from '../api/types';

interface Props {
  sessionId: string;
  nodeId: string;
  onClose: () => void;
}

export function NodeDetailPanel({ sessionId, nodeId, onClose }: Props) {
  const { data, isLoading, error } = useNodeDetail(sessionId, nodeId);

  return (
    <div className="fixed inset-y-0 right-0 w-[420px] bg-[var(--bg-secondary)] border-l border-[var(--border)] flex flex-col z-50">
      <PanelHeader stepLabel={data?.stepLabel ?? null} nodeId={nodeId} onClose={onClose} />
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading && (
          <div className="text-[var(--text-secondary)] text-sm">Loading...</div>
        )}
        {error && (
          <div className="text-[var(--error)] text-sm bg-[var(--bg-card)] rounded p-3">
            {error.message}
          </div>
        )}
        {data && <NodeDetailContent detail={data} />}
      </div>
    </div>
  );
}

function PanelHeader({ stepLabel, nodeId, onClose }: { stepLabel: string | null; nodeId: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0 gap-2">
      <div className="min-w-0">
        {stepLabel && (
          <div className="text-sm font-medium text-[var(--text-primary)] truncate">
            {stepLabel}
          </div>
        )}
        <div className="font-mono text-xs text-[var(--text-muted)] truncate">
          {nodeId}
        </div>
      </div>
      <button
        onClick={onClose}
        className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none cursor-pointer"
      >
        ✕
      </button>
    </div>
  );
}

function NodeDetailContent({ detail }: { detail: ConsoleNodeDetail }) {
  return (
    <>
      <NodeMetaSection detail={detail} />
      {detail.recapMarkdown && <RecapSection markdown={detail.recapMarkdown} />}
      {detail.advanceOutcome && <AdvanceOutcomeSection outcome={detail.advanceOutcome} />}
      {detail.validations.length > 0 && <ValidationsSection validations={detail.validations} />}
      {detail.gaps.length > 0 && <GapsSection gaps={detail.gaps} />}
      {detail.artifacts.length > 0 && <ArtifactsSection artifacts={detail.artifacts} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function NodeMetaSection({ detail }: { detail: ConsoleNodeDetail }) {
  return (
    <Section title="Node">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <MetaRow label="Kind" value={<KindBadge kind={detail.nodeKind} />} />
        <MetaRow label="Event Index" value={String(detail.createdAtEventIndex)} />
        {detail.parentNodeId && (
          <MetaRow label="Parent" value={detail.parentNodeId} mono />
        )}
        {detail.isTip && (
          <MetaRow
            label="Tip"
            value={detail.isPreferredTip ? 'Preferred tip' : 'Tip'}
          />
        )}
      </dl>
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
    <Section title="Advance Outcome">
      <div className="flex items-center gap-2 text-xs">
        <span
          className="inline-flex items-center px-2 py-0.5 rounded font-medium"
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
        {validations.map((v) => (
          <ValidationCard key={v.validationId} validation={v} />
        ))}
      </div>
    </Section>
  );
}

function ValidationCard({ validation }: { validation: ConsoleValidationResult }) {
  const passed = validation.outcome === 'pass';
  return (
    <div className="bg-[var(--bg-primary)] rounded p-3 text-xs space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded font-medium"
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
        <div>
          <div className="text-[var(--text-muted)] mb-1">Issues:</div>
          <ul className="list-disc list-inside text-[var(--error)] space-y-0.5">
            {validation.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {validation.suggestions.length > 0 && (
        <div>
          <div className="text-[var(--text-muted)] mb-1">Suggestions:</div>
          <ul className="list-disc list-inside text-[var(--text-secondary)] space-y-0.5">
            {validation.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
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
      <div className="space-y-1.5">
        {gaps.map((gap) => (
          <div
            key={gap.gapId}
            className="flex items-start gap-2 text-xs bg-[var(--bg-primary)] rounded p-2"
          >
            <span
              className="shrink-0 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded font-medium"
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
            <span className="text-[var(--text-secondary)]">{gap.summary}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ArtifactsSection({ artifacts }: { artifacts: readonly ConsoleArtifact[] }) {
  return (
    <Section title={`Artifacts (${artifacts.length})`}>
      <div className="space-y-2">
        {artifacts.map((artifact) => (
          <div key={artifact.sha256} className="bg-[var(--bg-primary)] rounded p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <span>{artifact.contentType}</span>
              <span>·</span>
              <span>{formatBytes(artifact.byteLength)}</span>
            </div>
            <pre className="text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono max-h-48 overflow-y-auto">
              {typeof artifact.content === 'string'
                ? artifact.content
                : JSON.stringify(artifact.content, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
          {title}
        </h3>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className={mono ? 'font-mono text-[var(--text-secondary)] truncate' : 'text-[var(--text-primary)]'}>
        {value}
      </dd>
    </>
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
      className="inline-flex items-center px-1.5 py-0.5 rounded font-medium"
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
