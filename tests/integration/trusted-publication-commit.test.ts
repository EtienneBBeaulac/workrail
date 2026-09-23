import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers';
import { okAsync, ok, err, ResultAsync, type Result } from 'neverthrow';
import { PendingDraftReviewPoller } from '../../src/trigger/pending-draft-review-poller.js';
import type { ReviewApprovalAdapter } from '../../src/trigger/review-approval-adapter.js';
import type { SessionEventLogAppendStorePortV2, SessionEventLogReadonlyStorePortV2, LoadedSessionTruthV2, SessionEventLogStoreError } from '../../src/v2/ports/session-event-log-store.port.js';
import type { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import type { WithHealthySessionLock } from '../../src/v2/durable-core/ids/with-healthy-session-lock.js';
import { asWorkflowHash, asSha256Digest } from '../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(),
  unlink: vi.fn(async () => undefined),
}));

// Port-boundary acceptance only. The fakes do not prove real journal validation,
// engine-run identity, OS restart, or cross-process locking.
describe('publication acceptance waits for journal commitment', () => {
  it.each(['committed', 'write-failed', 'overlapping-observations'] as const)('handles %s before consuming recovery', async outcome => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.mocked(fs.unlink).mockClear();
    const trace: string[] = [];
    const committed: DomainEventV1[] = [];
    const releaseChecks: Array<() => void> = [];
    const truth: LoadedSessionTruthV2 = { manifest: [], events: [{
      v: 1, eventId: 'run-start', eventIndex: 0, sessionId: 'engine-session',
      kind: 'run_started', dedupeKey: 'run-start', scope: { runId: 'engine-run' },
      data: { workflowId: 'fixture', workflowHash: asWorkflowHash(asSha256Digest('sha256:' + 'a'.repeat(64))), workflowSourceKind: 'bundled', workflowSourceRef: 'fixture' },
      timestampMs: 1,
    }] };
    let settleAppend!: (result: Result<void, SessionEventLogStoreError>) => void;
    const appendResult = new Promise<Result<void, SessionEventLogStoreError>>(resolve => { settleAppend = resolve; });
    const store: SessionEventLogAppendStorePortV2 & SessionEventLogReadonlyStorePortV2 = {
      load: () => okAsync(truth),
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth }),
      append: (_lock, plan) => {
        trace.push('append-attempt');
        return new ResultAsync(appendResult).map(() => {
          for (const event of plan.events) {
            if (!committed.some(existing => existing.dedupeKey === event.dedupeKey)) committed.push(event);
          }
          trace.push('committed');
        });
      },
    };
    // Fake the lock boundary only: this probe measures poller effects after its
    // injected append result, not the lock implementation or witness validity.
    const gate = { withHealthySessionLock: (_id: unknown, fn: (lock: WithHealthySessionLock) => unknown) => fn({} as WithHealthySessionLock) } as unknown as ExecutionSessionGateV2;
    const adapter: ReviewApprovalAdapter = {
      createDraftReview: async () => ({ kind: 'err', error: { kind: 'api_error', message: 'Creation unused' } }),
      checkSubmission: async () => {
        if (outcome === 'overlapping-observations') await new Promise<void>(resolve => { releaseChecks.push(resolve); });
        trace.push('observed');
        return { kind: 'submitted', submittedAt: '2026-09-21T18:00:00.000Z' };
      },
    };
    const submitted = vi.fn(() => { trace.push('submitted-callback'); });
    const resumed = vi.fn(() => { trace.push('resume-callback'); });
    const poller = new PendingDraftReviewPoller(adapter, {
      prRepo: 'fixture/repo', prNumber: 42, reviewId: 9001, token: 'fixture-token', login: 'reviewer',
      workrailSessionId: 'engine-session', daemonSessionId: 'daemon-run',
      pollIntervalMs: 1000, sessionStore: store, gate, mintEventId: () => 'publication-event',
      sessionsDir: '/fake/sidecars', onSubmitted: submitted, onGateResume: resumed,
    });
    try {
      poller.start();
      await vi.advanceTimersByTimeAsync(outcome === 'overlapping-observations' ? 2000 : 1000);
      if (outcome === 'overlapping-observations') {
        expect(releaseChecks.length).toBeGreaterThanOrEqual(1);
        expect(releaseChecks.length).toBeLessThanOrEqual(2);
        releaseChecks[0]!();
      }
      // All injected operations except the controlled append settle immediately. A real event-loop turn
      // drains their promise chain; no disk/network work or arbitrary sleep.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(trace).toEqual(['observed', 'append-attempt']);
      expect(fs.unlink).not.toHaveBeenCalled();
      expect(submitted).not.toHaveBeenCalled();
      expect(resumed).not.toHaveBeenCalled();
      settleAppend(outcome !== 'write-failed' ? ok(undefined) : err({ code: 'SESSION_STORE_IO_ERROR', message: 'Injected write failure' }));
      await new Promise<void>(resolve => setImmediate(resolve));
      if (outcome !== 'write-failed') {
        expect(committed).toHaveLength(1);
        expect(committed[0]!.kind).toBe('review_draft_submitted');
        expect(committed[0]!.sessionId).toBe('engine-session');
        expect(committed[0]!.dedupeKey).toBe('review_draft_submitted:9001');
        expect(committed[0]!.data).toEqual({ reviewId: 9001, prUrl: 'https://github.com/fixture/repo/pull/42', submittedAt: '2026-09-21T18:00:00.000Z' });
        expect(trace).toEqual(['observed', 'append-attempt', 'committed', 'submitted-callback', 'resume-callback']);
        expect(fs.unlink).toHaveBeenCalledExactlyOnceWith('/fake/sidecars/pending-draft-daemon-run.json');
        expect(submitted).toHaveBeenCalledExactlyOnceWith('2026-09-21T18:00:00.000Z');
        expect(resumed).toHaveBeenCalledExactlyOnceWith('daemon-run');
        if (outcome === 'overlapping-observations') {
          releaseChecks[1]?.();
          await new Promise<void>(resolve => setImmediate(resolve));
          expect.soft(fs.unlink).toHaveBeenCalledTimes(1);
          expect.soft(submitted).toHaveBeenCalledTimes(1);
          expect.soft(resumed).toHaveBeenCalledTimes(1);
        }
        await vi.advanceTimersByTimeAsync(3000);
        expect(committed).toHaveLength(1);
      } else {
        expect(committed).toEqual([]);
        expect.soft(fs.unlink).not.toHaveBeenCalled();
        expect.soft(submitted).not.toHaveBeenCalled();
        expect.soft(resumed).not.toHaveBeenCalled();
      }
    } finally {
      poller.stop();
      vi.useRealTimers();
      vi.mocked(fs.unlink).mockClear();
    }
  });
});
