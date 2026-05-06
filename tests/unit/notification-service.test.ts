/**
 * Tests for src/trigger/notification-service.ts
 *
 * Covers:
 * - buildNotificationBody: correct text for each WorkflowRunResult variant
 * - buildOutcome / buildDetail: correct values for each variant
 * - NotificationService construction: platform guard, URL validation
 * - notify(): macOS channel called with correct osascript args
 * - notify(): webhook channel called with correct URL and JSON body
 * - notify(): both channels fire concurrently when both configured
 * - notify(): does not throw when execFileFn throws
 * - notify(): does not throw when fetchFn rejects
 * - notify(): does not throw when fetchFn returns non-2xx
 * - notify(): macOS channel skipped when platform is not darwin
 * - notify(): webhook channel skipped when URL is invalid
 */

import { describe, expect, it, vi } from 'vitest';
import {
  NotificationService,
  buildNotificationBody,
  buildOutcome,
  buildDetail,
  type ExecFileNotifyFn,
  type FetchNotifyFn,
  type NotificationPayload,
} from '../../src/trigger/notification-service.js';
import type { WorkflowRunResult } from '../../src/daemon/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccess(workflowId = 'test-workflow'): WorkflowRunResult {
  return { _tag: 'success', workflowId, stopReason: 'stop' };
}

function makeError(workflowId = 'test-workflow'): WorkflowRunResult {
  return { _tag: 'error', workflowId, message: 'Something broke', stopReason: 'error' };
}

function makeTimeout(workflowId = 'test-workflow'): WorkflowRunResult {
  return { _tag: 'timeout', workflowId, reason: 'wall_clock', message: 'Timed out after 30 minutes' };
}

function makeDeliveryFailed(workflowId = 'test-workflow'): WorkflowRunResult {
  return { _tag: 'delivery_failed', workflowId, stopReason: 'stop', deliveryError: 'HTTP 503' };
}

function makeFakeExecFile(): {
  fn: ExecFileNotifyFn;
  calls: Array<{ file: string; args: readonly string[]; options: { timeout: number } }>;
} {
  const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number } }> = [];
  const fn: ExecFileNotifyFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    // Simulate success synchronously
    callback(null);
  };
  return { fn, calls };
}

function makeFakeExecFileError(error: Error): {
  fn: ExecFileNotifyFn;
} {
  const fn: ExecFileNotifyFn = (_file, _args, _options, callback) => {
    callback(error);
  };
  return { fn };
}

function makeFakeFetch(
  response: { ok: boolean; status: number } = { ok: true, status: 200 },
): {
  fn: FetchNotifyFn;
  calls: Array<{ url: string; body: NotificationPayload }>;
} {
  const calls: Array<{ url: string; body: NotificationPayload }> = [];
  const fn: FetchNotifyFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as NotificationPayload });
    return response;
  };
  return { fn, calls };
}

function makeFakeFetchReject(error: Error): { fn: FetchNotifyFn } {
  const fn: FetchNotifyFn = async () => {
    throw error;
  };
  return { fn };
}

/**
 * Wait for the detached Promise inside notify() to settle.
 * notify() fires-and-forgets, so we flush the microtask queue.
 */
async function flushNotify(): Promise<void> {
  // Two rounds: one for the _doNotify() Promise, one for the channel Promises.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('buildNotificationBody', () => {
  it('success: includes "completed" and truncated goal', () => {
    const body = buildNotificationBody(makeSuccess(), 'Review PR #123');
    expect(body).toContain('completed');
    expect(body).toContain('Review PR #123');
  });

  it('error: includes "failed" and goal', () => {
    const body = buildNotificationBody(makeError(), 'Fix the bug');
    expect(body).toContain('failed');
    expect(body).toContain('Fix the bug');
  });

  it('timeout: includes "timed out" and goal', () => {
    const body = buildNotificationBody(makeTimeout(), 'Long task');
    expect(body).toContain('timed out');
    expect(body).toContain('Long task');
  });

  it('delivery_failed: includes "delivery failed" and goal', () => {
    const body = buildNotificationBody(makeDeliveryFailed(), 'Short task');
    expect(body).toContain('delivery failed');
    expect(body).toContain('Short task');
  });

  it('truncates long goals at 60 chars', () => {
    const longGoal = 'A'.repeat(80);
    const body = buildNotificationBody(makeSuccess(), longGoal);
    // After truncation the body should contain the first 57 chars + '...'
    expect(body).toContain('A'.repeat(57) + '...');
    expect(body).not.toContain('A'.repeat(58));
  });
});

describe('buildOutcome', () => {
  it('maps each _tag to the correct outcome string', () => {
    expect(buildOutcome(makeSuccess())).toBe('success');
    expect(buildOutcome(makeError())).toBe('error');
    expect(buildOutcome(makeTimeout())).toBe('timeout');
    expect(buildOutcome(makeDeliveryFailed())).toBe('delivery_failed');
  });
});

describe('buildDetail', () => {
  it('success: includes stopReason', () => {
    expect(buildDetail(makeSuccess())).toContain('stop');
  });

  it('error: is the error message', () => {
    expect(buildDetail(makeError())).toBe('Something broke');
  });

  it('timeout: is the timeout message', () => {
    expect(buildDetail(makeTimeout())).toContain('30 minutes');
  });

  it('delivery_failed: includes both stopReason and deliveryError', () => {
    const detail = buildDetail(makeDeliveryFailed());
    expect(detail).toContain('stop');
    expect(detail).toContain('HTTP 503');
  });
});

// ---------------------------------------------------------------------------
// NotificationService construction
// ---------------------------------------------------------------------------

