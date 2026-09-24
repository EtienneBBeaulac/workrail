import { expect, it } from 'vitest';
import { foldAnswerOwnership } from '../../src/v2/durable-core/projections/answer-ownership.js';
import type { AnswerHostRecord } from '../../src/v2/durable-core/schemas/session/answer-host.js';
const owner: AnswerHostRecord = { kind: 'owner_acquired', epoch: '1' };
const claim: AnswerHostRecord = { kind: 'cleanup_claimed', epoch: '2', previousEpoch: '1', supervisor: 's' };
it('retains monotonic epochs across release and explicit replacement', () => {
  expect(foldAnswerOwnership([])).toEqual({ kind: 'valid', ownership: { kind: 'unowned', epoch: 0n } });
  expect(foldAnswerOwnership([owner, { kind: 'owner_released', epoch: '1' }]))
    .toEqual({ kind: 'valid', ownership: { kind: 'unowned', epoch: 1n } });
  expect(foldAnswerOwnership([owner, { kind: 'owner_acquired', epoch: '2' }]))
    .toEqual({ kind: 'valid', ownership: { kind: 'execution', epoch: 2n } });
});
it('represents cleanup separately, without a release or execution transition', () => {
  expect(foldAnswerOwnership([owner, claim])).toEqual({ kind: 'valid', ownership: {
    kind: 'cleanup', epoch: 2n, previousEpoch: 1n, supervisor: 's' } });
  for (const forbidden of [owner, claim, { kind: 'owner_acquired', epoch: '3' },
    { kind: 'owner_released', epoch: '2' }] as AnswerHostRecord[])
    expect(foldAnswerOwnership([owner, claim, forbidden]).kind).toBe('invalid');
});
it('rejects epoch substitution and claims against released owners', () => {
  for (const records of [[claim], [owner, { ...claim, previousEpoch: '2' }], [owner, { ...claim, epoch: '1' }],
    [owner, { kind: 'owner_released', epoch: '1' }, claim], [owner, owner],
    [owner, { kind: 'owner_released', epoch: '2' }]] as AnswerHostRecord[][])
    expect(foldAnswerOwnership(records).kind).toBe('invalid');
});
