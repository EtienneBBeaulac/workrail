import { useState, useCallback } from 'react';
import { useSessionDetail } from '../api/hooks';
import { RunLineageDag } from '../components/RunLineageDag';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBadge } from '../components/HealthBadge';
import { NodeDetailSection } from '../components/NodeDetailSection';
import type { ConsoleDagRun } from '../api/types';

interface Props {
  sessionId: string;
}

interface SelectedNode {
  runId: string;
  nodeId: string;
}

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
      <div className="space-y-6">
        {data.sessionTitle && (
          <h2 className="text-base font-medium text-[var(--text-primary)] mb-2">
            {data.sessionTitle}
          </h2>
        )}
        <div className="flex items-center gap-3 mb-6">
          <HealthBadge health={data.health} />
          <span className="text-sm text-[var(--text-muted)]">
            {data.runs.length} run{data.runs.length !== 1 ? 's' : ''}
          </span>
        </div>

        {data.runs.length === 0 ? (
          <div className="text-center py-16 text-[var(--text-secondary)]">
            No runs in this session
          </div>
        ) : (
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
        )}
      </div>

      {/* Floating detail panel -- slides in from the right over everything */}
      <div
        className="fixed top-0 right-0 bottom-0 w-[560px] max-w-[92vw] flex flex-col bg-[var(--bg-card)] border-l border-[var(--border)] shadow-2xl transition-transform duration-200 ease-out"
        style={{ zIndex: 40, transform: selectedNode ? 'translateX(0)' : 'translateX(100%)' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0 console-blueprint-grid">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
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
      </div>
    </>
  );
}

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
    <div className="bg-[var(--bg-card)] border border-[var(--border)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {run.workflowName ?? run.workflowId ?? 'Run'}
          </span>
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {run.runId}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {run.hasUnresolvedCriticalGaps && (
            <span className="text-xs text-[var(--warning)]">Critical gaps</span>
          )}
          <StatusBadge status={run.status} />
        </div>
      </div>
      <div className="h-[460px]">
        <RunLineageDag
          run={run}
          selectedNodeId={selectedNodeId}
          onNodeClick={(nodeId) => onNodeClick(run.runId, nodeId)}
        />
      </div>
    </div>
  );
}
