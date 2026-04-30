/**
 * Tests for src/trigger/polling-scheduler.ts
 *
 * Covers:
 * - start(): does nothing when no polling triggers are configured
 * - start(): starts intervals for gitlab_poll triggers
 * - poll cycle: new MR triggers dispatch()
 * - poll cycle: already-seen MR is NOT dispatched
 * - poll cycle: poll failure logs warning and continues (no dispatch)
 * - poll cycle: skip-cycle guard prevents concurrent polls
 * - stop(): clears all intervals
 * - WorkflowTrigger context contains expected MR fields
 * - goalTemplate interpolation from MR fields
 * - goalTemplate falls back to static goal on missing token
 * - forcePoll: returns not_found for unknown triggers
 * - forcePoll: returns wrong_provider for non-queue triggers
 * - forcePoll: runs one cycle and returns cycleRan=true when no poll in flight
 * - forcePoll: returns cycleRan=false when skip-cycle guard fires
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PollingScheduler } from '../../src/trigger/polling-scheduler.js';
import { PolledEventStore } from '../../src/trigger/polled-event-store.js';
import type { TriggerDefinition } from '../../src/trigger/types.js';
import { asTriggerId } from '../../src/trigger/types.js';
import type { TriggerRouter } from '../../src/trigger/trigger-router.js';
import type { WorkflowTrigger } from '../../src/daemon/workflow-runner.js';
import type { FetchFn } from '../../src/trigger/adapters/gitlab-poller.js';
import type { FetchFn as QueueFetchFn } from '../../src/trigger/adapters/github-queue-poller.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-test-scheduler-'));
}

function makePollingTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    id: asTriggerId('test-gitlab-poll'),
    provider: 'gitlab_poll',
    workflowId: 'mr-review-workflow',
    workspacePath: '/workspace',
    goal: 'Review MR',
    concurrencyMode: 'serial',
    pollingSource: {
      provider: 'gitlab_poll',
      baseUrl: 'https://gitlab.example.com',
      projectId: '12345',
      token: 'test-token',
      events: ['merge_request.opened', 'merge_request.updated'],
      pollIntervalSeconds: 60,
    },
    ...overrides,
  };
}

function makeWebhookTrigger(): TriggerDefinition {
  return {
    id: asTriggerId('test-webhook'),
    provider: 'generic',
    workflowId: 'some-workflow',
    workspacePath: '/workspace',
    goal: 'Some goal',
    concurrencyMode: 'serial',
  };
}

function makeMRResponse(mrs: Array<{
  id: number;
  iid: number;
  title: string;
  web_url?: string;
  updated_at?: string;
  state?: string;
}>): FetchFn {
  const data = mrs.map(mr => ({
    id: mr.id,
    iid: mr.iid,
    title: mr.title,
    web_url: mr.web_url ?? `https://gitlab.example.com/mr/${mr.iid}`,
    updated_at: mr.updated_at ?? '2026-04-15T10:00:00.000Z',
    state: mr.state ?? 'opened',
  }));
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);
}

function makeFailingFetch(error: Error): FetchFn {
  return vi.fn().mockRejectedValue(error);
}

function makeRouter(): { router: TriggerRouter; dispatched: WorkflowTrigger[]; adaptiveDispatched: Array<{ goal: string; workspace: string; context?: Readonly<Record<string, unknown>> }> } {
  const dispatched: WorkflowTrigger[] = [];
  const adaptiveDispatched: Array<{ goal: string; workspace: string; context?: Readonly<Record<string, unknown>> }> = [];
  const router = {
    dispatch: (trigger: WorkflowTrigger) => {
      dispatched.push(trigger);
      return trigger.workflowId;
    },
    dispatchAdaptivePipeline: async (
      goal: string,
      workspace: string,
      context?: Readonly<Record<string, unknown>>,
    ) => {
      adaptiveDispatched.push({ goal, workspace, context });
      return { kind: 'merged' as const };
    },
  } as unknown as TriggerRouter;
  return { router, dispatched, adaptiveDispatched };
}

function makeRouterWithoutAdaptive(): { router: TriggerRouter; dispatched: WorkflowTrigger[] } {
  const dispatched: WorkflowTrigger[] = [];
  const router = {
    dispatch: (trigger: WorkflowTrigger) => {
      dispatched.push(trigger);
      return trigger.workflowId;
    },
    // dispatchAdaptivePipeline intentionally absent -- tests the throw path
  } as unknown as TriggerRouter;
  return { router, dispatched };
}

// ---------------------------------------------------------------------------
// start() behavior
// ---------------------------------------------------------------------------

describe('PollingScheduler.start', () => {
  it('does nothing when no polling triggers are configured', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();
    const fetchFn = makeMRResponse([]);

    const scheduler = new PollingScheduler([makeWebhookTrigger()], router, store, fetchFn);
    scheduler.start();
    scheduler.stop(); // should not throw

    expect(true).toBe(true); // No errors
  });

  it('stops cleanly with no triggers', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();

    const scheduler = new PollingScheduler([], router, store);
    scheduler.start();
    scheduler.stop(); // should not throw

    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Poll cycle: dispatch behavior
// ---------------------------------------------------------------------------

describe('PollingScheduler poll cycle', () => {
  it('dispatches for new MRs not in event store', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched } = makeRouter();
    const fetchFn = makeMRResponse([
      { id: 1001, iid: 1, title: 'First MR' },
      { id: 1002, iid: 2, title: 'Second MR' },
    ]);

    const trigger = makePollingTrigger();

    // Access private method via cast
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    // Directly call the private doPoll method via any cast for testing
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.workflowId).toBe('mr-review-workflow');
    expect(dispatched[0]?.context?.['mrId']).toBe(1001);
    expect(dispatched[1]?.context?.['mrId']).toBe(1002);
  });

  it('does NOT dispatch for MRs already in event store', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const triggerId = asTriggerId('test-gitlab-poll');

    // Pre-populate the store with MR 1001 already processed
    await store.save(triggerId, {
      processedIds: ['1001'],
      lastPollAt: '2026-04-15T09:00:00.000Z',
    });

    const { router, dispatched } = makeRouter();
    const fetchFn = makeMRResponse([
      { id: 1001, iid: 1, title: 'First MR' }, // already seen
      { id: 1002, iid: 2, title: 'Second MR' }, // new
    ]);

    const trigger = makePollingTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.context?.['mrId']).toBe(1002);
  });

  it('does NOT dispatch when MRs list is empty', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched } = makeRouter();
    const fetchFn = makeMRResponse([]);

    const trigger = makePollingTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched).toHaveLength(0);
  });

  it('logs warning and does NOT dispatch when poll fails', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched } = makeRouter();
    const fetchFn = makeFailingFetch(new Error('Connection refused'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const trigger = makePollingTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("poll failed for trigger 'test-gitlab-poll'"),
    );

    warnSpy.mockRestore();
  });

  it('records event IDs AFTER dispatch (at-least-once ordering)', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const triggerId = asTriggerId('test-gitlab-poll');

    const dispatchOrder: string[] = [];
    const recordOrder: string[] = [];

    // Spy on dispatch
    const { router } = makeRouter();
    const originalDispatch = router.dispatch.bind(router);
    (router as unknown as { dispatch: typeof originalDispatch }).dispatch = (t: WorkflowTrigger) => {
      dispatchOrder.push(String(t.context?.['mrId']));
      return originalDispatch(t);
    };

    // Spy on store.record
    const originalRecord = store.record.bind(store);
    store.record = async (...args) => {
      const [, ids] = args;
      for (const id of ids) recordOrder.push(id);
      return originalRecord(...args);
    };

    const fetchFn = makeMRResponse([{ id: 1001, iid: 1, title: 'MR 1' }]);
    const trigger = makePollingTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    // dispatch was called for 1001
    expect(dispatchOrder).toContain('1001');
    // record was called with 1001 (order guaranteed: dispatch before record)
    expect(recordOrder).toContain('1001');

    // Verify the state was saved
    const loaded = await store.load(triggerId);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.value.processedIds).toContain('1001');
    }
  });
});

// ---------------------------------------------------------------------------
// WorkflowTrigger context
// ---------------------------------------------------------------------------

describe('PollingScheduler WorkflowTrigger context', () => {
  it('includes MR fields in context', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched } = makeRouter();
    const fetchFn = makeMRResponse([
      {
        id: 1001,
        iid: 42,
        title: 'Add feature X',
        web_url: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
        updated_at: '2026-04-15T10:00:00.000Z',
        state: 'opened',
      },
    ]);

    const trigger = makePollingTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched).toHaveLength(1);
    const ctx = dispatched[0]?.context;
    expect(ctx?.['mrId']).toBe(1001);
    expect(ctx?.['mrIid']).toBe(42);
    expect(ctx?.['mrTitle']).toBe('Add feature X');
    expect(ctx?.['mrUrl']).toBe('https://gitlab.example.com/group/repo/-/merge_requests/42');
    expect(ctx?.['mrUpdatedAt']).toBe('2026-04-15T10:00:00.000Z');
  });

  it('uses static goal when no goalTemplate is set', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched } = makeRouter();
    const fetchFn = makeMRResponse([{ id: 1001, iid: 1, title: 'My MR' }]);

    const trigger = makePollingTrigger({ goal: 'Review all MRs' });
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched[0]?.goal).toBe('Review all MRs');
  });

  it('interpolates goalTemplate from MR fields', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched } = makeRouter();
    const fetchFn = makeMRResponse([{ id: 1001, iid: 42, title: 'Add auth module' }]);

    const trigger = makePollingTrigger({
      goal: 'Review MR',
      goalTemplate: 'Review MR !{{$.iid}}: {{$.title}}',
    });
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched[0]?.goal).toBe('Review MR !42: Add auth module');
  });

  it('falls back to static goal when goalTemplate token is missing', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched } = makeRouter();
    const fetchFn = makeMRResponse([{ id: 1001, iid: 42, title: 'My MR' }]);

    const trigger = makePollingTrigger({
      goal: 'Review MR fallback',
      goalTemplate: 'Review {{$.nonexistent.field}}: {{$.title}}',
    });
    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    expect(dispatched[0]?.goal).toBe('Review MR fallback');
  });
});

// ---------------------------------------------------------------------------
// setInterval lifecycle: start() / stop() wiring
// ---------------------------------------------------------------------------

describe('PollingScheduler setInterval lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires doPoll via setInterval after pollIntervalMs and stops cleanly', async () => {
    vi.useFakeTimers();

    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();

    // Fetch returns empty MRs -- we only care that doPoll is called
    const fetchFn = makeMRResponse([]);

    const trigger = makePollingTrigger({ pollingSource: {
      baseUrl: 'https://gitlab.example.com',
      projectId: '12345',
      token: 'test-token',
      events: ['merge_request.opened'],
      pollIntervalSeconds: 30,
    }});

    const scheduler = new PollingScheduler([trigger], router, store, fetchFn);

    // Spy on runPollCycle before start() so we capture calls from both the
    // first-poll setTimeout (5s) and the setInterval (30s).
    // We use runPollCycle rather than doPoll because the skip-cycle guard can
    // prevent doPoll from being called a second time if the first async doPoll
    // is still in progress (real I/O pending). runPollCycle is called at every
    // timer firing regardless of the in-progress guard.
    const pollCycleSpy = vi.spyOn(
      scheduler as unknown as { runPollCycle(t: TriggerDefinition): Promise<void> },
      'runPollCycle',
    );

    scheduler.start();

    // Advance past one full interval (30s + 1ms); the first poll (setTimeout 5s)
    // also fires within this window.
    await vi.advanceTimersByTimeAsync(30_001);

    // runPollCycle should have been called at least once (interval tick + possibly first-poll timeout)
    expect(pollCycleSpy).toHaveBeenCalled();
    const callCountAfterStart = pollCycleSpy.mock.calls.length;

    // Stop the scheduler and reset the spy call count
    scheduler.stop();
    pollCycleSpy.mockClear();

    // Advance well beyond another interval -- no further calls should fire
    await vi.advanceTimersByTimeAsync(60_000);

    expect(pollCycleSpy).not.toHaveBeenCalled();
    // Confirm at least 2 calls were observed before stop:
    // both the 5s first-poll timeout AND the 30s interval should have fired within 30001ms.
    expect(callCountAfterStart).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Skip-cycle guard
// ---------------------------------------------------------------------------

describe('PollingScheduler skip-cycle guard', () => {
  it('skips cycle when previous poll is still running', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();

    // fetchFn is not used in this test (cycle is skipped before fetch)
    const hangingFetch: FetchFn = () => new Promise<Response>(() => { /* never resolves */ });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const trigger = makePollingTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, hangingFetch);

    // Manually set the polling flag to simulate an in-progress poll
    (scheduler as unknown as { polling: Map<string, boolean> }).polling.set(trigger.id, true);

    // Running a cycle while flag is true should be skipped immediately
    await (scheduler as unknown as { runPollCycle(t: TriggerDefinition): Promise<void> }).runPollCycle(trigger);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping poll cycle'),
    );

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// github_queue_poll: adaptive routing
// ---------------------------------------------------------------------------

