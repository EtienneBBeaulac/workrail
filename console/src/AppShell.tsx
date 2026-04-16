import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useMatchRoute, useRouterState } from '@tanstack/react-router';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionDetail } from './views/SessionDetail';
import { WorkflowsView } from './views/WorkflowsView';
import { WorkflowDetail } from './views/WorkflowDetail';
import { PerformanceView } from './views/PerformanceView';
import { AutoView } from './views/AutoView';
import { CutCornerBox } from './components/CutCornerBox';
import { BracketBadge } from './components/BracketBadge';
import { PathBreadcrumb } from './components/PathBreadcrumb';
import { useWorkspaceViewModel } from './hooks/useWorkspaceViewModel';
import { useSessionListViewModel } from './hooks/useSessionListViewModel';
import { useWorkflowsViewModel } from './hooks/useWorkflowsViewModel';
import { useWorkflowDetailViewModel } from './hooks/useWorkflowDetailViewModel';
import { usePerformanceViewModel } from './hooks/usePerformanceViewModel';
import { useSessionDetailViewModel } from './hooks/useSessionDetailViewModel';

/**
 * AppShell is the root route component. It owns all view rendering directly,
 * keeping WorkspaceView permanently mounted for scroll position preservation.
 *
 * Navigation state is derived from the URL so browser back/forward work
 * correctly without any React state synchronization.
 */

