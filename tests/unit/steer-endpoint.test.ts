/**
 * Tests for POST /api/v2/sessions/:sessionId/steer endpoint
 *
 * Covers:
 * - 200 OK when sessionId is registered and text is valid
 * - 400 when text is missing or empty
 * - 404 when sessionId is not in the registry
 * - 503 when steerRegistry is not injected (standalone console path)
 * - Multiple steers between turn_end events: both land in pendingSteerParts
 * - SteerRegistry type: register / deregister / invoke semantics
 */

import express from 'express';
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountConsoleRoutes } from '../../src/v2/usecases/console-routes.js';
import type { SteerRegistry } from '../../src/daemon/workflow-runner.js';
import type { ConsoleService } from '../../src/v2/usecases/console-service.js';

// ---------------------------------------------------------------------------
// Minimal fake ConsoleService (mountConsoleRoutes requires it)
// ---------------------------------------------------------------------------

const FAKE_CONSOLE_SERVICE = {
  getSessionsDir: () => '/tmp/steer-test-sessions',
  getSessionList: async () => ({ isOk: () => true, value: { sessions: [] } }),
  getSessionDetail: async () => ({ isOk: () => false, value: null, isErr: () => true, error: { code: 'SESSION_LOAD_FAILED', message: 'not found' } }),
  getNodeDetail: async () => ({ isOk: () => false, value: null, isErr: () => true, error: { code: 'NODE_NOT_FOUND', message: 'not found' } }),
} as unknown as ConsoleService;

// ---------------------------------------------------------------------------
// Test helper: spin up an in-process Express server
// ---------------------------------------------------------------------------

function makeTestServer(steerRegistry?: SteerRegistry): {
  server: http.Server;
  baseUrl: string;
  cleanup: () => Promise<void>;
} {
  const app = express();
  const stopWatcher = mountConsoleRoutes(
    app,
    FAKE_CONSOLE_SERVICE,
    undefined, // workflowService
    undefined, // timingRingBuffer
    undefined, // toolCallsPerfFile
    undefined, // serverVersion
    undefined, // v2ToolContext
    undefined, // triggerRouter
    steerRegistry,
  );

  const server = http.createServer(app);

  return {
    server,
    baseUrl: '', // set after listen
    cleanup: () => new Promise<void>((resolve) => {
      stopWatcher();
      server.close(() => resolve());
    }),
  };
}

async function startServer(steerRegistry?: SteerRegistry): Promise<{
  baseUrl: string;
  cleanup: () => Promise<void>;
}> {
  const { server, cleanup } = makeTestServer(steerRegistry);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = (addr && typeof addr === 'object') ? addr.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, cleanup });
    });
  });
}

async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v2/sessions/:sessionId/steer', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('TC1: returns 503 when no steerRegistry is injected', async () => {
    const { baseUrl, cleanup: c } = await startServer(undefined);
    cleanup = c;

    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, { text: 'hello' });

    expect(status).toBe(503);
    expect(json).toMatchObject({ success: false });
    expect((json as { error: string }).error).toContain('daemon context');
  });

  it('TC2: returns 400 when text is missing', async () => {
    const registry: SteerRegistry = new Map();
    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, {});

    expect(status).toBe(400);
    expect(json).toMatchObject({ success: false });
    expect((json as { error: string }).error).toContain('text');
  });

  it('TC3: returns 400 when text is empty string', async () => {
    const registry: SteerRegistry = new Map();
    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, { text: '  ' });

    expect(status).toBe(400);
    expect(json).toMatchObject({ success: false });
  });

  it('TC4: returns 400 when text is not a string', async () => {
    const registry: SteerRegistry = new Map();
    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, { text: 42 });

    expect(status).toBe(400);
    expect(json).toMatchObject({ success: false });
  });

  it('TC5: returns 404 when sessionId is not registered', async () => {
    const registry: SteerRegistry = new Map();
    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_unknown/steer`, { text: 'inject me' });

    expect(status).toBe(404);
    expect(json).toMatchObject({ success: false });
    expect((json as { error: string }).error).toContain('not found');
  });

  it('TC6: returns 200 and calls callback when sessionId is registered', async () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_alive', (text) => { received.push(text); });

    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_alive/steer`, { text: 'coordinator says hi' });

    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true });
    expect(received).toEqual(['coordinator says hi']);
  });

  it('TC7: returns 404 after session is deregistered', async () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_deregistered', (text) => { received.push(text); });

    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    // First call: registered -> 200
    const r1 = await post(`${baseUrl}/api/v2/sessions/sess_deregistered/steer`, { text: 'first' });
    expect(r1.status).toBe(200);

    // Simulate session completion: deregister
    registry.delete('sess_deregistered');

    // Second call: deregistered -> 404
    const r2 = await post(`${baseUrl}/api/v2/sessions/sess_deregistered/steer`, { text: 'second' });
    expect(r2.status).toBe(404);

    // Only first call was delivered
    expect(received).toEqual(['first']);
  });

  it('TC8: multiple steers: callback called once per POST, text accumulates', async () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_multi', (text) => { received.push(text); });

    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    await post(`${baseUrl}/api/v2/sessions/sess_multi/steer`, { text: 'part one' });
    await post(`${baseUrl}/api/v2/sessions/sess_multi/steer`, { text: 'part two' });

    expect(received).toEqual(['part one', 'part two']);
  });

  it('TC9: text is trimmed before rejection check (trailing whitespace)', async () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_trim', (text) => { received.push(text); });

    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;

    // Leading/trailing whitespace is trimmed; if result is non-empty, call succeeds
    const { status } = await post(`${baseUrl}/api/v2/sessions/sess_trim/steer`, { text: '  hello  ' });

    expect(status).toBe(200);
    // The callback receives the trimmed text
    expect(received).toEqual(['hello']);
  });
});

// ---------------------------------------------------------------------------
// SteerRegistry type tests (pure logic, no server needed)
// ---------------------------------------------------------------------------

describe('SteerRegistry (Map semantics)', () => {
  it('TC10: register and invoke callback', () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];

    registry.set('sess_1', (text) => { received.push(text); });

    const cb = registry.get('sess_1');
    expect(cb).toBeDefined();
    cb!('hello');
    expect(received).toEqual(['hello']);
  });

  it('TC11: deregister removes callback', () => {
    const registry: SteerRegistry = new Map();
    registry.set('sess_1', vi.fn());
    registry.delete('sess_1');
    expect(registry.has('sess_1')).toBe(false);
  });

  it('TC12: multiple sessions are independent', () => {
    const registry: SteerRegistry = new Map();
    const a: string[] = [];
    const b: string[] = [];

    registry.set('sess_a', (text) => a.push(text));
    registry.set('sess_b', (text) => b.push(text));

    registry.get('sess_a')!('to-a');
    registry.get('sess_b')!('to-b');

    expect(a).toEqual(['to-a']);
    expect(b).toEqual(['to-b']);
  });
});
