import { expect, it } from 'vitest';
import { manageExecutionResource } from '../../../src/answer-v1/execution-resource.js';
import { startExecutionDeadline, type DeadlineClock } from '../../../src/answer-v1/execution-deadline.js';
import type { ExecutionRef } from '../../../src/answer-v1/contracts/invocation-contract.js';
import type { TurnOutcome } from '../../../src/answer-v1/contracts/host-composition.js';

function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
function clock(): DeadlineClock {
  return { read: () => ({ kind: 'reading', wallMs: 1, monotonicMs: 1 }),
    schedule: () => ({ kind: 'scheduled', cancel() {} }) };
}

it('joins concurrent close and cancellation, but never calls a settling provider closed', async () => {
  const lifetime = new AbortController(), caller = new AbortController();
  const started = startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 100 }, clock(), lifetime.signal);
  if (started.kind !== 'started') throw new Error(started.kind);
  const entered = barrier<void>(), provider = barrier<TurnOutcome>(), cleanup = barrier<void>();
  let runs = 0, closes = 0;
  let observed: AbortSignal | undefined;
  const managed = manageExecutionResource(scope => ({ execution: 'execution' as ExecutionRef,
    async runTurn(signal) { runs++; observed = signal; expect(scope.aborted).toBe(false); entered.release(); return provider.promise; },
  }), { async close() { closes++; await cleanup.promise; return { kind: 'closed' }; } }, started.deadline, lifetime.signal, p => p);
  const running = managed.runner.runTurn(caller.signal);
  await entered.promise;
  expect((await managed.runner.runTurn(new AbortController().signal)).kind).toBe('refused');
  expect(closes).toBe(0);
  caller.abort(); lifetime.abort();
  const first = managed.close(), second = managed.close();
  expect(observed?.aborted).toBe(true);
  cleanup.release();
  expect(await first).toMatchObject({ kind: 'incomplete', reason: 'work_in_flight' });
  expect(await second).toEqual(await first);
  expect(closes).toBe(1);
  provider.release({ kind: 'cancelled' });
  expect(await running).toEqual({ kind: 'cancelled' });
  expect(await managed.close()).toEqual({ kind: 'closed' });
  expect(await managed.runner.runTurn(new AbortController().signal)).toEqual({ kind: 'cancelled' });
  expect(runs).toBe(1);
});

it.each(['throwing_runner', 'throwing_cleanup'] as const)('retains uncertainty and revokes inference after %s', async scenario => {
  const lifetime = new AbortController();
  const started = startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 100 }, clock(), lifetime.signal);
  if (started.kind !== 'started') throw new Error(started.kind);
  let closes = 0;
  const managed = manageExecutionResource(() => ({ execution: 'execution' as ExecutionRef,
    async runTurn() { if (scenario === 'throwing_runner') throw new Error('I/O'); return { kind: 'cancelled' }; },
  }), { async close() { closes++; if (scenario === 'throwing_cleanup') throw new Error('lost reply'); return { kind: 'closed' }; } },
  started.deadline, lifetime.signal, p => p);
  const answer = await managed.runner.runTurn(new AbortController().signal);
  expect(answer.kind).toBe(scenario === 'throwing_runner' ? 'refused' : 'cancelled');
  const result = await managed.close();
  expect(result.kind).toBe(scenario === 'throwing_cleanup' ? 'incomplete' : 'closed');
  expect(await managed.close()).toEqual(result);
  expect(closes).toBe(1);
});
