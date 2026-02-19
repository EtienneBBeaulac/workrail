import { useState } from 'react';
import { SessionList } from './views/SessionList';
import { SessionDetail } from './views/SessionDetail';

export function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <header className="border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-center gap-4">
          {selectedSessionId && (
            <button
              onClick={() => setSelectedSessionId(null)}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              &larr; Back
            </button>
          )}
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            WorkRail Console
          </h1>
          {selectedSessionId && (
            <span className="text-sm text-[var(--text-muted)] font-mono">
              {selectedSessionId}
            </span>
          )}
        </div>
      </header>

      <main className="p-6">
        {selectedSessionId ? (
          <SessionDetail sessionId={selectedSessionId} />
        ) : (
          <SessionList onSelectSession={setSelectedSessionId} />
        )}
      </main>
    </div>
  );
}
