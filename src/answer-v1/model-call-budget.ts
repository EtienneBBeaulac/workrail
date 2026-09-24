import type { DeliveryRef, OwnerFence } from './contracts/invocation-contract.js';
import { owns } from './host-state.js';
import type { SessionJournal } from './journal.js';

export type ReserveModelCallResult =
  | Readonly<{ kind: 'reserved'; call: string; ordinal: number }>
  | Readonly<{ kind: 'refused'; reason: 'storage_unavailable' | 'stale_owner' | 'stopped' | 'invalid_delivery' | 'missing_policy' | 'budget_exhausted' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** A reservation spends budget even if its acknowledgement or provider response is lost.
 * It is never replayed as a fresh grant. This primitive does not authorize restart. */
export async function reserveModelCall(
  journal: SessionJournal, delivery: DeliveryRef, owner: OwnerFence, signal: AbortSignal,
): Promise<ReserveModelCallResult> {
  if (!await journal.fault('before_model_call_append', signal)) return { kind: 'refused', reason: 'storage_unavailable' };
  const result = await journal.locked<ReserveModelCallResult>(signal, { kind: 'unconfirmed', reason: 'commit_uncertain' }, async (state, lock) => {
    if (!owns(state, owner)) return { kind: 'refused', reason: 'stale_owner' };
    if (state.records.some(record => record.kind === 'stopped')) return { kind: 'refused', reason: 'stopped' };
    const enrolled = state.records.find(record => record.kind === 'enrolled');
    const policy = enrolled?.kind === 'enrolled' ? enrolled.request?.daemonPolicy : undefined;
    if (!policy) return { kind: 'refused', reason: 'missing_policy' };
    const current = [...state.records].reverse().find(record => record.kind === 'delivered');
    if (current?.kind !== 'delivered' || current.delivery !== delivery || current.epoch !== owner.epoch.toString()
      || state.records.some(record => record.kind === 'captured' && record.delivery === delivery))
      return { kind: 'refused', reason: 'invalid_delivery' };
    const spent = state.records.filter(record => record.kind === 'model_call_reserved').length;
    if (spent >= policy.limits.maxModelCalls) return { kind: 'refused', reason: 'budget_exhausted' };
    const call = journal.engine.idFactory.mintEventId();
    const ordinal = spent + 1;
    return await journal.append(state, lock, { kind: 'model_call_reserved', delivery, call, epoch: owner.epoch.toString(), ordinal }, signal)
      ? { kind: 'reserved', call, ordinal } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
  });
  return result.kind === 'reserved' && !await journal.fault('after_model_call_append', signal)
    ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : result;
}

export type BudgetedProviderResult<T> =
  | Readonly<{ kind: 'completed'; value: T }>
  | Exclude<ReserveModelCallResult, { kind: 'reserved' }>
  | Readonly<{ kind: 'refused'; reason: 'busy' | 'reconciliation_required' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'provider_outcome_unknown' }>;

/** Host-only composition. The adapter gets invoke, never a journal, owner or reusable
 * grant. The supplied transport must disable hidden retries. No automatic recovery
 * or workspace-effect safety is implied by accounting for calls. */
export function bindBudgetedProvider<Input, Output>(
  journal: SessionJournal, delivery: DeliveryRef, owner: OwnerFence,
  send: (input: Input, signal: AbortSignal) => Promise<Output>,
): Readonly<{ invoke(input: Input, signal: AbortSignal): Promise<BudgetedProviderResult<Output>> }> {
  let state: 'ready' | 'reserving' | 'sending' | 'uncertain' = 'ready';
  return { async invoke(input, signal) {
    if (state !== 'ready') return { kind: 'refused', reason: state === 'uncertain' ? 'reconciliation_required' : 'busy' };
    state = 'reserving';
    try {
      const reservation = await reserveModelCall(journal, delivery, owner, signal);
      if (reservation.kind !== 'reserved') {
        state = reservation.kind === 'unconfirmed' ? 'uncertain' : 'ready';
        return reservation;
      }
      if (signal.aborted) { state = 'uncertain'; return { kind: 'unconfirmed', reason: 'provider_outcome_unknown' }; }
      state = 'sending';
      const value = await send(input, signal);
      if (signal.aborted) { state = 'uncertain'; return { kind: 'unconfirmed', reason: 'provider_outcome_unknown' }; }
      state = 'ready';
      return { kind: 'completed', value };
    } catch {
      const reason = state === 'sending' ? 'provider_outcome_unknown' : 'commit_uncertain';
      state = 'uncertain';
      return { kind: 'unconfirmed', reason };
    }
  } };
}
