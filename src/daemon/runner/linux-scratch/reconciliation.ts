import type { CleanupFence } from '../../../answer-v1/cleanup-ownership.js';
import { recordCleanupResource, type CleanupResourceEvent } from '../../../answer-v1/cleanup-journal.js';
import type { SessionJournal } from '../../../answer-v1/journal.js';
import { foldCleanupResource } from '../../../v2/durable-core/projections/cleanup-resource.js';
import { foldSupervisor } from '../../../answer-v1/supervisor-state.js';
import { observeScratchResource } from './observation.js';
import type { DockerCli } from './docker-cli.js';

export type CleanupReconciliationResult =
  | Readonly<{ kind: 'resource_removed'; executionSettlement: 'unresolved' }>
  | Readonly<{ kind: 'unresolved'; reason: 'resource_absent_without_removal_intent' }>
  | Readonly<{ kind: 'refused'; reason: 'ownership_changed' | 'identity_mismatch' | 'invalid_history' }>
  | Readonly<{ kind: 'unconfirmed' }>;

/** Internal teardown shell. Each call is bounded, resumes retained intent, and can only
 * stop/remove the exact retained ID. It never releases ownership or declares task success. */
export async function reconcileScratchCleanup(journal: SessionJournal, fence: CleanupFence,
  docker: Pick<DockerCli, 'run'>, signal: AbortSignal): Promise<CleanupReconciliationResult> {
  const unknown = { kind: 'unconfirmed' } as const;
  const removed = { kind: 'resource_removed', executionSettlement: 'unresolved' } as const;
  const snapshot = await journal.locked(signal, undefined, async state => {
    const owner = state.ownership;
    if (owner.kind !== 'cleanup' || state.enrollment.execution !== fence.execution
      || owner.epoch !== fence.epoch || owner.previousEpoch !== fence.previousEpoch
      || owner.supervisor !== fence.supervisor) return { kind: 'stale' as const };
    return { kind: 'ready' as const, cleanup: foldCleanupResource(state.records), supervisor: foldSupervisor(state.records), records: state.records };
  });
  if (!snapshot) return unknown;
  if (snapshot.kind === 'stale') return { kind: 'refused', reason: 'ownership_changed' };
  if (snapshot.cleanup.kind !== 'valid' || snapshot.supervisor.kind !== 'valid'
    || snapshot.cleanup.state.kind === 'inactive') return { kind: 'refused', reason: 'invalid_history' };
  let current = snapshot.cleanup.state;
  if (current.kind === 'removed') return removed;
  const observation = await observeScratchResource(snapshot.supervisor.state, docker, signal,
    'binding' in current ? current.binding : undefined);
  if (observation.kind === 'identity_mismatch') return { kind: 'refused', reason: 'identity_mismatch' };
  if (observation.kind !== 'present' && observation.kind !== 'absent_at_observation') return unknown;
  const retain = async (record: CleanupResourceEvent): Promise<CleanupReconciliationResult | undefined> => {
    const saved = await recordCleanupResource(journal, fence, record, signal);
    if (saved.kind === 'unconfirmed') return unknown;
    if (saved.kind === 'refused') return { kind: 'refused', reason: saved.reason === 'ownership_changed' ? 'ownership_changed' : 'invalid_history' };
    if (saved.state.kind === 'inactive') return { kind: 'refused', reason: 'invalid_history' };
    current = saved.state;
    return undefined;
  };
  if (observation.kind === 'absent_at_observation') {
    const retained = 'binding' in current ? current.binding : undefined;
    if (!retained || !snapshot.records.some(record => record.kind === 'cleanup_remove_intended'
      && record.epoch === fence.epoch.toString() && record.supervisor === fence.supervisor
      && record.daemon === retained.daemon && record.container === retained.container))
      return { kind: 'unresolved', reason: 'resource_absent_without_removal_intent' };
    return await retain({ ...retained, kind: 'cleanup_removed', evidence: 'absent_after_remove_intent' }) ?? removed;
  }
  const scope = { epoch: fence.epoch.toString(), supervisor: observation.supervisor,
    daemon: observation.daemon, container: observation.container };
  if (current.kind === 'unbound') {
    const failure = await retain({ kind: 'cleanup_resource_bound', ...scope });
    if (failure) return failure;
  }
  try {
    // An old start may race removal. Return to stopping the same immutable ID, never force rm.
    if (observation.phase === 'running' || current.kind === 'bound' || current.kind === 'stop_pending') {
      const stopIntentFailure = await retain({ kind: 'cleanup_stop_intended', ...scope });
      if (stopIntentFailure) return stopIntentFailure;
      if (observation.phase === 'running') {
        const stopped = await docker.run(['stop', '--time', '1', scope.container], signal);
        if (stopped.kind !== 'completed') return unknown;
        const checked = await observeScratchResource(snapshot.supervisor.state, docker, signal, scope);
        if (checked.kind !== 'present' || checked.phase !== 'stopped') return unknown;
      }
      const stoppedFailure = await retain({ kind: 'cleanup_stopped', ...scope });
      if (stoppedFailure) return stoppedFailure;
    }
    const removeIntentFailure = await retain({ kind: 'cleanup_remove_intended', ...scope });
    if (removeIntentFailure) return removeIntentFailure;
    const beforeRemove = await observeScratchResource(snapshot.supervisor.state, docker, signal, scope);
    if (beforeRemove.kind === 'identity_mismatch') return { kind: 'refused', reason: 'identity_mismatch' };
    if (beforeRemove.kind !== 'present' || beforeRemove.phase !== 'stopped') return unknown;
    const result = await docker.run(['rm', scope.container], signal);
    if (result.kind !== 'completed') return unknown;
    return await retain({ kind: 'cleanup_removed', ...scope, evidence: 'remove_acknowledged' }) ?? removed;
  } catch { return unknown; }
}
