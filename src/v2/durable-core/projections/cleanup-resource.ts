import type { AnswerHostRecord } from '../schemas/session/answer-host.js';
import type { CleanupResourceBinding } from '../schemas/session/cleanup-resource.js';
import { foldAnswerOwnership } from './answer-ownership.js';
import { foldSupervisor } from './supervisor-state.js';

type BoundPhase = 'bound' | 'stop_pending' | 'stopped' | 'remove_pending' | 'removed';
export type CleanupResourceState =
  | Readonly<{ kind: 'inactive' }>
  | Readonly<{ kind: 'unbound' }>
  | Readonly<{ kind: BoundPhase; binding: CleanupResourceBinding }>;
export type CleanupResourceProjection =
  | Readonly<{ kind: 'valid'; state: CleanupResourceState }>
  | Readonly<{ kind: 'invalid'; recordIndex: number }>;

/** A removed resource is not a settled allocation, provider call, or successful task.
 * In particular, this fold never creates an execution fence or releases ownership. */
export function foldCleanupResource(records: readonly AnswerHostRecord[]): CleanupResourceProjection {
  const ownership = foldAnswerOwnership(records);
  if (ownership.kind === 'invalid') return ownership;
  const supervisor = foldSupervisor(records);
  if (supervisor.kind === 'invalid') return { kind: 'invalid', recordIndex: supervisor.recordIndex };
  const resource = supervisor.state.kind === 'unconfirmed' ? supervisor.state.pending : supervisor.state;
  let state: CleanupResourceState = { kind: 'inactive' };
  for (const [recordIndex, record] of records.entries()) {
    const invalid = (): CleanupResourceProjection => ({ kind: 'invalid', recordIndex });
    switch (record.kind) {
      case 'cleanup_claimed': state = { kind: 'unbound' }; break;
      case 'cleanup_resource_bound':
      case 'cleanup_stop_intended':
      case 'cleanup_stopped':
      case 'cleanup_remove_intended':
      case 'cleanup_removed': {
        const owner = ownership.ownership;
        if (state.kind === 'inactive' || owner.kind !== 'cleanup'
          || record.epoch !== owner.epoch.toString() || record.supervisor !== owner.supervisor
          || resource.kind === 'absent' || record.daemon !== resource.intent.daemon)
          return invalid();
        if ('binding' in resource && (record.container !== resource.binding.environment
          || record.daemon !== resource.binding.daemon)) return invalid();
        if ('binding' in state && (record.container !== state.binding.container
          || record.daemon !== state.binding.daemon)) return invalid();
        if (record.kind === 'cleanup_resource_bound') {
          if (state.kind !== 'unbound') return invalid();
          state = { kind: 'bound', binding: record };
          break;
        }
        if (!('binding' in state)) return invalid();
        const binding: CleanupResourceBinding = state.binding;
        switch (record.kind) {
          case 'cleanup_stop_intended':
            // A reserved old start can arrive after a stop. Retry only this same ID.
            if (state.kind !== 'bound' && state.kind !== 'stopped' && state.kind !== 'remove_pending') return invalid();
            state = { kind: 'stop_pending', binding }; break;
          case 'cleanup_stopped':
            if (state.kind !== 'stop_pending') return invalid();
            state = { kind: 'stopped', binding }; break;
          case 'cleanup_remove_intended':
            if (state.kind !== 'stopped') return invalid();
            state = { kind: 'remove_pending', binding }; break;
          case 'cleanup_removed':
            if (state.kind === 'removed' || !records.slice(0, recordIndex).some(prior =>
              prior.kind === 'cleanup_remove_intended' && prior.epoch === record.epoch
              && prior.supervisor === record.supervisor && prior.daemon === record.daemon
              && prior.container === record.container)) return invalid();
            state = { kind: 'removed', binding }; break;
        }
        break;
      }
      default: break;
    }
  }
  return { kind: 'valid', state };
}
