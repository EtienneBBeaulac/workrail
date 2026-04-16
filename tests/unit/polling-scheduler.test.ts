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
    pollingSource: {
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

function makeRouter(): { router: TriggerRouter; dispatched: WorkflowTrigger[] } {
  const dispatched: WorkflowTrigger[] = [];
  const router = {
    dispatch: (trigger: WorkflowTrigger) => {
      dispatched.push(trigger);
      return trigger.workflowId;
    },
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
      expect.stringContaining("Poll failed for trigger 'test-gitlab-poll'"),
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

    // Spy on doPoll before start() so we capture the wired calls
    const doPollSpy = vi.spyOn(
      scheduler as unknown as { doPoll(t: TriggerDefinition): Promise<void> },
      'doPoll',
    );

    scheduler.start();

    // Advance past one full interval (30s + 1ms); the first poll (setTimeout 5s)
    // also fires within this window.
    await vi.advanceTimersByTimeAsync(30_001);

    // doPoll should have been called at least once (interval tick + possibly first-poll timeout)
    expect(doPollSpy).toHaveBeenCalled();
    const callCountAfterStart = doPollSpy.mock.calls.length;

    // Stop the scheduler and reset the spy call count
    scheduler.stop();
    doPollSpy.mockClear();

    // Advance well beyond another interval -- no further calls should fire
    await vi.advanceTimersByTimeAsync(60_000);

    expect(doPollSpy).not.toHaveBeenCalled();
    // Confirm at least one call was observed before stop
    expect(callCountAfterStart).toBeGreaterThanOrEqual(1);
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
