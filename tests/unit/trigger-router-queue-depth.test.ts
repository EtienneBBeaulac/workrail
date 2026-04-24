/**
 * Tests for TriggerRouter queue depth guard (maxQueueDepth).
 *
 * Covers:
 * - queue_full returned when serial queue is at maxQueueDepth
 * - enqueued returned when queue is below maxQueueDepth
 * - default maxQueueDepth of 10 applied when absent
 * - session_dropped event emitted on queue_full
 * - parallel triggers not subject to depth check
 * - Retry-After based on agentConfig.maxSessionMinutes
 * - Retry-After defaults to 30*60 when agentConfig absent
 */

import { describe, expect, it } from 'vitest';
import { TriggerRouter } from '../../src/trigger/trigger-router.js';
import type { RunWorkflowFn } from '../../src/trigger/trigger-router.js';
import type { TriggerDefinition, WebhookEvent } from '../../src/trigger/types.js';
import { asTriggerId } from '../../src/trigger/types.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
import type { DaemonEvent, DaemonEventEmitter } from '../../src/daemon/daemon-events.js';

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

const FAKE_CTX = {} as V2ToolContext;
const FAKE_API_KEY = 'test-api-key';

function makeTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    id: asTriggerId('test-trigger'),
    provider: 'generic',
    workflowId: 'wr.coding-task',
    workspacePath: '/workspace',
    goal: 'Review this MR',
    concurrencyMode: 'serial',
    ...overrides,
  };
}

function makeIndex(trigger: TriggerDefinition): ReadonlyMap<string, TriggerDefinition> {
  return new Map([[trigger.id, trigger]]);
}

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  const payload = { pull_request: { html_url: 'https://example.com/mr/1', title: 'My MR' } };
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    triggerId: asTriggerId('test-trigger'),
    rawBody,
    payload,
    ...overrides,
  };
}

/**
 * Make a blocking RunWorkflowFn that does not resolve until the returned releasePromise resolves.
 * The returned `release()` function resolves the workflow immediately.
 *
 * WHY async setup: `blockingFn` is called inside queue.enqueue()'s async chain (a microtask),
 * not synchronously when route() returns. After calling route(), callers must await at least
 * one microtask (e.g. await Promise.resolve()) before calling release() to avoid calling it
 * before blockingFn() has been invoked.
 */
