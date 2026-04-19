/**
 * Tests for POST /api/v2/sessions/:sessionId/steer endpoint
 */

import express from 'express';
import * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountConsoleRoutes } from '../../src/v2/usecases/console-routes.js';
import type { SteerRegistry } from '../../src/daemon/workflow-runner.js';
import type { ConsoleService } from '../../src/v2/usecases/console-service.js';

const FAKE_CONSOLE_SERVICE = {
  getSessionsDir: () => '/tmp/steer-test-sessions',
  getSessionList: async () => ({ isOk: () => true, value: { sessions: [] } }),
  getSessionDetail: async () => ({ isOk: () => false, value: null, isErr: () => true, error: { code: 'SESSION_LOAD_FAILED', message: 'not found' } }),
  getNodeDetail: async () => ({ isOk: () => false, value: null, isErr: () => true, error: { code: 'NODE_NOT_FOUND', message: 'not found' } }),
} as unknown as ConsoleService;

async function startServer(steerRegistry?: SteerRegistry): Promise<{ baseUrl: string; cleanup: () => Promise<void> }> {
  const app = express();
  const stopWatcher = mountConsoleRoutes(app, FAKE_CONSOLE_SERVICE, undefined, undefined, undefined, undefined, undefined, undefined, steerRegistry);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = (addr && typeof addr === 'object') ? addr.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, cleanup: () => new Promise<void>((res) => { stopWatcher(); server.close(() => res()); }) });
    });
  });
}

async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe('POST /api/v2/sessions/:sessionId/steer', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) { await cleanup(); cleanup = null; } });

  it('TC1: returns 503 when no steerRegistry is injected', async () => {
    const { baseUrl, cleanup: c } = await startServer(undefined);
    cleanup = c;
    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, { text: 'hello' });
    expect(status).toBe(503);
    expect((json as { error: string }).error).toContain('daemon context');
  });

  it('TC2: returns 400 when text is missing', async () => {
    const { baseUrl, cleanup: c } = await startServer(new Map());
    cleanup = c;
    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, {});
    expect(status).toBe(400);
    expect((json as { error: string }).error).toContain('text');
  });

  it('TC3: returns 400 when text is empty string', async () => {
    const { baseUrl, cleanup: c } = await startServer(new Map());
    cleanup = c;
    const { status } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, { text: '  ' });
    expect(status).toBe(400);
  });

  it('TC4: returns 400 when text is not a string', async () => {
    const { baseUrl, cleanup: c } = await startServer(new Map());
    cleanup = c;
    const { status } = await post(`${baseUrl}/api/v2/sessions/sess_abc123/steer`, { text: 42 });
    expect(status).toBe(400);
  });

  it('TC5: returns 404 when sessionId is not registered', async () => {
    const { baseUrl, cleanup: c } = await startServer(new Map());
    cleanup = c;
    const { status, json } = await post(`${baseUrl}/api/v2/sessions/sess_unknown/steer`, { text: 'inject me' });
    expect(status).toBe(404);
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
    expect((json as { success: boolean }).success).toBe(true);
    expect(received).toEqual(['coordinator says hi']);
  });

  it('TC7: returns 404 after session is deregistered', async () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_deregistered', (text) => { received.push(text); });
    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;
    const r1 = await post(`${baseUrl}/api/v2/sessions/sess_deregistered/steer`, { text: 'first' });
    expect(r1.status).toBe(200);
    registry.delete('sess_deregistered');
    const r2 = await post(`${baseUrl}/api/v2/sessions/sess_deregistered/steer`, { text: 'second' });
    expect(r2.status).toBe(404);
    expect(received).toEqual(['first']);
  });

  it('TC8: multiple steers accumulate in callback', async () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_multi', (text) => { received.push(text); });
    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;
    await post(`${baseUrl}/api/v2/sessions/sess_multi/steer`, { text: 'part one' });
    await post(`${baseUrl}/api/v2/sessions/sess_multi/steer`, { text: 'part two' });
    expect(received).toEqual(['part one', 'part two']);
  });

  it('TC9: text is trimmed before rejection check', async () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_trim', (text) => { received.push(text); });
    const { baseUrl, cleanup: c } = await startServer(registry);
    cleanup = c;
    const { status } = await post(`${baseUrl}/api/v2/sessions/sess_trim/steer`, { text: '  hello  ' });
    expect(status).toBe(200);
    expect(received).toEqual(['hello']);
  });
});

describe('SteerRegistry (Map semantics)', () => {
  it('TC10: register and invoke callback', () => {
    const registry: SteerRegistry = new Map();
    const received: string[] = [];
    registry.set('sess_1', (text) => { received.push(text); });
    registry.get('sess_1')!('hello');
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
