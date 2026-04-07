import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate, useMatchRoute, useRouterState } from '@tanstack/react-router';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionDetail } from './views/SessionDetail';
import { WorkflowsView } from './views/WorkflowsView';
import { WorkflowDetail } from './views/WorkflowDetail';
import { PerformanceView } from './views/PerformanceView';

/**
 * AppShell is the root route component. It owns all view rendering directly,
 * keeping WorkspaceView permanently mounted for scroll position preservation.
 *
 * Navigation state is derived from the URL so browser back/forward work
 * correctly without any React state synchronization.
 */
export function AppShell() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const { location } = useRouterState();

  // ---------------------------------------------------------------------------
  // Routing state
  // ---------------------------------------------------------------------------

  const sessionMatch = matchRoute({ to: '/session/$sessionId' });
  const workflowsMatch = matchRoute({ to: '/workflows' });
  const workflowDetailMatch = matchRoute({ to: '/workflows/$workflowId' });
  const perfMatch = matchRoute({ to: '/perf' });

  const isInSessionDetail = sessionMatch !== false;
  const isOnWorkflowsTab = workflowsMatch !== false || workflowDetailMatch !== false;
  const isOnWorkflowDetail = workflowDetailMatch !== false;
  const isOnPerfTab = perfMatch !== false;

  const sessionId = isInSessionDetail
    ? (sessionMatch as Record<string, string>).sessionId
    : null;

  const workflowId = isOnWorkflowDetail
    ? (workflowDetailMatch as Record<string, string>).workflowId
    : null;

  // Tag filter is a search param on the workflow routes.
  const activeTag = new URLSearchParams(location.search).get('tag');

  // ---------------------------------------------------------------------------
  // Navigation handlers
  // ---------------------------------------------------------------------------

  const handleBackFromSession = useCallback(() => {
    void navigate({ to: '/' });
  }, [navigate]);

  const handleSelectTag = useCallback(
    (tag: string | null) => {
      void navigate({ to: '/workflows', search: { tag: tag ?? undefined } });
    },
    [navigate],
  );

  const handleSelectWorkflow = useCallback(
    (id: string) => {
      void navigate({
        to: '/workflows/$workflowId',
        params: { workflowId: id },
        search: { tag: activeTag ?? undefined },
      });
    },
    [navigate, activeTag],
  );

  const handleBackFromWorkflow = useCallback(() => {
    void navigate({ to: '/workflows', search: { tag: activeTag ?? undefined } });
  }, [navigate, activeTag]);

  // ---------------------------------------------------------------------------
  // Tab bar keyboard (ARIA tablist: Left/Right arrows switch tabs)
  // ---------------------------------------------------------------------------

  // A3: data-driven tab order -- add new tabs here, not in the handler
  const TAB_ROUTES = ['/', '/workflows', '/perf'] as const;

  const tabBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        // Derive current tab index from booleans (matches the TabRoutes order above)
        const currentIndex = isOnPerfTab ? 2 : isOnWorkflowsTab ? 1 : 0;
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const nextIndex = (currentIndex + delta + TAB_ROUTES.length) % TAB_ROUTES.length;
        const nextRoute = TAB_ROUTES[nextIndex];
        if (nextRoute === '/workflows') {
          void navigate({ to: '/workflows', search: { tag: undefined } });
        } else {
          void navigate({ to: nextRoute });
        }
      }
    }
    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [isOnWorkflowsTab, isOnPerfTab, navigate, TAB_ROUTES]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="min-h-screen bg-[var(--bg-primary)]"
      style={{ '--app-header-height': '61px' } as CSSProperties}
    >
      <header className="sticky top-0 z-20 border-b border-[var(--border)] px-6 py-4 bg-[var(--bg-primary)]">
        <div className="flex items-center gap-4">
          {isInSessionDetail && (
            <button
              onClick={handleBackFromSession}
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

          {/* Tab bar -- hidden when in session detail */}
          {!isInSessionDetail && (
            <div
              role="tablist"
              aria-label="Console sections"
              ref={tabBarRef}
              className="flex items-center gap-1 ml-4"
            >
              <button
                role="tab"
                id="tab-workspace"
                aria-selected={!isOnWorkflowsTab && !isOnPerfTab}
                aria-controls="panel-workspace"
                tabIndex={!isOnWorkflowsTab && !isOnPerfTab ? 0 : -1}
                onClick={() => void navigate({ to: '/' })}
                className={[
                  'px-3 py-1 rounded text-sm font-medium transition-colors',
                  !isOnWorkflowsTab && !isOnPerfTab
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                Workspace
              </button>
              <button
                role="tab"
                id="tab-workflows"
                aria-selected={isOnWorkflowsTab}
                aria-controls="panel-workflows"
                tabIndex={isOnWorkflowsTab ? 0 : -1}
                onClick={() => void navigate({ to: '/workflows', search: { tag: undefined } })}
                className={[
                  'px-3 py-1 rounded text-sm font-medium transition-colors',
                  isOnWorkflowsTab
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                Workflows
              </button>
              <button
                role="tab"
                id="tab-perf"
                aria-selected={isOnPerfTab}
                aria-controls="panel-perf"
                tabIndex={isOnPerfTab ? 0 : -1}
                onClick={() => void navigate({ to: '/perf' })}
                className={[
                  'px-3 py-1 rounded text-sm font-medium transition-colors',
                  isOnPerfTab
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                Performance
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="p-6">
        {/* Workspace panel */}
        <div
          id="panel-workspace"
          role="tabpanel"
          aria-labelledby="tab-workspace"
          hidden={isOnWorkflowsTab || isOnPerfTab}
        >
          {/* WorkspaceView is always mounted -- hidden via CSS only so scroll
              position in scrollYRef survives back-navigation from SessionDetail */}
          <WorkspaceView hidden={isInSessionDetail} />
          {isInSessionDetail && sessionId && (
            <SessionDetail sessionId={sessionId} />
          )}
        </div>

        {/* Workflows panel */}
        {isOnWorkflowsTab && (
          <div
            id="panel-workflows"
            role="tabpanel"
            aria-labelledby="tab-workflows"
          >
            {isOnWorkflowDetail && workflowId ? (
              <WorkflowDetail
                workflowId={workflowId}
                activeTag={activeTag}
                onBack={handleBackFromWorkflow}
              />
            ) : (
              <WorkflowsView
                selectedTag={activeTag}
                onSelectTag={handleSelectTag}
                onSelectWorkflow={handleSelectWorkflow}
              />
            )}
          </div>
        )}

        {/* Performance panel */}
        {isOnPerfTab && (
          <div
            id="panel-perf"
            role="tabpanel"
            aria-labelledby="tab-perf"
          >
            <PerformanceView />
          </div>
        )}
      </main>
    </div>
  );
}
