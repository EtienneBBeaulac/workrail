import type { AnswerHostRecord } from '../v2/durable-core/schemas/session/answer-host.js';
import type { WorkspaceEffectIntent, WorkspaceEffectCompletion, WorkspaceEffectUnconfirmed } from '../v2/durable-core/schemas/session/workspace-effect.js';

export type WorkspaceEffectState =
  | Readonly<{ kind: 'pending'; intent: WorkspaceEffectIntent }>
  | Readonly<{ kind: 'completed'; intent: WorkspaceEffectIntent; completion: WorkspaceEffectCompletion }>
  | Readonly<{ kind: 'unconfirmed'; intent: WorkspaceEffectIntent; outcome: WorkspaceEffectUnconfirmed }>;
export type WorkspaceEffectProjection =
  | Readonly<{ kind: 'valid'; effects: readonly WorkspaceEffectState[] }>
  | Readonly<{ kind: 'invalid'; recordIndex: number; reason: 'invalid_scope' | 'duplicate_identity' | 'unresolved_effect' | 'invalid_completion' }>;

/** Pure replay, not an execution grant. Pending intent remains uncertain after restart.
 * No completion here asserts quiescence, grants takeover, or authorizes repetition. */
export function foldWorkspaceEffects(records: readonly AnswerHostRecord[]): WorkspaceEffectProjection {
  let effects: readonly WorkspaceEffectState[] = [];
  let owner: string | undefined;
  let delivery: Extract<AnswerHostRecord, {kind: 'delivered'}> | undefined;
  let modelCall: Extract<AnswerHostRecord, {kind: 'model_call_reserved'}> | undefined;
  let stopped = false;
  for (const [recordIndex, record] of records.entries()) {
    const invalid = (reason: Extract<WorkspaceEffectProjection, {kind: 'invalid'}>['reason']): WorkspaceEffectProjection =>
      ({ kind: 'invalid', recordIndex, reason });
    switch (record.kind) {
      case 'owner_acquired': owner = record.epoch; modelCall = undefined; break;
      case 'owner_released': owner = undefined; modelCall = undefined; break;
      case 'delivered': delivery = record; modelCall = undefined; break;
      case 'model_call_reserved': modelCall = record; break;
      case 'captured':
        if (delivery?.delivery === record.delivery) modelCall = undefined;
        break;
      case 'stopped': stopped = true; break;
      case 'workspace_effect_intended': {
        if (stopped || !owner || owner !== record.epoch || delivery?.delivery !== record.delivery
          || delivery.epoch !== owner || modelCall?.call !== record.modelCall
          || modelCall.delivery !== record.delivery || modelCall.epoch !== owner)
          return invalid('invalid_scope');
        if (effects.some(effect => effect.intent.effect === record.effect
          || (effect.intent.modelCall === record.modelCall
            && (effect.intent.position === record.position || effect.intent.toolCallId === record.toolCallId))))
          return invalid('duplicate_identity');
        if (effects.some(effect => effect.kind !== 'completed')) return invalid('unresolved_effect');
        effects = [...effects, { kind: 'pending', intent: record }];
        break;
      }
      case 'workspace_effect_completed':
      case 'workspace_effect_unconfirmed': {
        const prior = effects.find(effect => effect.intent.effect === record.effect);
        if (!prior || prior.kind !== 'pending' || prior.intent.epoch !== record.epoch
          || owner !== record.epoch || stopped || delivery?.delivery !== prior.intent.delivery
          || modelCall?.call !== prior.intent.modelCall) return invalid('invalid_completion');
        const next: WorkspaceEffectState = record.kind === 'workspace_effect_completed'
          ? { kind: 'completed', intent: prior.intent, completion: record }
          : { kind: 'unconfirmed', intent: prior.intent, outcome: record };
        effects = effects.map(effect => effect === prior ? next : effect);
        break;
      }
      default: break;
    }
  }
  return { kind: 'valid', effects };
}
