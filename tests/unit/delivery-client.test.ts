/**
 * Tests for src/trigger/delivery-client.ts
 *
 * Covers:
 * - 2xx response -> ok(void)
 * - Non-2xx response (e.g. 500) -> err({ kind: 'http_error', status: 500, body: '...' })
 * - fetch throws (network error or AbortError from timeout) -> err({ kind: 'network_error', message: '...' })
 *
 * Uses vi.stubGlobal('fetch', ...) to mock the global fetch without module mocking.
 * vi.unstubAllGlobals() in afterEach restores the original global after each test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { post } from '../../src/trigger/delivery-client.js';
import type { WorkflowRunResult } from '../../src/daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal WorkflowRunSuccess for use in tests. */
const SUCCESS_RESULT: WorkflowRunResult = {
  _tag: 'success',
  workflowId: 'test-workflow',
  stopReason: 'stop',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// post()
// ---------------------------------------------------------------------------

describe('delivery-client post()', () => {
  it('returns ok(void) for a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    }));

    const result = await post('https://example.com/callback', SUCCESS_RESULT);

    expect(result.kind).toBe('ok');
  });

  it('returns err(http_error) for a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));

    const result = await post('https://example.com/callback', SUCCESS_RESULT);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('http_error');
    if (result.error.kind !== 'http_error') return;
    expect(result.error.status).toBe(500);
    expect(result.error.body).toBe('Internal Server Error');
  });

  it('returns err(network_error) when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const result = await post('https://example.com/callback', SUCCESS_RESULT);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('network_error');
    if (result.error.kind !== 'network_error') return;
    expect(result.error.message).toContain('connection refused');
  });
});
