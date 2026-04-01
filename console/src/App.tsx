import { useState } from 'react';
import { SessionList } from './views/SessionList';
import { SessionDetail } from './views/SessionDetail';
import { WorktreeList } from './views/WorktreeList';

type Tab = 'sessions' | 'worktrees';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');

  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
  };

  const handleBack = () => {
    setSelectedSessionId(null);
  };

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSelectedSessionId(null);
    if (tab === 'sessions') setSessionSearch('');
  };

  const handleSelectBranch = (branch: string) => {
    setSessionSearch(branch);
    setActiveTab('sessions');
    setSelectedSessionId(null);
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <header className="border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-center gap-4">
          {selectedSessionId && (
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
          {selectedSessionId && (
            <span className="text-sm text-[var(--text-muted)] font-mono">
              {selectedSessionId}
            </span>
          )}

          {/* Tab nav — hidden when viewing session detail */}
          {!selectedSessionId && (
            <nav className="ml-4 flex gap-1">
              {(['sessions', 'worktrees'] as Tab[]).map(tab => (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  className={`px-3 py-1 rounded text-sm font-medium transition-colors capitalize ${
                    activeTab === tab
                      ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </nav>
          )}
        </div>
      </header>

      <main className="p-6">
        {selectedSessionId ? (
          <SessionDetail sessionId={selectedSessionId} />
        ) : activeTab === 'worktrees' ? (
          <WorktreeList onSelectBranch={handleSelectBranch} />
        ) : (
          <SessionList onSelectSession={handleSelectSession} initialSearch={sessionSearch} />
        )}
      </main>
    </div>
  );
}
