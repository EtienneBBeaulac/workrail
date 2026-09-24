import { it, expect } from 'vitest';
import { createTransportClose, drainBeforeTerminate } from '../../src/mcp/transports/transport-lifetime.js';
it.each(['listener','protocol','background'] as const)('drains accepted work on %s failure and permits a fresh close attempt', async failure => {
  const order: string[] = [];
  let fail = true;
  const close = createTransportClose({
    async closeRequests() { order.push('requests'); },
    async stopListener() { order.push('listener'); if (fail && failure === 'listener') throw Error('socket'); },
    async closeProtocol() { order.push('protocol'); if (fail && failure === 'protocol') throw Error('protocol'); },
    async drainBackground() { order.push('background'); return fail && failure === 'background' ? 'failed' : 'closed'; },
  });
  expect(await close(new AbortController().signal)).toBe('failed');
  expect(order).toEqual(['requests','listener','protocol','background']);
  fail = false;
  expect(await close(new AbortController().signal)).toBe('closed');
});
it('keeps the protocol open until admitted handlers drain, even after caller cancellation', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const close = createTransportClose({
    async closeRequests() { order.push('requests'); await held; },
    async stopListener() { order.push('listener'); },
    async closeProtocol() { order.push('protocol'); },
    async drainBackground() { order.push('background'); return 'closed'; },
  });
  const controller = new AbortController();
  const first = close(controller.signal);
  controller.abort();
  expect(await first).toBe('incomplete');
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(order).toEqual(['requests','listener']);
  release();
  expect(await close(new AbortController().signal)).toBe('closed');
  expect(order).toEqual(['requests','listener','protocol','background']);
});

it.each(['failed', 'incomplete'] as const)('refuses successful termination after %s drainage', async outcome => {
  await expect(drainBeforeTerminate(async () => outcome, new AbortController().signal))
    .rejects.toThrow(`Transport shutdown ${outcome}`);
});
it('permits successful termination only after drainage completes', async () => {
  await expect(drainBeforeTerminate(async () => 'closed', new AbortController().signal))
    .resolves.toBeUndefined();
});
