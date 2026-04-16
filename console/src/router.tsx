import {
  createRouter,
  createHashHistory,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router';
import { AppShell } from './AppShell';

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------
// Route components are null -- AppShell owns all view rendering directly,
// keeping WorkspaceView permanently mounted for scroll position preservation.

const rootRoute = createRootRoute({
  component: AppShell,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => null,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId',
  component: () => null,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows',
  validateSearch: (search: Record<string, unknown>) => ({
    tag: typeof search.tag === 'string' ? search.tag : undefined,
  }),
  component: () => null,
});

const workflowDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows/$workflowId',
  validateSearch: (search: Record<string, unknown>) => ({
    tag: typeof search.tag === 'string' ? search.tag : undefined,
  }),
  component: () => null,
});

const perfRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/perf',
  component: () => null,
});

const autoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auto',
  component: () => null,
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routeTree = rootRoute.addChildren([
  workspaceRoute,
  sessionRoute,
  workflowsRoute,
  workflowDetailRoute,
  perfRoute,
  autoRoute,
]);

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
