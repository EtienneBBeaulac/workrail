import { useSessionList } from '../api/hooks';
import { StatusBadge } from '../components/StatusBadge';
import { HealthBadge } from '../components/HealthBadge';
import type { ConsoleSessionSummary } from '../api/types';

interface Props {
  onSelectSession: (sessionId: string) => void;
}

export function SessionList({ onSelectSession }: Props) {
  const { data, isLoading, error } = useSessionList();

  if (isLoading) {
    return <div className="text-[var(--text-secondary)]">Loading sessions...</div>;
  }

  if (error) {
    return (
      <div className="text-[var(--error)] bg-[var(--bg-card)] rounded-lg p-4">
        Failed to load sessions: {error.message}
      </div>
    );
  }

  if (!data || data.sessions.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-[var(--text-secondary)] text-lg">No v2 sessions found</p>
        <p className="text-[var(--text-muted)] text-sm mt-2">
          Sessions will appear here when workflows are executed with v2 tools enabled.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-[var(--text-primary)]">
          Sessions ({data.totalCount})
        </h2>
      </div>
      <div className="grid gap-3">
        {data.sessions.map((session) => (
          <SessionCard
            key={session.sessionId}
            session={session}
            onClick={() => onSelectSession(session.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

function SessionCard({ session, onClick }: { session: ConsoleSessionSummary; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 hover:border-[var(--accent)] transition-colors cursor-pointer"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-sm text-[var(--text-primary)]">
          {session.sessionId}
        </span>
        <div className="flex items-center gap-2">
          <HealthBadge health={session.health} />
          <StatusBadge status={session.status} />
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
        {session.workflowId && (
          <span>Workflow: {session.workflowId}</span>
        )}
        <span>{session.nodeCount} nodes</span>
        <span>{session.edgeCount} edges</span>
        {session.tipCount > 1 && (
          <span>{session.tipCount} tips (branched)</span>
        )}
        {session.hasUnresolvedGaps && (
          <span className="text-[var(--warning)]">unresolved gaps</span>
        )}
      </div>
      {session.recapSnippet && (
        <p className="mt-2 text-xs text-[var(--text-secondary)] line-clamp-2">
          {session.recapSnippet}
        </p>
      )}
    </button>
  );
}