/** Single source of truth for tab order. Add new tabs here only. */
const TAB_ORDER = [
  { id: 'workspace' as const, path: '/' },
  { id: 'workflows' as const, path: '/workflows' },
  { id: 'auto' as const, path: '/auto' },
  { id: 'perf' as const, path: '/perf' },
];

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
  const autoMatch = matchRoute({ to: '/auto' });

  // Single source of truth for active tab -- structurally impossible for two tabs to be active.
  const activeTab = workflowsMatch !== false || workflowDetailMatch !== false
    ? 'workflows' as const
    : perfMatch !== false
    ? 'perf' as const
    : autoMatch !== false
    ? 'auto' as const
    : 'workspace' as const;

  const isInSessionDetail = sessionMatch !== false;
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
  // Workspace ViewModel
  // ---------------------------------------------------------------------------

  // useWorkspaceViewModel is called here (not inside WorkspaceView) so the
  // keyboard handler is disabled when hidden=true (SessionDetail overlaid).
  const workspaceViewModel = useWorkspaceViewModel(isInSessionDetail);

  // useSessionListViewModel is called here (not inside WorkspaceView) so that
  // WorkspaceView remains a pure presenter. The archive panel is an inline
  // sub-panel of WorkspaceView -- AppShell owns all ViewModels.
  const sessionListViewModel = useSessionListViewModel({
    onSelectSession: workspaceViewModel.onSelectSession,
  });

  // ---------------------------------------------------------------------------
  // Telemetry badges -- derived from workspace ViewModel to avoid a second useSessionList call.
  // ---------------------------------------------------------------------------

  const liveCount = workspaceViewModel.state.kind === 'ready' ? workspaceViewModel.state.liveCount : 0;
  const blockedCount = workspaceViewModel.state.kind === 'ready' ? workspaceViewModel.state.blockedCount : 0;

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

  const handleBackFromWorkflow = useCallback(() => {
    void navigate({ to: '/workflows', search: { tag: activeTag ?? undefined } });
  }, [navigate, activeTag]);

  const handleNavigateToWorkflow = useCallback(
    (id: string) => {
      void navigate({ to: '/workflows/$workflowId', params: { workflowId: id }, search: { tag: activeTag ?? undefined } });
    },
    [navigate, activeTag],
  );

  // ---------------------------------------------------------------------------
  // Workflows ViewModel
  // ---------------------------------------------------------------------------

  // useWorkflowsViewModel is called here so AppShell owns the URL <-> state sync.
  // initialTag comes from the URL search param; onSelectTag navigates to update the URL.
  const workflowsViewModel = useWorkflowsViewModel({
    initialTag: activeTag,
    onSelectTag: handleSelectTag,
  });

  // ---------------------------------------------------------------------------
  // WorkflowDetail ViewModel
  // ---------------------------------------------------------------------------

  // Called unconditionally (hooks rules). workflowId is null when not on the
  // workflow detail route, which disables the underlying query and keeps state
  // at 'loading' so the keyboard handler is never installed.
  const workflowDetailViewModel = useWorkflowDetailViewModel({
    workflowId,
    activeTag,
    onBack: handleBackFromWorkflow,
    onNavigateToWorkflow: handleNavigateToWorkflow,
  });

  // ---------------------------------------------------------------------------
  // SessionDetail ViewModel
  // ---------------------------------------------------------------------------

  // Called unconditionally (hooks rules). The underlying useSessionDetail query
  // has enabled: !!sessionId, so an empty string triggers no network request.
  const sessionDetailViewModel = useSessionDetailViewModel(sessionId ?? '');

  // ---------------------------------------------------------------------------
  // Performance ViewModel
  // ---------------------------------------------------------------------------

  const performanceViewModel = usePerformanceViewModel();

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
        const current = TAB_ORDER.findIndex((t) => t.id === activeTab);
        const next = e.key === 'ArrowRight'
          ? (current + 1) % TAB_ORDER.length
          : (current - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        const dest = TAB_ORDER[next]!;
        void navigate({ to: dest.path, ...(dest.path === '/workflows' ? { search: { tag: undefined } } : {}) });
      }
    }
    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, navigate]);

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
            <PathBreadcrumb
              segments={[
                { label: 'Workspace', onClick: handleBackFromSession },
                { label: sessionId?.slice(-12) ?? '' },
              ]}
            />
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
              aria-selected={activeTab === 'workspace'}
              aria-controls="panel-workspace"
              tabIndex={activeTab === 'workspace' ? 0 : -1}
              onClick={() => handleTabClick('workspace', () => void navigate({ to: '/' }))}
              className={[
                'tab-btn px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.30em] transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none',
                activeTab === 'workspace'
                  ? 'tab-btn--active text-[var(--accent)] text-glow-amber'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                activatingTab === 'workspace' ? 'tab-activating' : '',
              ].join(' ')}
              style={activeTab === 'workspace' ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
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
              aria-selected={activeTab === 'workflows'}
              aria-controls="panel-workflows"
              tabIndex={activeTab === 'workflows' ? 0 : -1}
              onClick={() => handleTabClick('workflows', () => void navigate({ to: '/workflows', search: { tag: undefined } }))}
              className={[
                'tab-btn px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.30em] transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none',
                activeTab === 'workflows'
                  ? 'tab-btn--active text-[var(--accent)] text-glow-amber'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                activatingTab === 'workflows' ? 'tab-activating' : '',
              ].join(' ')}
              style={activeTab === 'workflows' ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
            >
              <span className="tab-corner tab-corner--tl" aria-hidden="true" />
              <span className="tab-corner tab-corner--tr" aria-hidden="true" />
              <span className="tab-corner tab-corner--bl" aria-hidden="true" />
              <span className="tab-corner tab-corner--br" aria-hidden="true" />
              Workflows
            </button>
            <button
              role="tab"
              id="tab-auto"
              aria-selected={activeTab === 'auto'}
              aria-controls="panel-auto"
              tabIndex={activeTab === 'auto' ? 0 : -1}
              onClick={() => handleTabClick('auto', () => void navigate({ to: '/auto' }))}
              className={[
                'tab-btn px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.30em] transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none',
                activeTab === 'auto'
                  ? 'tab-btn--active text-[var(--accent)] text-glow-amber'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                activatingTab === 'auto' ? 'tab-activating' : '',
              ].join(' ')}
              style={activeTab === 'auto' ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
            >
              <span className="tab-corner tab-corner--tl" aria-hidden="true" />
              <span className="tab-corner tab-corner--tr" aria-hidden="true" />
              <span className="tab-corner tab-corner--bl" aria-hidden="true" />
              <span className="tab-corner tab-corner--br" aria-hidden="true" />
              Auto
            </button>
            <button
              role="tab"
              id="tab-perf"
              aria-selected={activeTab === 'perf'}
              aria-controls="panel-perf"
              tabIndex={activeTab === 'perf' ? 0 : -1}
              onClick={() => handleTabClick('perf', () => void navigate({ to: '/perf' }))}
              className={[
                'tab-btn px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.30em] transition-colors duration-150',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none',
                activeTab === 'perf'
                  ? 'tab-btn--active text-[var(--accent)] text-glow-amber'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                activatingTab === 'perf' ? 'tab-activating' : '',
              ].join(' ')}
              style={activeTab === 'perf' ? { backgroundColor: 'rgba(244, 196, 48, 0.06)' } : undefined}
            >
              <span className="tab-corner tab-corner--tl" aria-hidden="true" />
              <span className="tab-corner tab-corner--tr" aria-hidden="true" />
              <span className="tab-corner tab-corner--bl" aria-hidden="true" />
              <span className="tab-corner tab-corner--br" aria-hidden="true" />
              Performance
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
          hidden={activeTab === 'workflows' || activeTab === 'perf' || activeTab === 'auto'}
        >
          {/* WorkspaceView is always mounted -- hidden via CSS only so scroll
              position in scrollYRef and expandStateRef survive back-navigation
              from SessionDetail and SSE-driven remounts of child components. */}
          <WorkspaceView viewModel={workspaceViewModel} sessionListViewModel={sessionListViewModel} hidden={isInSessionDetail} />
          {isInSessionDetail && sessionId && (
            <SessionDetail viewModel={sessionDetailViewModel} />
          )}
        </div>

        {/* Workflows panel */}
        {activeTab === 'workflows' && (
          <div
            id="panel-workflows"
            role="tabpanel"
            aria-labelledby="tab-workflows"
          >
            {isOnWorkflowDetail && workflowId ? (
              <WorkflowDetail viewModel={workflowDetailViewModel} />
            ) : (
              <WorkflowsView viewModel={workflowsViewModel} />
            )}
          </div>
        )}

        {/* AUTO panel */}
        {activeTab === 'auto' && (
          <div
            id="panel-auto"
            role="tabpanel"
            aria-labelledby="tab-auto"
          >
            <AutoView />
          </div>
        )}

        {/* Performance panel */}
        {activeTab === 'perf' && (
          <div
            id="panel-perf"
            role="tabpanel"
            aria-labelledby="tab-perf"
          >
            <PerformanceView viewModel={performanceViewModel} />
          </div>
        )}
      </main>
    </div>
  );
}
