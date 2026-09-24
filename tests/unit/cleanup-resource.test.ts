import { expect, it } from 'vitest';
import { foldCleanupResource } from '../../src/v2/durable-core/projections/cleanup-resource.js';
import { foldAnswerOwnership } from '../../src/v2/durable-core/projections/answer-ownership.js';
import { AnswerHostRecordSchema, type AnswerHostRecord } from '../../src/v2/durable-core/schemas/session/answer-host.js';
const scope = { epoch: '2', supervisor: 's', daemon: 'd', container: 'a'.repeat(64) };
const initial: readonly AnswerHostRecord[] = [
  { kind: 'owner_acquired', epoch: '1' },
  { kind: 'supervisor_create_intended', epoch: '1', supervisor: 's', daemon: 'd', configurationDigest: 'b'.repeat(64) },
  { kind: 'cleanup_claimed', epoch: '2', previousEpoch: '1', supervisor: 's' },
];
const lifecycle = [
  { kind: 'cleanup_resource_bound', ...scope },
  { kind: 'cleanup_stop_intended', ...scope },
  { kind: 'cleanup_stopped', ...scope },
  { kind: 'cleanup_remove_intended', ...scope },
  { kind: 'cleanup_removed', ...scope, evidence: 'remove_acknowledged' },
] as const;
it('retains late binding separately from an unacknowledged create and never releases ownership', () => {
  const phases = ['unbound', 'bound', 'stop_pending', 'stopped', 'remove_pending', 'removed'];
  for (let count = 0; count <= lifecycle.length; count++) {
    const records = [...initial, ...lifecycle.slice(0, count)];
    const replay = foldCleanupResource(records);
    expect(replay.kind === 'valid' && replay.state.kind).toBe(phases[count]);
    expect(foldAnswerOwnership(records)).toEqual({ kind: 'valid', ownership: {
      kind: 'cleanup', epoch: 2n, previousEpoch: 1n, supervisor: 's' } });
  }
});
it('replays stop after a late start races removal, preserving the exact container identity', () => {
  const records = [...initial, ...lifecycle.slice(0, 4), ...lifecycle.slice(1)];
  expect(foldCleanupResource(records)).toEqual({ kind: 'valid', state: { kind: 'removed', binding: lifecycle[0] } });
});
it('requires an exact durable removal intent before accepting observed absence', () => {
  const removed = { ...lifecycle[4], evidence: 'absent_after_remove_intent' } as const;
  expect(foldCleanupResource([...initial, ...lifecycle.slice(0, 4), removed]).kind).toBe('valid');
  for (let count = 0; count < 4; count++)
    expect(foldCleanupResource([...initial, ...lifecycle.slice(0, count), removed]).kind).toBe('invalid');
});
it('rejects foreign bindings, epochs and supervisor scope at every resource transition', () => {
  for (let index = 0; index < lifecycle.length; index++) {
    for (const change of [{ epoch: '1' }, { supervisor: 'other' }, { daemon: 'other' },
      ...(index > 0 ? [{ container: 'c'.repeat(64) }] : [])]) {
      expect(foldCleanupResource([...initial, ...lifecycle.slice(0, index), { ...lifecycle[index]!, ...change }]).kind).toBe('invalid');
    }
  }
});
it('rejects a late binding that replaces a previously acknowledged container', () => {
  const known: AnswerHostRecord = { kind: 'supervisor_created', epoch: '1', supervisor: 's',
    binding: { daemon: 'd', environment: 'c'.repeat(64) } };
  expect(foldCleanupResource([...initial.slice(0, 2), known, initial[2]!, lifecycle[0]]).kind).toBe('invalid');
});
it('refuses missing claims, duplicate transitions, and execution after cleanup', () => {
  expect(foldCleanupResource([...initial.slice(0, 2), lifecycle[0]]).kind).toBe('invalid');
  for (let index = 0; index < lifecycle.length; index++) {
    expect(foldCleanupResource([...initial, ...lifecycle.slice(0, index + 1), lifecycle[index]!]).kind).toBe('invalid');
  }
  expect(foldCleanupResource([...initial, ...lifecycle, { kind: 'owner_acquired', epoch: '3' }]).kind).toBe('invalid');
});
it('boundary schemas reject non-immutable container identifiers and unrecognized evidence', () => {
  for (const container of ['name', 'a'.repeat(12), 'g'.repeat(64), ''])
    expect(AnswerHostRecordSchema.safeParse({ ...lifecycle[0], container }).success).toBe(false);
  expect(AnswerHostRecordSchema.safeParse({ ...lifecycle[4], evidence: 'timeout' }).success).toBe(false);
});

it('can recover a delayed earlier removal after returning to stop intent', () => {
  const records = [...initial, ...lifecycle.slice(0, 4), lifecycle[1],
    { ...lifecycle[4], evidence: 'absent_after_remove_intent' } as const];
  expect(foldCleanupResource(records).kind).toBe('valid');
});
