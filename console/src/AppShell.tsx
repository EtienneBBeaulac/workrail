import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate, useMatchRoute, useRouterState } from '@tanstack/react-router';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionDetail } from './views/SessionDetail';
import { WorkflowsView } from './views/WorkflowsView';
import { WorkflowDetail } from './views/WorkflowDetail';

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

  const isInSessionDetail = sessionMatch !== false;
  const isOnWorkflowsTab = workflowsMatch !== false || workflowDetailMatch !== false;
  const isOnWorkflowDetail = workflowDetailMatch !== false;

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

  const tabBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (isOnWorkflowsTab) {
          void navigate({ to: '/' });
        } else {
          void navigate({ to: '/workflows', search: { tag: undefined } });
        }
      }
    }
    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [isOnWorkflowsTab, navigate]);

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
                aria-selected={!isOnWorkflowsTab}
                aria-controls="panel-workspace"
                tabIndex={!isOnWorkflowsTab ? 0 : -1}
                onClick={() => void navigate({ to: '/' })}
                className={[
                  'px-3 py-1 rounded text-sm font-medium transition-colors',
                  !isOnWorkflowsTab
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
          hidden={isOnWorkflowsTab}
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
      </main>
    </div>
  );
}
