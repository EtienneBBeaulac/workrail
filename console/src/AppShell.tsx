import { useNavigate, useMatchRoute } from '@tanstack/react-router';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionDetail } from './views/SessionDetail';

/**
 * AppShell is the root route component. It owns both WorkspaceView and
 * SessionDetail directly -- WorkspaceView is always mounted and hidden via CSS
 * when navigating to a session, preserving scroll position on back-navigation.
 *
 * Navigation state is derived from the URL so browser back/forward work
 * correctly without any React state synchronization.
 */
export function AppShell() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();

  const sessionMatch = matchRoute({ to: '/session/$sessionId' });
  const isInSessionDetail = sessionMatch !== false;
  // useMatchRoute returns Record<string, string> when matched; sessionId is
  // always present and typed as string by the router registration
  const sessionId = isInSessionDetail ? (sessionMatch as Record<string, string>).sessionId : null;

  const handleBack = () => {
    navigate({ to: '/' });
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border)] px-6 py-4 bg-[var(--bg-primary)]">
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
          {isInSessionDetail && sessionId && (
            <span className="text-sm text-[var(--text-muted)] font-mono">
              {sessionId}
            </span>
          )}
        </div>
      </header>

      <main className="p-6">
        {/* WorkspaceView is always mounted -- hidden via CSS only so scroll
            position in scrollYRef survives back-navigation */}
        <WorkspaceView hidden={isInSessionDetail} />
        {isInSessionDetail && sessionId && (
          <SessionDetail sessionId={sessionId} />
        )}
      </main>
    </div>
  );
}
