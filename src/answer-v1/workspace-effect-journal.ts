import { WorkspaceEffectIntentSchema, WorkspaceEffectCompletedSchema, WorkspaceEffectUnconfirmedSchema } from '../v2/durable-core/schemas/session/workspace-effect.js';
import type { OwnerFence } from './contracts/invocation-contract.js';
import type { SessionJournal } from './journal.js';
import { owns } from './host-state.js';
import { foldWorkspaceEffects } from './workspace-effect-state.js';

const Input = WorkspaceEffectIntentSchema.omit({ kind: true, effect: true, epoch: true });
const Outcome = WorkspaceEffectCompletedSchema.omit({ epoch: true }).or(WorkspaceEffectUnconfirmedSchema.omit({ epoch: true }));
type Failure =
  | Readonly<{ kind: 'refused'; reason: 'invalid_input' | 'not_started' | 'stale_owner' | 'invalid_history' | 'invalid_transition' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;
export type ReserveWorkspaceEffectResult = Readonly<{ kind: 'reserved'; effect: string }> | Failure;
export type RetainWorkspaceEffectResult = Readonly<{ kind: 'retained' }> | Failure;
const uncertain = { kind: 'unconfirmed', reason: 'commit_uncertain' } as const;

/** Trusted journal primitive only. Reservation does not replace a supervised workspace
 * capability. Never invoke after an unacknowledged intent, including after re-reading it. */
export async function reserveWorkspaceEffect(
  journal: SessionJournal, owner: OwnerFence, raw: unknown, signal: AbortSignal,
): Promise<ReserveWorkspaceEffectResult> {
  const input = Input.safeParse(raw);
  if (!input.success) return { kind: 'refused', reason: 'invalid_input' };
  try {
    if (!await journal.fault('before_effect_intent_append', signal))
      return { kind: 'refused', reason: 'not_started' };
  } catch { return { kind: 'refused', reason: 'not_started' }; }
  try {
    const result = await journal.locked<ReserveWorkspaceEffectResult>(signal, uncertain, async (state, lock) => {
      if (!owns(state, owner)) return { kind: 'refused', reason: 'stale_owner' };
      if (foldWorkspaceEffects(state.records).kind !== 'valid') return { kind: 'refused', reason: 'invalid_history' };
      const intent = WorkspaceEffectIntentSchema.safeParse({ ...input.data, kind: 'workspace_effect_intended',
        effect: journal.engine.idFactory.mintEventId(), epoch: owner.epoch.toString() });
      if (!intent.success) return { kind: 'refused', reason: 'invalid_input' };
      if (foldWorkspaceEffects([...state.records, intent.data]).kind !== 'valid')
        return { kind: 'refused', reason: 'invalid_transition' };
      return await journal.append(state, lock, intent.data, signal)
        ? { kind: 'reserved', effect: intent.data.effect } : uncertain;
    });
    return result.kind === 'reserved' && !await journal.fault('after_effect_intent_append', signal) ? uncertain : result;
  } catch { return uncertain; }
}

/** Acknowledges an outcome, not quiescence. Duplicate completion is refused rather than
 * converted into fresh success after lost acknowledgement. Pending remains conservative
 * if cancellation or storage failure prevents recording the unknown outcome. */
export async function retainWorkspaceEffect(
  journal: SessionJournal, owner: OwnerFence, raw: unknown, signal: AbortSignal,
): Promise<RetainWorkspaceEffectResult> {
  const input = Outcome.safeParse(raw);
  if (!input.success) return { kind: 'refused', reason: 'invalid_input' };
  try {
    if (!await journal.fault('before_effect_outcome_append', signal)) return uncertain;
    const result = await journal.locked<RetainWorkspaceEffectResult>(signal, uncertain, async (state, lock) => {
      if (!owns(state, owner)) return { kind: 'refused', reason: 'stale_owner' };
      if (foldWorkspaceEffects(state.records).kind !== 'valid') return { kind: 'refused', reason: 'invalid_history' };
      const outcome = { ...input.data, epoch: owner.epoch.toString() };
      if (foldWorkspaceEffects([...state.records, outcome]).kind !== 'valid')
        return { kind: 'refused', reason: 'invalid_transition' };
      return await journal.append(state, lock, outcome, signal) ? { kind: 'retained' } : uncertain;
    });
    return result.kind === 'retained' && !await journal.fault('after_effect_outcome_append', signal) ? uncertain : result;
  } catch { return uncertain; }
}
