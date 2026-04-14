import { useState } from 'react';
import { RunLineageDag } from '../components/RunLineageDag';
import { RunNarrativeView } from '../components/RunNarrativeView';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBadge } from '../components/HealthBadge';
import { NodeDetailSection } from '../components/NodeDetailSection';
import { CutCornerBox } from '../components/CutCornerBox';
import type { ConsoleSessionDetail, ConsoleDagRun } from '../api/types';
import type { UseSessionDetailViewModelResult } from '../hooks/useSessionDetailViewModel';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  readonly viewModel: UseSessionDetailViewModelResult;
}

// ---------------------------------------------------------------------------
// SessionMetaCard
// ---------------------------------------------------------------------------

function formatSessionId(sessionId: string): string {
  return sessionId.length > 16 ? `\u2026${sessionId.slice(-16)}` : sessionId;
}

function SessionMetaCard({ data }: { data: ConsoleSessionDetail }) {
  const firstRun = data.runs[0] ?? null;
  const workflow = firstRun?.workflowName ?? firstRun?.workflowId ?? '--';
  const hash = firstRun?.workflowHash?.slice(0, 12) ?? '--';

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] px-5 py-4 corner-brackets" style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
      {data.sessionTitle && (
        <h2 className="text-base font-medium text-[var(--text-primary)] mb-3">
          {data.sessionTitle}
        </h2>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2">
        <dt className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-muted)] self-center">
          Session
        </dt>
        <dd className="font-mono text-xs text-[var(--text-secondary)] self-center">
          {formatSessionId(data.sessionId)}
        </dd>

        <dt className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-muted)] self-center">
          Workflow
        </dt>
        <dd className="text-sm text-[var(--text-primary)] self-center">
          {workflow}
        </dd>

        <dt className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-muted)] self-center">
          Hash
        </dt>
        <dd className="font-mono text-xs text-[var(--text-secondary)] self-center">
          {hash}
        </dd>

        <dt className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-muted)] self-center">
          Status
        </dt>
        <dd className="self-center flex items-center gap-2">
          <HealthBadge health={data.health} />
          {data.health === 'healthy' && (
            <span className="text-sm text-[var(--text-primary)]">Healthy</span>
          )}
        </dd>

        <dt className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-muted)] self-center">
          Runs
        </dt>
        <dd className="text-sm text-[var(--text-primary)] self-center">
          {data.runs.length} run{data.runs.length !== 1 ? 's' : ''}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HintBanner
// ---------------------------------------------------------------------------