describe('NotificationService construction', () => {
  it('accepts valid config without warnings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn: execFileFn } = makeFakeExecFile();
    const { fn: fetchFn } = makeFakeFetch();
    new NotificationService({
      macOs: true,
      webhookUrl: 'https://hooks.example.com/notify',
      execFileFn,
      fetchFn,
      platformFn: () => 'darwin',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns and disables macOS channel when macOs=true but platform is not darwin', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn: execFileFn, calls } = makeFakeExecFile();
    const svc = new NotificationService({
      macOs: true,
      execFileFn,
      platformFn: () => 'linux',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('platform is not darwin'),
    );
    // Verify channel is disabled by calling notify and checking execFileFn is not called
    svc.notify(makeSuccess(), 'test goal');
    expect(calls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('warns and disables webhook channel when URL is invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn: fetchFn, calls } = makeFakeFetch();
    const svc = new NotificationService({ macOs: false, webhookUrl: 'not-a-url', fetchFn });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not a valid http(s) URL'),
    );
    // Verify channel is disabled
    svc.notify(makeSuccess(), 'test goal');
    expect(calls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('warns and disables webhook channel when URL is a non-http scheme', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn: fetchFn } = makeFakeFetch();
    new NotificationService({ macOs: false, webhookUrl: 'ftp://example.com/notify', fetchFn });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not a valid http(s) URL'),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// macOS channel
// ---------------------------------------------------------------------------

describe('NotificationService: macOS channel', () => {
  it('calls osascript with correct args on success', async () => {
    const { fn: execFileFn, calls } = makeFakeExecFile();
    const svc = new NotificationService({
      macOs: true,
      execFileFn,
      platformFn: () => 'darwin',
    });
    svc.notify(makeSuccess('my-workflow'), 'Review PR #1');
    await flushNotify();
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('osascript');
    expect(calls[0].args[0]).toBe('-e');
    expect(calls[0].args[1]).toContain('display notification');
    expect(calls[0].args[1]).toContain('my-workflow');
    expect(calls[0].options.timeout).toBe(5000);
  });

  it('calls osascript for error result', async () => {
    const { fn: execFileFn, calls } = makeFakeExecFile();
    const svc = new NotificationService({
      macOs: true,
      execFileFn,
      platformFn: () => 'darwin',
    });
    svc.notify(makeError(), 'Fix bug');
    await flushNotify();
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).toContain('failed');
  });

  it('does not throw when osascript fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn: execFileFn } = makeFakeExecFileError(new Error('osascript not found'));
    const svc = new NotificationService({
      macOs: true,
      execFileFn,
      platformFn: () => 'darwin',
    });
    // Should not throw
    expect(() => svc.notify(makeSuccess(), 'goal')).not.toThrow();
    await flushNotify();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('macOS notification failed'),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Webhook channel
// ---------------------------------------------------------------------------

describe('NotificationService: webhook channel', () => {
  it('POSTs correct payload on success', async () => {
    const { fn: fetchFn, calls } = makeFakeFetch();
    const svc = new NotificationService({
      macOs: false,
      webhookUrl: 'https://hooks.example.com/notify',
      fetchFn,
    });
    svc.notify(makeSuccess('wf-1'), 'Do the thing');
    await flushNotify();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.example.com/notify');
    const payload = calls[0].body;
    expect(payload.event).toBe('session_completed');
    expect(payload.workflowId).toBe('wf-1');
    expect(payload.outcome).toBe('success');
    expect(payload.goal).toBe('Do the thing');
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('POSTs delivery_failed with distinct outcome', async () => {
    const { fn: fetchFn, calls } = makeFakeFetch();
    const svc = new NotificationService({
      macOs: false,
      webhookUrl: 'https://hooks.example.com/notify',
      fetchFn,
    });
    svc.notify(makeDeliveryFailed(), 'goal');
    await flushNotify();
    expect(calls[0].body.outcome).toBe('delivery_failed');
    expect(calls[0].body.detail).toContain('HTTP 503');
  });

  it('does not throw when fetchFn rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn: fetchFn } = makeFakeFetchReject(new Error('network error'));
    const svc = new NotificationService({
      macOs: false,
      webhookUrl: 'https://hooks.example.com/notify',
      fetchFn,
    });
    expect(() => svc.notify(makeSuccess(), 'goal')).not.toThrow();
    await flushNotify();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Webhook notification error'),
    );
    warnSpy.mockRestore();
  });

  it('does not throw when fetchFn returns non-2xx', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn: fetchFn } = makeFakeFetch({ ok: false, status: 503 });
    const svc = new NotificationService({
      macOs: false,
      webhookUrl: 'https://hooks.example.com/notify',
      fetchFn,
    });
    expect(() => svc.notify(makeSuccess(), 'goal')).not.toThrow();
    await flushNotify();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 503'),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Both channels
// ---------------------------------------------------------------------------

describe('NotificationService: both channels', () => {
  it('fires both macOS and webhook when both configured', async () => {
    const { fn: execFileFn, calls: execCalls } = makeFakeExecFile();
    const { fn: fetchFn, calls: fetchCalls } = makeFakeFetch();
    const svc = new NotificationService({
      macOs: true,
      webhookUrl: 'https://hooks.example.com/notify',
      execFileFn,
      fetchFn,
      platformFn: () => 'darwin',
    });
    svc.notify(makeSuccess(), 'goal');
    await flushNotify();
    expect(execCalls).toHaveLength(1);
    expect(fetchCalls).toHaveLength(1);
  });

  it('fires no channels when both disabled', async () => {
    const { fn: execFileFn, calls: execCalls } = makeFakeExecFile();
    const { fn: fetchFn, calls: fetchCalls } = makeFakeFetch();
    const svc = new NotificationService({ macOs: false, execFileFn, fetchFn });
    svc.notify(makeSuccess(), 'goal');
    await flushNotify();
    expect(execCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });
});
