import { useState } from 'react';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionList } from './views/SessionList';
import { SessionDetail } from './views/SessionDetail';
import { WorktreeList } from './views/WorktreeList';

type Tab = 'workspace' | 'sessions' | 'worktrees';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('workspace');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionRepoRoot, setSessionRepoRoot] = useState<string | null>(null);
  // Incremented on every handleSelectBranch call so SessionList remounts even
  // when the same branch/repo is clicked twice (key must change to force remount).
  const [sessionSearchNonce, setSessionSearchNonce] = useState(0);

  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
  };

  const handleBack = () => {
    setSelectedSessionId(null);
  };

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSelectedSessionId(null);
    if (tab === 'sessions') {
      setSessionSearch('');
      setSessionRepoRoot(null);
    }
  };

  const handleSelectBranch = (branch: string, repoRoot: string) => {
    setSessionSearch(branch);
    setSessionRepoRoot(repoRoot);
    setSessionSearchNonce(n => n + 1);
    setActiveTab('sessions');
    setSelectedSessionId(null);
  };

  // When in SessionDetail from the Sessions or Worktrees tab the workspace tab
  // is not active, so we only need the extra "keep mounted" trick for Workspace.
  const isInSessionDetail = selectedSessionId !== null;
  const sessionDetailFromNonWorkspace = isInSessionDetail && activeTab !== 'workspace';

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

          {/* Tab nav -- hidden when viewing session detail */}
          {!isInSessionDetail && (
            <nav className="ml-4 flex gap-1">
              {(['workspace', 'sessions', 'worktrees'] as Tab[]).map(tab => (
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
        {/* SessionDetail for sessions opened from Sessions or Worktrees tabs */}
        {sessionDetailFromNonWorkspace && (
          <SessionDetail sessionId={selectedSessionId} />
        )}

        {/* Workspace tab -- always mounted when active so scroll position survives
            back-navigation from SessionDetail. Hidden via CSS when in session detail. */}
        {activeTab === 'workspace' && !sessionDetailFromNonWorkspace && (
          <>
            <WorkspaceView
              onSelectSession={handleSelectSession}
              hidden={isInSessionDetail}
            />
            {/* SessionDetail overlaid; WorkspaceView hidden (not unmounted) behind it */}
            {isInSessionDetail && (
              <SessionDetail sessionId={selectedSessionId} />
            )}
          </>
        )}

        {/* Sessions tab with redirect banner */}
        {!isInSessionDetail && activeTab === 'sessions' && (
          <>
            <RedirectBanner />
            <SessionList
              key={sessionSearchNonce}
              onSelectSession={handleSelectSession}
              initialSearch={sessionSearch}
              initialRepoRoot={sessionRepoRoot}
            />
          </>
        )}

        {/* Worktrees tab with redirect banner */}
        {!isInSessionDetail && activeTab === 'worktrees' && (
          <>
            <RedirectBanner />
            <WorktreeList onSelectBranch={handleSelectBranch} />
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Redirect banner -- shown on Sessions and Worktrees tabs
// ---------------------------------------------------------------------------

function RedirectBanner() {
  return (
    <div className="flex items-center gap-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-2.5 mb-4 text-sm text-[var(--text-muted)]"
      style={{ borderLeftColor: 'var(--accent)', borderLeftWidth: '3px' }}
    >
      This view has moved to{' '}
      <strong className="text-[var(--text-secondary)]">Workspace</strong>
      {' '}-- the Sessions and Worktrees tabs will be removed in the next release.
    </div>
  );
}
