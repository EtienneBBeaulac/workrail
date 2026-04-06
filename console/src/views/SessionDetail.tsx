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

export function SessionDetail({ sessionId }: Props) {
  const { data, isLoading, error } = useSessionDetail(sessionId);
  const [selectedByRunId, setSelectedByRunId] = useState<Record<string, string | null>>({});

  const handleNodeClick = useCallback((runId: string, nodeId: string) => {
    setSelectedByRunId((prev) => ({
      ...prev,
      [runId]: prev[runId] === nodeId ? null : nodeId,
    }));
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

  return (
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
              sessionId={sessionId}
              run={run}
              selectedNodeId={selectedByRunId[run.runId] ?? null}
              onNodeClick={handleNodeClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({
  sessionId,
  run,
  selectedNodeId,
  onNodeClick,
}: {
  sessionId: string;
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
      {/* DAG takes full width. Node detail slides in as a drawer from the right. */}
      <div className="relative h-[460px]">
        <RunLineageDag
          run={run}
          selectedNodeId={selectedNodeId}
          onNodeClick={(nodeId) => onNodeClick(run.runId, nodeId)}
        />

        {/* Drawer: slides in from the right over the DAG when a node is selected.
            Width is capped so the DAG rail + summary header remain visible. */}
        <div
          className="absolute top-0 right-0 bottom-0 w-[420px] max-w-[85%] flex flex-col bg-[var(--bg-card)] border-l border-[var(--border)] shadow-2xl transition-transform duration-200 ease-out overflow-hidden"
          style={{ transform: selectedNodeId ? 'translateX(0)' : 'translateX(100%)' }}
        >
          <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] shrink-0">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Node detail
            </span>
            <button
              onClick={() => onNodeClick(run.runId, selectedNodeId!)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none px-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            <NodeDetailSection
              sessionId={sessionId}
              nodeId={selectedNodeId}
              runStatus={run.status}
              currentNodeId={run.preferredTipNodeId}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
