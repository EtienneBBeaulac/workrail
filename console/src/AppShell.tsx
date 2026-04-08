import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useMatchRoute, useRouterState } from '@tanstack/react-router';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionDetail } from './views/SessionDetail';
import { WorkflowsView } from './views/WorkflowsView';
import { WorkflowDetail } from './views/WorkflowDetail';
import { CutCornerBox } from './components/CutCornerBox';
import { BracketBadge } from './components/BracketBadge';
import { useSessionList } from './api/hooks';

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
  // Telemetry badges
  // ---------------------------------------------------------------------------

  const { data: sessionData } = useSessionList();
  const liveCount = sessionData?.sessions.filter(s => s.status === 'in_progress').length ?? 0;
  const blockedCount = sessionData?.sessions.filter(s => s.status === 'blocked').length ?? 0;

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
  // Tab activation flicker
  // ---------------------------------------------------------------------------

  const [activatingTab, setActivatingTab] = useState<string | null>(null);

  const handleTabClick = useCallback(
    (tabId: string, navigationFn: () => void) => {
      navigationFn();
      setActivatingTab(tabId);
      // Clear after animation completes (180ms animation + small buffer)
      setTimeout(() => setActivatingTab(null), 200);
    },
    [],
  );

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
      className="min-h-screen"
      style={{ '--app-header-height': '56px' } as CSSProperties}
    >
      <header
        style={{
          background: 'rgba(23, 27, 40, 0.92)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          borderBottom: '1px solid rgba(244, 196, 48, 0.25)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        }}
        className="fixed top-0 w-full z-50 flex items-center h-14 px-4 gap-6"
      >
        {/* Left zone -- identity */}
        <div className="flex items-center gap-3 shrink-0">
          <CutCornerBox
            cut={8}
            borderColor="rgba(244, 196, 48, 0.5)"
            background="rgba(27, 31, 44, 0.8)"
            className="relative w-10 h-10"
          >
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="font-mono text-[11px] font-bold text-[var(--accent)] tracking-widest">WR</span>
            </div>
          </CutCornerBox>
          <div className="hidden sm:flex flex-col leading-none">
            <span className="font-mono text-[11px] font-bold text-[var(--text-primary)] tracking-[0.25em] uppercase">
              WR_CONSOLE
            </span>
            <span className="font-mono text-[9px] text-[var(--text-muted)] tracking-[0.15em]">
              // V{import.meta.env.VITE_APP_VERSION}
            </span>
          </div>
        </div>

        {/* Center zone -- navigation */}
        {isInSessionDetail && sessionId ? (
          /* Session detail breadcrumb */
          <nav className="flex items-center flex-1 justify-center">
            <button
              onClick={handleBackFromSession}
              className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none"
            >
              &larr; WORKSPACE // {sessionId.slice(-12)}
            </button>
          </nav>
        ) : (
          /* Tab navigation */
          <div
            role="tablist"
            aria-label="Console sections"
            ref={tabBarRef}
            className="flex items-center gap-1 flex-1 justify-center"
          >
            <button
              role="tab"
              id="tab-workspace"
              aria-selected={!isOnWorkflowsTab}
              aria-controls="panel-workspace"
              tabIndex={!isOnWorkflowsTab ? 0 : -1}
              onClick={() => handleTabClick('workspace', () => void navigate({ to: '/' }))}
              className={[
                'tab-btn px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.30em] transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none',
                !isOnWorkflowsTab
                  ? 'tab-btn--active text-[var(--accent)] text-glow-amber'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                activatingTab === 'workspace' ? 'tab-activating' : '',
              ].join(' ')}
              style={!isOnWorkflowsTab ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
            >
              <span className="tab-corner tab-corner--tl" aria-hidden="true" />
              <span className="tab-corner tab-corner--tr" aria-hidden="true" />
              <span className="tab-corner tab-corner--bl" aria-hidden="true" />
              <span className="tab-corner tab-corner--br" aria-hidden="true" />
              Workspace
            </button>
            <button
              role="tab"
              id="tab-workflows"
              aria-selected={isOnWorkflowsTab}
              aria-controls="panel-workflows"
              tabIndex={isOnWorkflowsTab ? 0 : -1}
              onClick={() => handleTabClick('workflows', () => void navigate({ to: '/workflows', search: { tag: undefined } }))}
              className={[
                'tab-btn px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.30em] transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none',
                isOnWorkflowsTab
                  ? 'tab-btn--active text-[var(--accent)] text-glow-amber'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                activatingTab === 'workflows' ? 'tab-activating' : '',
              ].join(' ')}
              style={isOnWorkflowsTab ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
            >
              <span className="tab-corner tab-corner--tl" aria-hidden="true" />
              <span className="tab-corner tab-corner--tr" aria-hidden="true" />
              <span className="tab-corner tab-corner--bl" aria-hidden="true" />
              <span className="tab-corner tab-corner--br" aria-hidden="true" />
              Workflows
            </button>
          </div>
        )}

        {/* Right zone -- telemetry badges */}
        <div className="flex items-center gap-2 shrink-0">
          {liveCount > 0 && (
            <BracketBadge
              label={`${Math.min(liveCount, 9)}${liveCount > 9 ? '+' : ''} LIVE`}
              color="var(--accent-strong)"
              pulse
              role="status"
              aria-label={`${liveCount} live session${liveCount === 1 ? '' : 's'}`}
            />
          )}
          {blockedCount > 0 && (
            <BracketBadge
              label={`${Math.min(blockedCount, 9)}${blockedCount > 9 ? '+' : ''} BLOCKED`}
              color="var(--blocked)"
              role="status"
              aria-label={`${blockedCount} blocked session${blockedCount === 1 ? '' : 's'}`}
            />
          )}
        </div>
      </header>

      <main className="p-6" style={{ paddingTop: 'calc(56px + 1.5rem)' }}>
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
