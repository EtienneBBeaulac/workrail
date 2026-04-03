import { useState } from 'react';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionDetail } from './views/SessionDetail';

export function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
  };

  const handleBack = () => {
    setSelectedSessionId(null);
  };

  const isInSessionDetail = selectedSessionId !== null;

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <header className="border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-center gap-4">
          {isInSessionDetail && (
            <button
              onClick={handleBack}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              &larr; Back
            </button>
          )}
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            WorkRail Console
          </h1>
          {isInSessionDetail && (
            <span className="text-sm text-[var(--text-muted)] font-mono">
              {selectedSessionId}
            </span>
          )}
        </div>
      </header>

      <main className="p-6">
        {/* WorkspaceView always mounted so scroll position survives
            back-navigation from SessionDetail. Hidden via CSS when in detail. */}
        <WorkspaceView
          onSelectSession={handleSelectSession}
          hidden={isInSessionDetail}
        />
        {isInSessionDetail && (
          <SessionDetail sessionId={selectedSessionId} />
        )}
      </main>
    </div>
  );
}
