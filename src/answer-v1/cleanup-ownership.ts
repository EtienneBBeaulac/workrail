import type { OwnerFence, ExecutionRef } from './contracts/invocation-contract.js';
import type { SessionJournal } from './journal.js';
import { owns } from './host-state.js';
import { foldSupervisor } from './supervisor-state.js';
import { foldAnswerOwnership } from '../v2/durable-core/projections/answer-ownership.js';

declare const cleanupBrand: unique symbol;
/** This reference cannot be passed to any execution, inference or answer-commit port. */
export type CleanupFence = Readonly<{
  execution: ExecutionRef; epoch: bigint; previousEpoch: bigint; supervisor: string;
  [cleanupBrand]: never;
}>;
export type ClaimCleanupResult =
  | Readonly<{ kind: 'claimed'; fence: CleanupFence }>
  | Readonly<{ kind: 'refused'; reason: 'ownership_changed' | 'missing_identity' | 'invalid_scope' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** Revokes future canonical writes under the old owner, atomically. It neither performs
 * teardown nor proves that previously dispatched backend/provider work has settled.
 * Reconciliation must establish that separate boundary before it can release anything. */
export async function claimCleanupOwnership(
  journal: SessionJournal, expected: OwnerFence, supervisor: string, signal: AbortSignal,
): Promise<ClaimCleanupResult> {
  const uncertain = { kind: 'unconfirmed', reason: 'commit_uncertain' } as const;
  return journal.locked<ClaimCleanupResult>(signal, uncertain, async (state, lock) => {
    if (expected.execution !== state.enrollment.execution || state.mode !== 'host_bound')
      return { kind: 'refused', reason: 'invalid_scope' };
    const current = state.ownership;
    if (current.kind === 'cleanup') {
      return current.previousEpoch === expected.epoch && current.supervisor === supervisor
        ? { kind: 'claimed', fence: Object.freeze({ execution: expected.execution, epoch: current.epoch, previousEpoch: current.previousEpoch, supervisor: current.supervisor }) as CleanupFence }
        : { kind: 'refused', reason: 'ownership_changed' };
    }
    if (!owns(state, expected)) return { kind: 'refused', reason: 'ownership_changed' };
    const projected = foldSupervisor(state.records);
    if (projected.kind !== 'valid' || projected.state.kind === 'absent')
      return { kind: 'refused', reason: 'missing_identity' };
    const intent = projected.state.kind === 'unconfirmed' ? projected.state.pending.intent : projected.state.intent;
    if (!intent.daemon) return { kind: 'refused', reason: 'missing_identity' };
    if (intent.supervisor !== supervisor || intent.epoch !== expected.epoch.toString())
      return { kind: 'refused', reason: 'invalid_scope' };
    const record = { kind: 'cleanup_claimed', epoch: (expected.epoch + 1n).toString(),
      previousEpoch: expected.epoch.toString(), supervisor } as const;
    if (foldAnswerOwnership([...state.records, record]).kind !== 'valid'
      || foldSupervisor([...state.records, record]).kind !== 'valid')
      return { kind: 'refused', reason: 'invalid_scope' };
    if (!await journal.append(state, lock, record, signal)) return uncertain;
    return { kind: 'claimed', fence: Object.freeze({ execution: expected.execution,
      epoch: expected.epoch + 1n, previousEpoch: expected.epoch, supervisor }) as CleanupFence };
  });
}