function makeBlockingWorkflow(workflowId: string): {
  blockingFn: RunWorkflowFn;
  waitForStart: () => Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  let onStart!: () => void;

  const startedPromise = new Promise<void>((res) => { onStart = res; });

  const blockingFn: RunWorkflowFn = () => {
    onStart();
    return new Promise((res) => {
      release = () => res({ _tag: 'success', workflowId, stopReason: 'stop' });
    });
  };

  return {
    blockingFn,
    waitForStart: () => startedPromise,
    release: () => release(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TriggerRouter queue depth guard', () => {
  it('returns queue_full when serial queue is at maxQueueDepth', async () => {
    const trigger = makeTrigger({ concurrencyMode: 'serial', maxQueueDepth: 1 });
    const { blockingFn, waitForStart, release } = makeBlockingWorkflow(trigger.workflowId);
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, blockingFn);

    // First route -- should be enqueued (depth becomes 1 synchronously)
    const first = router.route(makeEvent());
    expect(first._tag).toBe('enqueued');

    // Second route -- queue is at maxQueueDepth (1), should be rejected
    const second = router.route(makeEvent());
    expect(second._tag).toBe('error');
    if (second._tag !== 'error') return;
    expect(second.error.kind).toBe('queue_full');
    if (second.error.kind !== 'queue_full') return;
    expect(second.error.queueDepth).toBe(1);
    expect(second.error.maxQueueDepth).toBe(1);
    expect(typeof second.error.retryAfterSeconds).toBe('number');
    expect(second.error.retryAfterSeconds).toBeGreaterThan(0);

    // Wait for blockingFn to be called, then release so the queue drains
    await waitForStart();
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('accepts route when queue is below maxQueueDepth', async () => {
    const trigger = makeTrigger({ concurrencyMode: 'serial', maxQueueDepth: 2 });
    const { blockingFn, waitForStart, release } = makeBlockingWorkflow(trigger.workflowId);
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, blockingFn);

    // First route (depth becomes 1, maxQueueDepth is 2 -- should pass)
    const first = router.route(makeEvent());
    expect(first._tag).toBe('enqueued');

    // Second route (depth is 1, maxQueueDepth is 2 -- should also pass, not rejected)
    const second = router.route(makeEvent());
    expect(second._tag).toBe('enqueued');

    await waitForStart();
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('applies default maxQueueDepth of 10 when absent', async () => {
    // Trigger with goalTemplate so each unique payload produces a unique goal,
    // bypassing the 30s deduplication window (which dedupes on goal+workspace).
    const trigger = makeTrigger({
      concurrencyMode: 'serial',
      goalTemplate: '{{$.goal}}',
    }); // no maxQueueDepth -- default 10 applies
    const { blockingFn, waitForStart, release } = makeBlockingWorkflow(trigger.workflowId);
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, blockingFn);

    // Make a helper to create events with unique goals (avoids 30s dedup window)
    function makeUniqueEvent(n: number): WebhookEvent {
      const payload = { goal: `unique-goal-${n}` };
      return {
        triggerId: asTriggerId('test-trigger'),
        rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
        payload,
      };
    }

    // First route (depth becomes 1)
    router.route(makeUniqueEvent(1));

    // Routes 2-10 should all be enqueued (depth 2-10 before each check, limit is 10)
    for (let i = 2; i <= 10; i++) {
      const result = router.route(makeUniqueEvent(i));
      expect(result._tag).toBe('enqueued');
    }

    // 11th route should fail (depth is 10, maxQueueDepth default is 10)
    const eleventh = router.route(makeUniqueEvent(11));
    expect(eleventh._tag).toBe('error');
    if (eleventh._tag !== 'error') return;
    expect(eleventh.error.kind).toBe('queue_full');
    if (eleventh.error.kind !== 'queue_full') return;
    expect(eleventh.error.maxQueueDepth).toBe(10);

    await waitForStart();
    release();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('emits session_dropped event on queue_full', async () => {
    const trigger = makeTrigger({ concurrencyMode: 'serial', maxQueueDepth: 1 });
    const { blockingFn, waitForStart, release } = makeBlockingWorkflow(trigger.workflowId);

    const emittedEvents: DaemonEvent[] = [];
    const fakeEmitter = {
      emit: (event: DaemonEvent) => { emittedEvents.push(event); },
    } as DaemonEventEmitter;

    const router = new TriggerRouter(
      makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, blockingFn,
      undefined, undefined, fakeEmitter,
    );

    // First route -- fills the queue to maxQueueDepth
    router.route(makeEvent());

    // Second route -- triggers queue_full, should emit session_dropped synchronously
    router.route(makeEvent());

    const droppedEvent = emittedEvents.find((e) => e.kind === 'session_dropped');
    expect(droppedEvent).toBeDefined();
    if (!droppedEvent || droppedEvent.kind !== 'session_dropped') return;
    expect(droppedEvent.triggerId).toBe(trigger.id);
    expect(droppedEvent.workflowId).toBe(trigger.workflowId);
    expect(droppedEvent.reason).toBe('queue_full');
    expect(droppedEvent.queueDepth).toBe(1);
    expect(droppedEvent.maxQueueDepth).toBe(1);

    await waitForStart();
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('does NOT apply queue depth check for parallel triggers', async () => {
    // Parallel triggers use unique UUID queue keys per invocation, so depth() returns 0
    const trigger = makeTrigger({ concurrencyMode: 'parallel', maxQueueDepth: 1 });
    const { fn } = {
      fn: async (t: { workflowId: string }) => ({
        _tag: 'success' as const,
        workflowId: t.workflowId,
        stopReason: 'stop' as const,
      }),
    };
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const first = router.route(makeEvent());
    const second = router.route(makeEvent());

    expect(first._tag).toBe('enqueued');
    expect(second._tag).toBe('enqueued');

    await new Promise((r) => setTimeout(r, 20));
  });

  it('computes Retry-After from agentConfig.maxSessionMinutes', async () => {
    const trigger = makeTrigger({
      concurrencyMode: 'serial',
      maxQueueDepth: 1,
      agentConfig: { maxSessionMinutes: 60 },
    });
    const { blockingFn, waitForStart, release } = makeBlockingWorkflow(trigger.workflowId);
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, blockingFn);

    router.route(makeEvent());
    const second = router.route(makeEvent());

    expect(second._tag).toBe('error');
    if (second._tag !== 'error') return;
    expect(second.error.kind).toBe('queue_full');
    if (second.error.kind !== 'queue_full') return;
    // 60 minutes * 60 seconds = 3600
    expect(second.error.retryAfterSeconds).toBe(3600);

    await waitForStart();
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('defaults Retry-After to 30 * 60 when agentConfig absent', async () => {
    const trigger = makeTrigger({ concurrencyMode: 'serial', maxQueueDepth: 1 });
    const { blockingFn, waitForStart, release } = makeBlockingWorkflow(trigger.workflowId);
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, blockingFn);

    router.route(makeEvent());
    const second = router.route(makeEvent());

    expect(second._tag).toBe('error');
    if (second._tag !== 'error') return;
    expect(second.error.kind).toBe('queue_full');
    if (second.error.kind !== 'queue_full') return;
    expect(second.error.retryAfterSeconds).toBe(1800); // 30 * 60

    await waitForStart();
    release();
    await new Promise((r) => setTimeout(r, 10));
  });
});
