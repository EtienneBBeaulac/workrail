import { Outlet, useNavigate, useMatchRoute } from '@tanstack/react-router';

/**
 * AppShell renders the persistent chrome (header) and the active route's
 * content via <Outlet>. Navigation state is derived from the URL instead
 * of React state so browser back/forward work correctly.
 */
export function AppShell() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();

  // Determine whether we are on a session detail route
  const sessionMatch = matchRoute({ to: '/session/$sessionId' });
  const isInSessionDetail = sessionMatch !== false;
  const sessionId = isInSessionDetail && sessionMatch
    ? (sessionMatch as { sessionId: string }).sessionId
    : null;

  const handleBack = () => {
    navigate({ to: '/' });
  };

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
          {isInSessionDetail && sessionId && (
            <span className="text-sm text-[var(--text-muted)] font-mono">
              {sessionId}
            </span>
          )}
        </div>
      </header>

      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
