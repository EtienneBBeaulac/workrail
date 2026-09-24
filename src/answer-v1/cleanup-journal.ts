import type { SessionJournal } from './journal.js';
import type { CleanupFence } from './cleanup-ownership.js';
import { AnswerHostRecordSchema, type AnswerHostRecord } from '../v2/durable-core/schemas/session/answer-host.js';
import { foldCleanupResource, type CleanupResourceState } from '../v2/durable-core/projections/cleanup-resource.js';

export type CleanupResourceEvent = Extract<AnswerHostRecord, { kind:
  'cleanup_resource_bound' | 'cleanup_stop_intended' | 'cleanup_stopped'
  | 'cleanup_remove_intended' | 'cleanup_removed' }>;
export type RecordCleanupResult =
  | Readonly<{ kind: 'retained'; state: CleanupResourceState }>
  | Readonly<{ kind: 'refused'; reason: 'ownership_changed' | 'invalid_transition' }>
  | Readonly<{ kind: 'unconfirmed' }>;
const phase = {
  cleanup_resource_bound: 'bound', cleanup_stop_intended: 'stop_pending',
  cleanup_stopped: 'stopped', cleanup_remove_intended: 'remove_pending', cleanup_removed: 'removed',
} as const;

/** Internal receipt writer, not an operator assertion API. Backend reconciliation must
 * supply verified observations. No result authorizes create, start, inference or release. */
export async function recordCleanupResource(journal: SessionJournal, fence: CleanupFence,
  record: CleanupResourceEvent, signal: AbortSignal): Promise<RecordCleanupResult> {
  return journal.locked<RecordCleanupResult>(signal, { kind: 'unconfirmed' }, async (state, lock) => {
    const owner = state.ownership;
    if (state.mode !== 'host_bound' || state.enrollment.execution !== fence.execution
      || owner.kind !== 'cleanup' || owner.epoch !== fence.epoch || owner.previousEpoch !== fence.previousEpoch
      || owner.supervisor !== fence.supervisor)
      return { kind: 'refused', reason: 'ownership_changed' };
    if (!AnswerHostRecordSchema.safeParse(record).success || record.epoch !== fence.epoch.toString()
      || record.supervisor !== fence.supervisor) return { kind: 'refused', reason: 'invalid_transition' };
    const projected = foldCleanupResource(state.records);
    if (projected.kind === 'invalid') return { kind: 'refused', reason: 'invalid_transition' };
    const current = projected.state;
    // A cold retry of a lost append acknowledgment reuses the retained exact identity.
    if (current.kind === phase[record.kind] && 'binding' in current
      && current.binding.daemon === record.daemon && current.binding.container === record.container)
      return { kind: 'retained', state: current };
    const next = foldCleanupResource([...state.records, record]);
    if (next.kind === 'invalid') return { kind: 'refused', reason: 'invalid_transition' };
    return await journal.append(state, lock, record, signal)
      ? { kind: 'retained', state: next.state } : { kind: 'unconfirmed' };
  });
}
