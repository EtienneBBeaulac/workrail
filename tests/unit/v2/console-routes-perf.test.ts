/**
 * Tests for the GET /api/v2/perf/tool-calls route in mountConsoleRoutes.
 *
 * We use express + Node's built-in http to spin up a real (ephemeral) server
 * for each test group, avoiding the need for supertest or other HTTP libraries.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  ToolCallTimingRingBuffer,
  type ToolCallTiming,
} from '../../../src/mcp/tool-call-timing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a GET request to the test server and return parsed JSON + status code.
 */
function get(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk: string) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    }).on('error', reject);
  });
}

/**
 * Create a minimal express app that only mounts the perf route.
 * We replicate the route inline here to keep the test self-contained and
 * to avoid depending on DEV_MODE module state.
 */
function buildPerfApp(timingRingBuffer?: ToolCallTimingRingBuffer): express.Application {
  const app = express();
  app.get('/api/v2/perf/tool-calls', (req, res) => {
    const rawLimit = req.query['limit'];
    const limit = typeof rawLimit === 'string' ? parseInt(rawLimit, 10) : undefined;
    const safeLimit = (limit !== undefined && Number.isFinite(limit) && limit > 0) ? limit : undefined;
    const observations = timingRingBuffer ? timingRingBuffer.recent(safeLimit) : [];
    res.json({ success: true, data: { observations, total: timingRingBuffer?.size ?? 0, devMode: true } });
  });
  return app;
}

function startServer(app: express.Application): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v2/perf/tool-calls', () => {
  let server: http.Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  it('returns empty observations when ring buffer is absent (undefined)', async () => {
    const app = buildPerfApp(undefined);
    ({ server, baseUrl } = await startServer(app));

    const { status, body } = await get(`${baseUrl}/api/v2/perf/tool-calls`);
    expect(status).toBe(200);
    const b = body as { success: boolean; data: { observations: unknown[]; total: number } };
    expect(b.success).toBe(true);
    expect(b.data.observations).toEqual([]);
    expect(b.data.total).toBe(0);
  });

  it('returns empty observations when ring buffer is empty', async () => {
    const buf = new ToolCallTimingRingBuffer(10);
    const app = buildPerfApp(buf);
    ({ server, baseUrl } = await startServer(app));

    const { status, body } = await get(`${baseUrl}/api/v2/perf/tool-calls`);
    expect(status).toBe(200);
    const b = body as { success: boolean; data: { observations: unknown[]; total: number } };
    expect(b.success).toBe(true);
    expect(b.data.observations).toEqual([]);
    expect(b.data.total).toBe(0);
  });

  it('returns observations with correct shape', async () => {
    const buf = new ToolCallTimingRingBuffer(10);
    const timing: ToolCallTiming = {
      toolName: 'start_workflow',
      startedAtMs: 1000,
      durationMs: 42.5,
      outcome: 'success',
    };
    buf.push(timing);

    const app = buildPerfApp(buf);
    ({ server, baseUrl } = await startServer(app));

    const { status, body } = await get(`${baseUrl}/api/v2/perf/tool-calls`);
    expect(status).toBe(200);
    const b = body as { success: boolean; data: { observations: ToolCallTiming[]; total: number } };
    expect(b.success).toBe(true);
    expect(b.data.total).toBe(1);
    expect(b.data.observations).toHaveLength(1);
    expect(b.data.observations[0].toolName).toBe('start_workflow');
    expect(b.data.observations[0].durationMs).toBe(42.5);
    expect(b.data.observations[0].outcome).toBe('success');
  });

  it('includes devMode field in the response', async () => {
    const app = buildPerfApp(new ToolCallTimingRingBuffer(5));
    ({ server, baseUrl } = await startServer(app));

    const { body } = await get(`${baseUrl}/api/v2/perf/tool-calls`);
    const b = body as { data: { devMode: boolean } };
    expect(typeof b.data.devMode).toBe('boolean');
  });

  it('respects valid limit query parameter', async () => {
    const buf = new ToolCallTimingRingBuffer(10);
    for (let i = 0; i < 5; i++) {
      buf.push({ toolName: `tool_${i}`, startedAtMs: i, durationMs: i, outcome: 'success' });
    }

    const app = buildPerfApp(buf);
    ({ server, baseUrl } = await startServer(app));

    const { body } = await get(`${baseUrl}/api/v2/perf/tool-calls?limit=2`);
    const b = body as { data: { observations: ToolCallTiming[]; total: number } };
    expect(b.data.observations).toHaveLength(2);
    // total reflects buffer size, not the limited result
    expect(b.data.total).toBe(5);
  });

  it('ignores NaN limit and returns all observations', async () => {
    const buf = new ToolCallTimingRingBuffer(10);
    buf.push({ toolName: 'a', startedAtMs: 0, durationMs: 1, outcome: 'success' });
    buf.push({ toolName: 'b', startedAtMs: 0, durationMs: 2, outcome: 'success' });

    const app = buildPerfApp(buf);
    ({ server, baseUrl } = await startServer(app));

    const { body } = await get(`${baseUrl}/api/v2/perf/tool-calls?limit=abc`);
    const b = body as { data: { observations: ToolCallTiming[] } };
    expect(b.data.observations).toHaveLength(2);
  });

  it('ignores missing limit and returns all observations', async () => {
    const buf = new ToolCallTimingRingBuffer(10);
    buf.push({ toolName: 'a', startedAtMs: 0, durationMs: 1, outcome: 'success' });
    buf.push({ toolName: 'b', startedAtMs: 0, durationMs: 2, outcome: 'success' });

    const app = buildPerfApp(buf);
    ({ server, baseUrl } = await startServer(app));

    const { body } = await get(`${baseUrl}/api/v2/perf/tool-calls`);
    const b = body as { data: { observations: ToolCallTiming[] } };
    expect(b.data.observations).toHaveLength(2);
  });

  it('ignores limit=0 and returns all observations', async () => {
    const buf = new ToolCallTimingRingBuffer(10);
    buf.push({ toolName: 'a', startedAtMs: 0, durationMs: 1, outcome: 'success' });

    const app = buildPerfApp(buf);
    ({ server, baseUrl } = await startServer(app));

    const { body } = await get(`${baseUrl}/api/v2/perf/tool-calls?limit=0`);
    const b = body as { data: { observations: ToolCallTiming[] } };
    expect(b.data.observations).toHaveLength(1);
  });
});
