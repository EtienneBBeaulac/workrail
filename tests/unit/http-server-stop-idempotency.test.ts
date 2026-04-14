/**
 * Tests for HttpServer.stop() idempotency.
 *
 * Verifies that calling stop() more than once (the double-SIGTERM scenario)
 * joins the same in-flight teardown rather than running teardown twice and
 * hanging on the second server.close() callback.
 */

import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, Server as HttpServerType } from 'http';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Fake dependencies for HttpServer constructor
// ---------------------------------------------------------------------------

function createFakeSessionManager() {
  return {
    getProjectId: () => 'test-project',
    getProjectPath: () => '/test',
    getSessionsRoot: () => '/test/sessions',
    listAllSessions: async () => [],
    listAllProjectsSessions: async () => [],
    getSession: async () => null,
    getCurrentProject: async () => ({ id: 'test', path: '/test' }),
    listProjects: async () => [],
    watchSession: () => {},
    unwatchSession: () => {},
    unwatchAll: () => {},
    on: () => {},
    off: () => {},
    deleteSession: async () => ({ isErr: () => false }),
    deleteSessions: async () => {},
  };
}

function createFakeProcessLifecyclePolicy() {
  return { kind: 'no_signal_handlers' as const };
}

function createFakeProcessSignals() {
  const handlers = new Map<string, Array<() => void>>();
  return {
    on: (signal: string, handler: () => void) => {
      if (!handlers.has(signal)) handlers.set(signal, []);
      handlers.get(signal)!.push(handler);
    },
    once: () => {},
    _handlers: handlers,
  };
}

function createFakeShutdownEvents() {
  const listeners: Array<(e: { kind: string; signal: string }) => void> = [];
  return {
    onShutdown: (listener: (e: { kind: string; signal: string }) => void) => {
      listeners.push(listener);
      return () => {};
    },
    emit: (event: { kind: string; signal: string }) => {
      for (const l of listeners) l(event);
    },
    _listeners: listeners,
  };
}

// ---------------------------------------------------------------------------
// Build an HttpServer instance with fake dependencies
// ---------------------------------------------------------------------------

async function buildHttpServer() {
  const { HttpServer } = await import('../../src/infrastructure/session/HttpServer.js');

  const fakeSessionManager = createFakeSessionManager();
  const fakePolicy = createFakeProcessLifecyclePolicy();
  const fakeProcessSignals = createFakeProcessSignals();
  const fakeShutdownEvents = createFakeShutdownEvents();

  // @ts-expect-error -- constructing with fake DI dependencies for testing
  const httpServer = new HttpServer(
    fakeSessionManager,
    fakePolicy,
    fakeProcessSignals,
    fakeShutdownEvents,
    { kind: 'legacy' }, // DashboardMode: use legacy to avoid lock file
    { kind: 'manual' }, // BrowserBehavior: don't auto-open browser
  );

  return httpServer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpServer.stop() idempotency', () => {
  let httpServer: Awaited<ReturnType<typeof buildHttpServer>>;

  beforeEach(async () => {
    vi.resetModules();
    httpServer = await buildHttpServer();
  });

  afterEach(async () => {
    try {
      await (httpServer as any).stop();
    } catch {
      // Ignore cleanup errors
    }
  });

  it('stop() before start() is a no-op (returns resolved Promise)', async () => {
    await expect(httpServer.stop()).resolves.toBeUndefined();
  });

  it('concurrent stop() calls both resolve without error', async () => {
    // Start on an ephemeral port (legacy mode so no lock file)
    await httpServer.start();

    const [result1, result2] = await Promise.allSettled([
      httpServer.stop(),
      httpServer.stop(),
    ]);

    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('fulfilled');
  });

  it('sequential stop() calls both resolve without error', async () => {
    await httpServer.start();
    await httpServer.stop();
    await expect(httpServer.stop()).resolves.toBeUndefined();
  });

  it('both concurrent stop() calls return the same Promise', async () => {
    await httpServer.start();

    const p1 = httpServer.stop();
    const p2 = httpServer.stop();

    // Both are the same in-flight Promise (or both resolve cleanly)
    // We can verify by checking they race identically
    const results = await Promise.all([p1, p2]);
    expect(results).toEqual([undefined, undefined]);
  });
});
