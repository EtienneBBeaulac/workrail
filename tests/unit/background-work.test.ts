import { it, expect } from 'vitest';
import { BackgroundWork } from '../../src/mcp/background-work.js';
const gate = () => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};
it('seals admission and waits for accepted work including queued same-session writes', async () => {
  const first = gate(), started = gate();
  const writes: string[] = [];
  const work = new BackgroundWork(() => {});
  work.submit('session', async () => { started.release(); await first.promise; writes.push('first'); });
  work.submit('session', async () => { writes.push('second'); });
  await started.promise;
  let closed = false;
  const closing = work.close(new AbortController().signal).then(result => { closed = true; return result; });
  expect(work.submit('session', async () => { writes.push('late'); })).toBe('closed');
  expect(closed).toBe(false);
  expect(writes).toEqual([]);
  first.release();
  expect(await closing).toBe('closed');
  expect(writes).toEqual(['first', 'second']);
});
it('reports incomplete cancellation without pretending pending work is drained', async () => {
  const barrier = gate(), started = gate();
  const work = new BackgroundWork(() => {});
  work.submit('session', async () => { started.release(); await barrier.promise; });
  await started.promise;
  const stop = new AbortController();
  const closing = work.close(stop.signal); stop.abort();
  expect(await closing).toBe('incomplete');
  barrier.release();
  expect(await work.close(new AbortController().signal)).toBe('closed');
});
it('reports a failed operation and continues ordered work without blocking another session', async () => {
  const barrier = gate();
  const outcomes: string[] = [], failures: unknown[] = [];
  const work = new BackgroundWork(error => failures.push(error));
  work.submit('one', async () => { await barrier.promise; throw 'failure'; });
  work.submit('one', async () => { outcomes.push('after failure'); });
  const other = gate();
  work.submit('two', async () => { outcomes.push('independent'); other.release(); });
  await other.promise;
  expect(outcomes).toEqual(['independent']); barrier.release();
  expect(await work.close(new AbortController().signal)).toBe('failed');
  expect(failures).toEqual(['failure']);
  expect(outcomes).toEqual(['independent', 'after failure']);
});

it('retains failure after a task leaves the pending queue and reporting throws', async () => {
  const work = new BackgroundWork(() => { throw Error('reporter unavailable'); });
  work.submit('session', async () => { throw Error('write failed'); });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(await work.close(new AbortController().signal)).toBe('failed');
  expect(await work.close(new AbortController().signal)).toBe('failed');
});
