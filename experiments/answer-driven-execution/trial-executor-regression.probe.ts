import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import type * as contract from './trial-executor-contract.js';
import type { ValidatedStudyManifest } from './study-manifest.mjs';

const target = resolve('experiments/answer-driven-execution/trial-executor.mts');
async function loadCandidate(): Promise<typeof contract.executeTrialPlan> {
  if (!existsSync(target)) throw new Error('CANDIDATE_UNAVAILABLE: trial executor absent');
  const mod = (await import(/* @vite-ignore */ target)) as { executeTrialPlan?: typeof contract.executeTrialPlan };
  if (typeof mod.executeTrialPlan !== 'function') throw new Error('CANDIDATE_UNAVAILABLE: trial executor export absent');
  return mod.executeTrialPlan;
}

async function withFixture(
  run: (c: { exec: typeof contract.executeTrialPlan; manifest: ValidatedStudyManifest; outDir: string }) => Promise<void>,
  stage: 'A' | 'B' = 'A',
) {
  const exec = await loadCandidate();
  const root = await mkdtemp(join(tmpdir(), 'trial-executor-regression-'));
  try {
    const { manifest } = await createUnverifiedStudyFixture(root, stage);
    const outDir = join(root, 'output');
    await mkdir(outDir, { recursive: true });
    await run({ exec, manifest, outDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readLedger(outDir: string): Promise<contract.LedgerRecord[]> {
  const text = await readFile(join(outDir, 'attempts.ndjson'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as contract.LedgerRecord);
}

describe('trial-executor supplemental regression probe', () => {
  it('halts with unknown_remote when model_started arrives while activeModelCall is present', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      let aborted = false;
      const transport: contract.AgentTransport = {
        async *startFresh(_req, signal) {
          signal.addEventListener('abort', () => { aborted = true; });
          yield { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } };
          yield { type: 'model_started', callId: 'call-1' };
          yield { type: 'model_started', callId: 'call-2' };
          yield { type: 'ended', outcome: 'completed', raw: 'done' };
        },
      };
      const res = await exec(manifest, outDir, transport, new AbortController().signal);
      expect(res).toMatchObject({ status: 'halted', reason: 'unknown_remote', attempted: 1 });
      expect(aborted).toBe(true);
      const ledger = await readLedger(outDir);
      const events = ledger.filter((r) => r.type === 'event');
      expect(events).toContainEqual(expect.objectContaining({ event: { type: 'model_started', callId: 'call-2' } }));
      const outcome = ledger.find((r) => r.type === 'outcome');
      expect(outcome).toMatchObject({ outcome: 'unknown_remote' });
    });
  });

  it('halts with unknown_remote when ended arrives without started', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const transport: contract.AgentTransport = {
        async *startFresh() {
          yield { type: 'ended', outcome: 'completed', raw: 'done' };
        },
      };
      const res = await exec(manifest, outDir, transport, new AbortController().signal);
      expect(res).toMatchObject({ status: 'halted', reason: 'unknown_remote', attempted: 1 });
      const ledger = await readLedger(outDir);
      expect(ledger).toContainEqual(
        expect.objectContaining({
          type: 'event',
          event: { type: 'ended', outcome: 'completed', raw: 'done' },
        }),
      );
      expect(ledger.find((r) => r.type === 'outcome')).toMatchObject({ outcome: 'unknown_remote' });
    });
  });

  it('halts with unknown_remote when model_started arrives without started', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const transport: contract.AgentTransport = {
        async *startFresh() {
          yield { type: 'model_started', callId: 'call-1' };
        },
      };
      const res = await exec(manifest, outDir, transport, new AbortController().signal);
      expect(res).toMatchObject({ status: 'halted', reason: 'unknown_remote', attempted: 1 });
      const ledger = await readLedger(outDir);
      expect(ledger).toContainEqual(
        expect.objectContaining({
          type: 'event',
          event: { type: 'model_started', callId: 'call-1' },
        }),
      );
      expect(ledger.find((r) => r.type === 'outcome')).toMatchObject({ outcome: 'unknown_remote' });
    });
  });

  it('rejects second started identity switching and halts with unknown_remote', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const transport: contract.AgentTransport = {
        async *startFresh() {
          yield { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } };
          yield { type: 'started', conversationId: 'c2', observedEnvironment: { kind: 'unknown' } };
        },
      };
      const res = await exec(manifest, outDir, transport, new AbortController().signal);
      expect(res).toMatchObject({ status: 'halted', reason: 'unknown_remote', attempted: 1 });
      const ledger = await readLedger(outDir);
      expect(ledger.filter((r) => r.type === 'event' && r.event.type === 'started')).toHaveLength(2);
      expect(ledger.find((r) => r.type === 'outcome')).toMatchObject({ outcome: 'unknown_remote' });
    });
  });

  it('second started with same ID halts with conversation_reused', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const transport: contract.AgentTransport = {
        async *startFresh() {
          yield { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } };
          yield { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } };
        },
      };
      const res = await exec(manifest, outDir, transport, new AbortController().signal);
      expect(res).toMatchObject({ status: 'halted', reason: 'conversation_reused', attempted: 1 });
      const ledger = await readLedger(outDir);
      expect(ledger.find((r) => r.type === 'outcome')).toMatchObject({ outcome: 'conversation_reused' });
    });
  });

  it('enforces maxCallsPerConversation budget across restart', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const transport: contract.AgentTransport = {
        async *startFresh(request) {
          yield { type: 'started', conversationId: `c1-${request.runId}`, observedEnvironment: { kind: 'unknown' } };
          for (let i = 1; i <= 15; i++) {
            yield { type: 'model_started', callId: `call-${i}` };
            yield { type: 'model_finished', callId: `call-${i}` };
          }
          yield {
            type: 'conversation_restarted',
            priorConversationId: `c1-${request.runId}`,
            conversationId: `c2-${request.runId}`,
            observedEnvironment: { kind: 'unknown' },
          };
          for (let i = 16; i <= 20; i++) {
            yield { type: 'model_started', callId: `call-${i}` };
            yield { type: 'model_finished', callId: `call-${i}` };
          }
          yield { type: 'model_started', callId: 'call-21' };
          yield { type: 'ended', outcome: 'completed', raw: 'done' };
        },
      };
      const res = await exec(manifest, outDir, transport, new AbortController().signal);
      expect(res).toMatchObject({ status: 'halted', reason: 'unknown_remote', attempted: 1 });
      const ledger = await readLedger(outDir);
      expect(ledger).toContainEqual(
        expect.objectContaining({
          type: 'event',
          event: { type: 'model_started', callId: 'call-21' },
        }),
      );
      expect(ledger.find((r) => r.type === 'outcome')).toMatchObject({ outcome: 'unknown_remote' });
    }, 'B');
  });

  it('prevents concurrent admission to same journal and halts second with storage_failed', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const slowTransport: contract.AgentTransport = {
        async *startFresh() {
          await new Promise((r) => setTimeout(r, 20));
          yield { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } };
          yield { type: 'ended', outcome: 'completed', raw: 'done' };
        },
      };
      const [res1, res2] = await Promise.all([
        exec(manifest, outDir, slowTransport, new AbortController().signal),
        exec(manifest, outDir, slowTransport, new AbortController().signal),
      ]);
      const results = [res1, res2];
      const storageFailed = results.filter((r) => r.status === 'halted' && r.reason === 'storage_failed');
      const nonStorageFailed = results.filter((r) => r.status !== 'halted' || r.reason !== 'storage_failed');
      expect(storageFailed).toHaveLength(1);
      expect(storageFailed[0].attempted).toBe(0);
      expect(nonStorageFailed).toHaveLength(1);
    });
  });

  it('rechecks cancellation before transport invocation when parent aborts after launch write', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const controller = new AbortController();
      let transportCalled = false;
      const transport: contract.AgentTransport = {
        startFresh() {
          transportCalled = true;
          throw new Error('should not be called');
        },
      };

      let callCount = 0;
      const clock: contract.RunnerClock = {
        nowMs() {
          callCount++;
          if (callCount >= 1) {
            controller.abort();
          }
          return 1000;
        },
        scheduleAt() {
          return () => {};
        },
      };

      const res = await exec(manifest, outDir, transport, controller.signal, clock);
      expect(transportCalled).toBe(false);
      expect(res).toMatchObject({ status: 'halted', reason: 'unknown_remote', attempted: 1 });
      const ledger = await readLedger(outDir);
      expect(ledger[0]).toMatchObject({ type: 'launch' });
      expect(ledger[1]).toMatchObject({ type: 'stop', reason: 'caller_cancelled' });
      expect(ledger[2]).toMatchObject({ type: 'outcome', outcome: 'unknown_remote' });
    });
  });

  it('rechecks cancellation before each iterator.next call', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const controller = new AbortController();
      let nextCallCount = 0;
      const transport: contract.AgentTransport = {
        startFresh() {
          return {
            [Symbol.asyncIterator](): AsyncIterator<contract.AgentEvent> {
              return {
                async next() {
                  nextCallCount++;
                  if (nextCallCount === 1) {
                    return {
                      value: { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } } as contract.AgentEvent,
                      done: false,
                    };
                  }
                  return {
                    value: { type: 'trace', raw: 'event-2' } as contract.AgentEvent,
                    done: false,
                  };
                },
                return() {
                  return Promise.resolve({ value: undefined, done: true });
                },
              };
            },
          };
        },
      };

      let clockCalls = 0;
      const clock: contract.RunnerClock = {
        nowMs() {
          clockCalls++;
          if (clockCalls >= 2) {
            controller.abort();
          }
          return 1000;
        },
        scheduleAt() {
          return () => {};
        },
      };

      const res = await exec(manifest, outDir, transport, controller.signal, clock);
      expect(res).toMatchObject({ status: 'halted', reason: 'unknown_remote', attempted: 1 });
      expect(nextCallCount).toBeLessThanOrEqual(2);
    });
  });

  it('cancellation inside iterator.next cannot become completed outcome', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const controller = new AbortController();
      let count = 0;
      const transport: contract.AgentTransport = {
        startFresh() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  count++;
                  if (count === 1) {
                    return Promise.resolve({
                      done: false as const,
                      value: { type: 'started' as const, conversationId: 'identity', observedEnvironment: { kind: 'unknown' as const } },
                    });
                  }
                  controller.abort();
                  return Promise.resolve({
                    done: false as const,
                    value: { type: 'ended' as const, outcome: 'completed' as const, raw: 'late' },
                  });
                },
              };
            },
          };
        },
      };
      const res = await exec(manifest, outDir, transport, controller.signal);
      const ledger = await readLedger(outDir);
      expect(ledger.some((r) => r.type === 'outcome' && r.outcome === 'completed')).toBe(false);
      expect(res.status).toBe('halted');
    });
  });

  it('genuine noncancelled control completes normally with completed outcome', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const controller = new AbortController();
      const transport: contract.AgentTransport = {
        startFresh(request) {
          let count = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  count++;
                  if (count === 1) {
                    return Promise.resolve({
                      done: false as const,
                      value: { type: 'started' as const, conversationId: `identity-${request.runId}`, observedEnvironment: { kind: 'unknown' as const } },
                    });
                  }
                  if (count === 2) {
                    return Promise.resolve({
                      done: false as const,
                      value: { type: 'ended' as const, outcome: 'completed' as const, raw: 'on-time' },
                    });
                  }
                  return Promise.resolve({ done: true as const, value: undefined });
                },
              };
            },
          };
        },
      };
      const res = await exec(manifest, outDir, transport, controller.signal);
      const ledger = await readLedger(outDir);
      expect(ledger.some((r) => r.type === 'outcome' && r.outcome === 'completed')).toBe(true);
      expect(res.status).toBe('finished');
    });
  });
});
