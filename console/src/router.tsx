import {
  createRouter,
  createHashHistory,
  createRootRoute,
  createRoute,
  Outlet,
} from '@tanstack/react-router';
import { WorkspaceView } from './views/WorkspaceView';
import { SessionDetail } from './views/SessionDetail';
import { AppShell } from './AppShell';

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({
  component: AppShell,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspaceRoute,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId',
  component: SessionRoute,
});

// ---------------------------------------------------------------------------
// Route components
// ---------------------------------------------------------------------------

function WorkspaceRoute() {
  return <WorkspaceView />;
}

function SessionRoute() {
  const { sessionId } = sessionRoute.useParams();
  return (
    <>
      {/* WorkspaceView kept mounted (hidden) so scroll position survives back-navigation */}
      <WorkspaceView hidden />
      <SessionDetail sessionId={sessionId} />
    </>
  );
}

// Keep TypeScript happy -- Outlet is used by the root route via AppShell
void Outlet;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routeTree = rootRoute.addChildren([workspaceRoute, sessionRoute]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
});

// Register router for type-safety across the app
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