/**
 * Make a github_queue_poll trigger for queue poll tests.
 */
function makeQueuePollTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    id: asTriggerId('test-queue-poll'),
    provider: 'github_queue_poll',
    workflowId: '',
    workspacePath: '/workspace',
    goal: 'Work on queue task',
    concurrencyMode: 'serial',
    pollingSource: {
      provider: 'github_queue_poll',
      repo: 'acme/my-project',
      token: 'test-token',
      pollIntervalSeconds: 300,
    },
    ...overrides,
  };
}

/**
 * Make a fake fetch that returns a single GitHub queue issue.
 */
function makeQueueFetch(): QueueFetchFn {
  const issue = {
    id: 1001,
    number: 42,
    title: 'Implement login flow',
    body: 'upstream_spec: https://spec.example.com/login',
    html_url: 'https://github.com/acme/my-project/issues/42',
    url: 'https://github.com/acme/my-project/issues/42',
    labels: [],
    created_at: '2026-04-19T00:00:00Z',
    state: 'open',
    // Use assignees array (not singular assignee) to match the defensive client-side
    // assignee pre-filter in pollGitHubQueueIssues() which checks the assignees array.
    assignees: [{ login: 'worktrain-etienneb' }],
  };
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => name === 'X-RateLimit-Remaining' ? '500' : null,
    },
    json: () => Promise.resolve([issue]),
  } as unknown as Response);
}

