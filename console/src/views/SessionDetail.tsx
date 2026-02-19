import { useSessionDetail } from '../api/hooks';
import { RunDag } from '../components/RunDag';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBadge } from '../components/HealthBadge';

interface Props {
  sessionId: string;
}

export function SessionDetail({ sessionId }: Props) {
  const { data, isLoading, error } = useSessionDetail(sessionId);

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
    <div>
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
            <div key={run.runId} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-[var(--text-primary)]">
                    Run: {run.runId}
                  </span>
                  {run.workflowId && (
                    <span className="text-xs text-[var(--text-muted)]">
                      {run.workflowId}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {run.hasUnresolvedCriticalGaps && (
                    <span className="text-xs text-[var(--warning)]">Critical gaps</span>
                  )}
                  <StatusBadge status={run.status} />
                </div>
              </div>
              <div className="h-[500px]">
                <RunDag run={run} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
