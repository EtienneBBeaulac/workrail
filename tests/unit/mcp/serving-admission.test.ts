import { it, expect } from 'vitest';
import { ServingAdmission } from '../../../src/mcp/transports/serving-admission.js';

it('refuses overflow before allocation and releases completed exchanges', async () => {
  const admission = new ServingAdmission();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let allocations = 0;
  const accepted = Array.from({ length: 128 }, () => admission.serve(async () => { allocations++; await held; }));
  expect(await admission.serve(async () => { allocations++; })).toEqual({ kind: 'refused', reason: 'capacity' });
  expect(allocations).toBe(128);
  release();
  expect((await Promise.all(accepted)).every(outcome => outcome.kind === 'served')).toBe(true);
  expect(await admission.serve(async () => 'next')).toEqual({ kind: 'served', value: 'next' });
  await admission.close();
});

it('seals immediately while accepted work drains without cancellation', async () => {
  const admission = new ServingAdmission();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const accepted = admission.serve(async () => { await held; return 'retained'; });
  const closing = admission.close();
  expect(await admission.serve(async () => 'forbidden')).toEqual({ kind: 'refused', reason: 'closing' });
  release();
  expect(await accepted).toEqual({ kind: 'served', value: 'retained' });
  await closing;
});

it('represents failed serving as data and releases its slot', async () => {
  const admission = new ServingAdmission();
  expect(await admission.serve(async () => { throw Error('controlled boundary failure'); })).toEqual({ kind: 'failed', message: 'controlled boundary failure' });
  expect(await admission.serve(async () => 'next')).toEqual({ kind: 'served', value: 'next' });
  await admission.close();
});