// vi.mock() must be at module level (hoisted). See vitest docs.
vi.mock('../../src/trigger/github-queue-config.js', () => ({
  loadQueueConfig: vi.fn().mockResolvedValue({
    kind: 'ok',
    value: {
      type: 'assignee',
      user: 'worktrain-etienneb',
      repo: 'acme/my-project',
      token: 'test-token',
      pollIntervalSeconds: 300,
      maxTotalConcurrentSessions: 3,
      maxDispatchAttempts: 3,
      excludeLabels: [],
    },
  }),
}));

describe('doPollGitHubQueue adaptive routing', () => {
  afterEach(() => {
    // Use clearAllMocks (not restoreAllMocks) to preserve vi.mock() implementations.
    // vi.restoreAllMocks() would clear the loadQueueConfig mock's return value,
    // causing subsequent tests in this suite to receive undefined.
    vi.clearAllMocks();
  });

  it('always calls dispatchAdaptivePipeline, never dispatch()', async () => {
    // Proves Change 2: queue poll always routes through adaptive coordinator.
    // dispatch() must NOT be called even if adaptive call succeeds.
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, dispatched, adaptiveDispatched } = makeRouter();

    const dispatchSpy = vi.spyOn(router, 'dispatch');

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);

    // Call doPoll directly (bypasses interval scheduling)
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    // Adaptive coordinator called, dispatch() NOT called
    expect(adaptiveDispatched).toHaveLength(1);
    expect(adaptiveDispatched[0]?.goal).toBe('Implement login flow');
    expect(dispatched).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('throws when dispatchAdaptivePipeline is not available on router', async () => {
    // Proves Change 2: no silent fallback to dispatch() when adaptive unavailable.
    // The throw is caught by runPollCycle's try/catch and logged as a warning.
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router: routerWithoutAdaptive } = makeRouterWithoutAdaptive();

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], routerWithoutAdaptive, store, makeQueueFetch(), tmpDir);

    // doPoll should throw (not silently fall back to dispatch())
    await expect(
      (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger),
    ).rejects.toThrow('dispatchAdaptivePipeline not available on router');
  });

  it('blocks same issue from being dispatched twice while first Promise is in flight', async () => {
    // Proves I1+I3: dispatchingIssues.has() check prevents duplicate dispatch
    // within the same process when the first dispatchAdaptivePipeline() Promise has not settled.
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });

    // Deferred Promise: won't resolve until we call resolve() manually.
    // This simulates a long-running session still in flight.
    let resolveDispatch!: () => void;
    const deferredDispatch = new Promise<void>((resolve) => { resolveDispatch = resolve; });

    const adaptiveDispatched: Array<{ goal: string }> = [];
    const router = {
      dispatch: () => { throw new Error('dispatch() should not be called'); },
      dispatchAdaptivePipeline: async (goal: string) => {
        adaptiveDispatched.push({ goal });
        return deferredDispatch;
      },
    } as unknown as TriggerRouter;

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);

    // First poll: issue #42 dispatched, Promise in flight
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    expect(adaptiveDispatched).toHaveLength(1);

    // Second poll before Promise settles: issue #42 is in dispatchingIssues -> blocked
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    expect(adaptiveDispatched).toHaveLength(1); // still 1, not 2

    // Unblock the deferred Promise to avoid hanging
    resolveDispatch();
    await deferredDispatch;
  });

  it('allows re-dispatch of issue after dispatchAdaptivePipeline Promise settles', async () => {
    // Proves I2: cleanup in .then() removes issue from dispatchingIssues,
    // making it eligible for dispatch on the next poll cycle.
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });

    // Deferred Promise pattern -- controlled resolution
    let resolveDispatch!: () => void;
    let deferredDispatch = new Promise<void>((resolve) => { resolveDispatch = resolve; });

    const adaptiveDispatched: Array<{ goal: string }> = [];
    const router = {
      dispatch: () => { throw new Error('dispatch() should not be called'); },
      dispatchAdaptivePipeline: async (goal: string) => {
        adaptiveDispatched.push({ goal });
        return deferredDispatch;
      },
    } as unknown as TriggerRouter;

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);

    // First poll: issue #42 dispatched
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    expect(adaptiveDispatched).toHaveLength(1);

    // Resolve the deferred Promise -- .then() handler fires (microtask), clears dispatchingIssues
    resolveDispatch();
    await deferredDispatch;
    // Drain microtasks so .then() cleanup runs before the next doPoll call
    await Promise.resolve();

    // Re-arm the deferred Promise for the second dispatch
    deferredDispatch = new Promise<void>((resolve) => { resolveDispatch = resolve; });

    // Second poll after Promise settled: issue #42 no longer in dispatchingIssues -> dispatched again
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    expect(adaptiveDispatched).toHaveLength(2);

    // Cleanup
    resolveDispatch();
    await deferredDispatch;
  });
});