function HintBanner({ runs }: { runs: readonly ConsoleDagRun[] }) {
  const hasPreferredTip = runs.some((r) => r.preferredTipNodeId !== null);
  const hasTrace = runs.some((r) => r.executionTraceSummary !== null);

  const dagMessage = hasPreferredTip
    ? 'Nodes with a gold border are the current execution tips \u2014 click any node to inspect its execution detail.'
    : 'Click any node in the DAG to inspect its execution detail.';

  return (
    <div className="border border-[var(--border)] px-4 py-3 text-xs text-[var(--text-muted)] space-y-1">
      <p>{dagMessage}</p>
      {hasTrace && (
        <p>
          This run has execution trace data. Click{' '}
          <span className="font-mono uppercase tracking-[0.16em]">[ TRACE ]</span>{' '}
          to see why certain steps ran, were skipped, or repeated.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionDetail -- pure presenter
// ---------------------------------------------------------------------------

export function SessionDetail({ viewModel }: Props) {
  const { state, onSelectNode, onCloseNode } = viewModel;

  if (state.kind === 'loading') {
    return <div className="text-[var(--text-secondary)]">Loading session...</div>;
  }

  if (state.kind === 'error') {
    return (
      <div className="text-[var(--error)] bg-[var(--bg-card)] rounded-lg p-4">
        Failed to load session: {state.message}
      </div>
    );
  }

  // state.kind === 'ready'
  const { sessionId, data, selectedNode, selectedRun } = state;

  return (
    <>
      <div className="space-y-4">
        <SessionMetaCard data={data} />

        {data.runs.length === 0 ? (
          <div className="text-center py-16 text-[var(--text-secondary)]">
            No runs in this session
          </div>
        ) : (
          <>
            {selectedNode === null && <HintBanner runs={data.runs} />}
            <div className="space-y-6">
              {data.runs.map((run) => (
                <RunCard
                  key={run.runId}
                  run={run}
                  selectedNodeId={
                    selectedNode?.runId === run.runId ? selectedNode.nodeId : null
                  }
                  onNodeClick={onSelectNode}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Floating node detail panel */}
      <CutCornerBox
        cut={18}
        borderColor="rgba(244, 196, 48, 0.35)"
        background="rgba(27, 31, 44, 0.78)"
        dropShadow="drop-shadow(0 16px 48px rgba(0,0,0,0.9)) drop-shadow(0 2px 12px rgba(244,196,48,0.15))"
        backdropFilter="blur(16px)"
        className="fixed top-3 right-3 bottom-3 w-[560px] max-w-[calc(92vw-12px)] transition-transform duration-200 ease-out"
        style={{
          zIndex: 40,
          transform: selectedNode ? 'translateX(0)' : 'translateX(calc(100% + 12px))',
        }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0 console-blueprint-grid">
          <span className="font-mono text-[10px] uppercase tracking-[0.30em] text-[var(--text-muted)]">
            Node detail
          </span>
          <button
            onClick={onCloseNode}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-xl leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <NodeDetailSection
            sessionId={sessionId}
            nodeId={selectedNode?.nodeId ?? null}
            runStatus={selectedRun?.status ?? 'complete'}
            currentNodeId={selectedRun?.preferredTipNodeId ?? null}
            executionTraceSummary={selectedRun?.executionTraceSummary ?? null}
          />
        </div>
      </CutCornerBox>
    </>
  );
}

// ---------------------------------------------------------------------------
// RunCard
// ---------------------------------------------------------------------------

type RunCardTab = 'dag' | 'trace';

function RunCard({
  run,
  selectedNodeId,
  onNodeClick,
}: {
  run: ConsoleDagRun;
  selectedNodeId: string | null;
  onNodeClick: (runId: string, nodeId: string) => void;
}) {
  // Tab strip is only shown when the run has execution trace data.
  const hasTrace = run.executionTraceSummary !== null;
  const [activeTab, setActiveTab] = useState<RunCardTab>('dag');

  return (
    // CutCornerBox requires explicit height (absolute inner layers).
    // Without tab strip: header py-3 (24px) + text-sm line-height (20px) = 44px + DAG 460px + inset 2px = 506px.
    // With tab strip: add 36px for the tab strip row -> 542px.
    <CutCornerBox
      cut={10}
      background="rgba(27, 31, 44, 0.72)"
      backdropFilter="blur(8px)"
      className="relative"
      style={{ height: hasTrace ? '542px' : '506px' }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {run.workflowName ?? run.workflowId ?? 'Run'}
          </span>
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {run.runId}
          </span>
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {run.nodes.length} nodes &middot; {run.tipNodeIds.length} tip{run.tipNodeIds.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {run.hasUnresolvedCriticalGaps && (
            <span className="text-xs text-[var(--warning)]">Critical gaps</span>
          )}
          <StatusBadge status={run.status} />
        </div>
      </div>

      {/* Tab strip -- only shown when execution trace data is available */}
      {hasTrace && (
        <div role="tablist" aria-label="Run view mode" className="flex items-center border-b border-[var(--border)] shrink-0 h-9 px-2 gap-0.5">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'dag'}
            onClick={() => setActiveTab('dag')}
            className={[
              'tab-btn px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors duration-150',
              activeTab === 'dag'
                ? 'tab-btn--active text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            ].join(' ')}
            style={activeTab === 'dag' ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
          >
            <span className="tab-corner tab-corner--tl" aria-hidden="true" />
            <span className="tab-corner tab-corner--tr" aria-hidden="true" />
            <span className="tab-corner tab-corner--bl" aria-hidden="true" />
            <span className="tab-corner tab-corner--br" aria-hidden="true" />
            DAG
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'trace'}
            onClick={() => setActiveTab('trace')}
            className={[
              'tab-btn px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors duration-150',
              activeTab === 'trace'
                ? 'tab-btn--active text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            ].join(' ')}
            style={activeTab === 'trace' ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
          >
            <span className="tab-corner tab-corner--tl" aria-hidden="true" />
            <span className="tab-corner tab-corner--tr" aria-hidden="true" />
            <span className="tab-corner tab-corner--bl" aria-hidden="true" />
            <span className="tab-corner tab-corner--br" aria-hidden="true" />
            TRACE
          </button>
        </div>
      )}

      <div className="flex-1">
        {activeTab === 'trace' && run.executionTraceSummary !== null ? (
          <RunNarrativeView
            summary={run.executionTraceSummary}
            runStatus={run.status}
          />
        ) : (
          <RunLineageDag
            run={run}
            selectedNodeId={selectedNodeId}
            onNodeClick={(nodeId) => onNodeClick(run.runId, nodeId)}
          />
        )}
      </div>
    </CutCornerBox>
  );
}
