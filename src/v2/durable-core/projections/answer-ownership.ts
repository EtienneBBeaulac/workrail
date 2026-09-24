import type { AnswerHostRecord } from '../schemas/session/answer-host.js';

/** Cleanup fences execution but never establishes process or provider quiescence. */
export type AnswerOwnership =
  | Readonly<{ kind: 'unowned'; epoch: bigint }>
  | Readonly<{ kind: 'execution'; epoch: bigint }>
  | Readonly<{ kind: 'cleanup'; epoch: bigint; previousEpoch: bigint; supervisor: string }>;
export type OwnershipProjection =
  | Readonly<{ kind: 'valid'; ownership: AnswerOwnership }>
  | Readonly<{ kind: 'invalid'; recordIndex: number }>;

export function foldAnswerOwnership(records: readonly AnswerHostRecord[]): OwnershipProjection {
  let ownership: AnswerOwnership = { kind: 'unowned', epoch: 0n };
  for (const [recordIndex, record] of records.entries()) {
    const invalid = (): OwnershipProjection => ({ kind: 'invalid', recordIndex });
    switch (record.kind) {
      case 'owner_acquired':
        if (ownership.kind === 'cleanup' || BigInt(record.epoch) !== ownership.epoch + 1n) return invalid();
        ownership = { kind: 'execution', epoch: BigInt(record.epoch) };
        break;
      case 'owner_released':
        if (ownership.kind !== 'execution' || BigInt(record.epoch) !== ownership.epoch) return invalid();
        ownership = { kind: 'unowned', epoch: ownership.epoch };
        break;
      case 'cleanup_claimed':
        if (ownership.kind !== 'execution' || BigInt(record.previousEpoch) !== ownership.epoch
          || BigInt(record.epoch) !== ownership.epoch + 1n) return invalid();
        ownership = { kind: 'cleanup', epoch: BigInt(record.epoch),
          previousEpoch: ownership.epoch, supervisor: record.supervisor };
        break;
      default: break;
    }
  }
  return { kind: 'valid', ownership };
}