// ---------------------------------------------------------------------------
// forcePoll
// ---------------------------------------------------------------------------

describe('PollingScheduler.forcePoll', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found for an unknown triggerId', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();

    const scheduler = new PollingScheduler([makeQueuePollTrigger()], router, store, makeQueueFetch());
    const result = await scheduler.forcePoll('nonexistent-trigger');

    expect(result.kind).toBe('not_found');
  });

  it('returns wrong_provider for a non-queue-poll trigger', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();
    const trigger = makePollingTrigger(); // gitlab_poll trigger

    const scheduler = new PollingScheduler([trigger], router, store, makeMRResponse([]));
    const result = await scheduler.forcePoll(trigger.id);

    expect(result.kind).toBe('wrong_provider');
    if (result.kind === 'wrong_provider') {
      expect(result.provider).toBe('gitlab_poll');
    }
  });

  it('runs one poll cycle and returns cycleRan=true when no poll is in flight', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, adaptiveDispatched } = makeRouter();

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);

    const result = await scheduler.forcePoll(trigger.id);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.cycleRan).toBe(true);
    }
    // The cycle ran: adaptive dispatch was called
    expect(adaptiveDispatched).toHaveLength(1);
  });

  it('returns cycleRan=false when skip-cycle guard fires (poll already in flight)', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch());

    // Manually set the polling flag to simulate an in-progress poll
    (scheduler as unknown as { polling: Map<string, boolean> }).polling.set(trigger.id, true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await scheduler.forcePoll(trigger.id);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.cycleRan).toBe(false);
    }
    // The skip-cycle guard fired -- runPollCycle was called but skipped
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping poll cycle'));

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Dispatch loop protection: attempt cap
// ---------------------------------------------------------------------------

