import { useState, useCallback } from 'react';
import { useSessionDetail } from '../api/hooks';
import { RunLineageDag } from '../components/RunLineageDag';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBadge } from '../components/HealthBadge';
import { NodeDetailSection } from '../components/NodeDetailSection';
import { CutCornerBox } from '../components/CutCornerBox';
import type { ConsoleSessionDetail, ConsoleDagRun } from '../api/types';

interface Props {
  sessionId: string;
}

interface SelectedNode {
  runId: string;
  nodeId: string;
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
    <div className="bg-[var(--bg-card)] border border-[var(--border)] px-5 py-4 corner-brackets">
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
  const message = hasPreferredTip
    ? 'Nodes with a gold border are the current execution tips \u2014 click any node to inspect its execution detail.'
    : 'Click any node in the DAG to inspect its execution detail.';

  return (
    <p className="border border-[var(--border)] px-4 py-3 text-xs text-[var(--text-muted)]">
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// SessionDetail
// ---------------------------------------------------------------------------

export function SessionDetail({ sessionId }: Props) {
  const { data, isLoading, error } = useSessionDetail(sessionId);
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);

  const handleNodeClick = useCallback((runId: string, nodeId: string) => {
    setSelectedNode((prev) =>
      prev?.runId === runId && prev?.nodeId === nodeId ? null : { runId, nodeId },
    );
  }, []);

  if (isLoading) {
    return <div className="text-[var(--text-secondary)]">Loading session...</div>;
  }

  if (error) {
    return (
      <div className="text-[var(--error)] bg-[var(--bg-card)] rounded-lg p-4">
        Failed to load session: {error.message}
      </div>
    );
  }

  if (!data) return null;

  const selectedRun = selectedNode
    ? (data.runs.find((r) => r.runId === selectedNode.runId) ?? null)
    : null;

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
                  onNodeClick={handleNodeClick}
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
        background="color-mix(in srgb, var(--bg-card) 92%, var(--accent) 8%)"
        dropShadow="drop-shadow(0 16px 48px rgba(0,0,0,0.8)) drop-shadow(0 2px 8px rgba(0,0,0,0.55))"
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
            onClick={() => setSelectedNode(null)}
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
          />
        </div>
      </CutCornerBox>
    </>
  );
}

// ---------------------------------------------------------------------------
// RunCard
// ---------------------------------------------------------------------------

function RunCard({
  run,
  selectedNodeId,
  onNodeClick,
}: {
  run: ConsoleDagRun;
  selectedNodeId: string | null;
  onNodeClick: (runId: string, nodeId: string) => void;
}) {
  return (
    // CutCornerBox requires explicit height (absolute inner layers).
    // Header: py-3 (24px) + text-sm line-height (20px) = 44px.
    // DAG: 460px. Inset: 2px. Total: 506px.
    <CutCornerBox
      cut={10}
      className="relative"
      style={{ height: '506px' }}
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
      <div className="flex-1">
        <RunLineageDag
          run={run}
          selectedNodeId={selectedNodeId}
          onNodeClick={(nodeId) => onNodeClick(run.runId, nodeId)}
        />
      </div>
    </CutCornerBox>
  );
}