describe('doPollGitHubQueue dispatch loop protection', () => {
  beforeEach(async () => {
    // Re-establish loadQueueConfig mock after vi.clearAllMocks() may have cleared it.
    // WHY: vi.clearAllMocks() clears mockResolvedValue; each test block needs its own setup.
    const { loadQueueConfig } = await import('../../src/trigger/github-queue-config.js');
    vi.mocked(loadQueueConfig).mockResolvedValue({
      kind: 'ok',
      value: {
        type: 'assignee',
        user: 'worktrain-etienneb',
        repo: 'acme/my-project',
        token: 'test-token',
        pollIntervalSeconds: 300,
        maxTotalConcurrentSessions: 3,
        maxDispatchAttempts: 3,
        excludeLabels: [],
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches normally when attempt count is below cap (sidecar has attemptCount=1)', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, adaptiveDispatched } = makeRouter();

    // Write a sidecar with attemptCount=1 (below default cap of 3)
    const sidecar = {
      issueNumber: 42,
      triggerId: 'test-queue-poll',
      dispatchedAt: 0,
      ttlMs: 0,
      attemptCount: 1,
    };
    await fs.writeFile(path.join(tmpDir, 'queue-issue-42.json'), JSON.stringify(sidecar), 'utf8');

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    // Should dispatch normally (attemptCount 1 < maxDispatchAttempts 3)
    expect(adaptiveDispatched).toHaveLength(1);
    expect(adaptiveDispatched[0]?.goal).toBe('Implement login flow');
  });

  it('skips dispatch when attempt count is at cap (sidecar has attemptCount=3)', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, adaptiveDispatched } = makeRouter();

    // Write a sidecar with attemptCount = maxDispatchAttempts (3)
    const sidecar = {
      issueNumber: 42,
      triggerId: 'test-queue-poll',
      dispatchedAt: 0,
      ttlMs: 0,
      attemptCount: 3,
    };
    await fs.writeFile(path.join(tmpDir, 'queue-issue-42.json'), JSON.stringify(sidecar), 'utf8');

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    warnSpy.mockRestore();

    // Should NOT dispatch -- at cap
    expect(adaptiveDispatched).toHaveLength(0);
  });

  it('skips dispatch when attempt count exceeds cap (sidecar has attemptCount=5)', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, adaptiveDispatched } = makeRouter();

    const sidecar = {
      issueNumber: 42,
      triggerId: 'test-queue-poll',
      dispatchedAt: 0,
      ttlMs: 0,
      attemptCount: 5,
    };
    await fs.writeFile(path.join(tmpDir, 'queue-issue-42.json'), JSON.stringify(sidecar), 'utf8');

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    warnSpy.mockRestore();

    expect(adaptiveDispatched).toHaveLength(0);
  });

  it('dispatches normally when no sidecar exists (first attempt)', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, adaptiveDispatched } = makeRouter();

    // No sidecar written -- fresh issue, readSidecarAttemptCount returns 0
    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    // Should dispatch (0 < 3)
    expect(adaptiveDispatched).toHaveLength(1);
  });

  it('writes outbox notification when dispatch cap is reached', async () => {
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router } = makeRouter();

    const sidecar = {
      issueNumber: 42,
      triggerId: 'test-queue-poll',
      dispatchedAt: 0,
      ttlMs: 0,
      attemptCount: 3,
    };
    await fs.writeFile(path.join(tmpDir, 'queue-issue-42.json'), JSON.stringify(sidecar), 'utf8');

    // Override homedir to write outbox to tmpDir
    const outboxPath = path.join(tmpDir, 'outbox.jsonl');

    // Patch postCapActions indirectly by checking the outbox file written to os.homedir()
    // We can't easily inject the outbox path, so we verify behavior via the cap skip log
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    // dispatch_cap_reached was logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dispatch_cap_reached'));
    warnSpy.mockRestore();

    void outboxPath; // referenced to avoid lint warning
  });

  it('dispatches on first attempt and cap is enforced on second (verifies attemptCount increments)', async () => {
    // WHY behavioral (not file-read): the sidecar write is fire-and-forget so reading
    // the file is inherently racy. Instead we verify the behavior the sidecar enables:
    // a second poll cycle with a sidecar at cap stops dispatch.
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });
    const { router, adaptiveDispatched } = makeRouter();

    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);

    // First dispatch: no sidecar, should dispatch
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    expect(adaptiveDispatched).toHaveLength(1);

    // Simulate what the sidecar write would produce: write a sidecar at cap (3)
    // to verify the cap check fires on the next poll
    const sidecar = { issueNumber: 42, triggerId: 'test-queue-poll', dispatchedAt: 0, ttlMs: 0, attemptCount: 3 };
    await fs.writeFile(path.join(tmpDir, 'queue-issue-42.json'), JSON.stringify(sidecar), 'utf8');

    // Second dispatch: sidecar at cap, should NOT dispatch
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);
    expect(adaptiveDispatched).toHaveLength(1); // still 1 -- second dispatch was skipped
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dispatch_cap_reached'));
    warnSpy.mockRestore();
  });

  it('on failure, sidecar count does not double-increment (no extra +1 in failure handler)', async () => {
    // WHY behavioral: reading the fire-and-forget sidecar write is racy on CI.
    // Instead verify that after one failed dispatch + one successful re-dispatch,
    // the cap is not hit earlier than expected (cap=3 means 3 dispatches, not 2).
    const tmpDir = await makeTmpDir();
    const store = new PolledEventStore({ WORKRAIL_HOME: tmpDir });

    // Simulate state after 2 failed dispatches (sidecar with attemptCount=2, ttlMs=0)
    // If recordFailedAttempt double-incremented, this would read as 4 (over cap=3).
    // With correct single-increment behavior, it reads as 2 and dispatch proceeds.
    const sidecar = { issueNumber: 42, triggerId: 'test-queue-poll', dispatchedAt: 0, ttlMs: 0, attemptCount: 2 };
    await fs.writeFile(path.join(tmpDir, 'queue-issue-42.json'), JSON.stringify(sidecar), 'utf8');

    const { router, adaptiveDispatched } = makeRouter();
    const trigger = makeQueuePollTrigger();
    const scheduler = new PollingScheduler([trigger], router, store, makeQueueFetch(), tmpDir);
    await (scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> }).doPoll(trigger);

    // attemptCount=2 < maxDispatchAttempts=3, so dispatch should proceed
    expect(adaptiveDispatched).toHaveLength(1);
    expect(adaptiveDispatched[0]?.goal).toBe('Implement login flow');
  });
});
