import type { AnswerHostRecord } from '../schemas/session/answer-host.js';
import type { SupervisorBinding, SupervisorCreateIntent, SupervisorUnconfirmed } from '../schemas/session/supervisor.js';

type BoundPhase = 'created' | 'start_pending' | 'running' | 'stop_pending' | 'process_stopped';
type PendingSupervisorState =
  | Readonly<{ kind: 'create_pending'; intent: SupervisorCreateIntent }>
  | Readonly<{ kind: 'start_pending' | 'stop_pending'; intent: SupervisorCreateIntent; binding: SupervisorBinding }>;
export type SupervisorState =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'create_pending'; intent: SupervisorCreateIntent }>
  | Readonly<{ kind: BoundPhase; intent: SupervisorCreateIntent; binding: SupervisorBinding }>
  | Readonly<{ kind: 'unconfirmed'; pending: PendingSupervisorState; outcome: SupervisorUnconfirmed }>;
export type SupervisorProjection =
  | Readonly<{ kind: 'valid'; state: SupervisorState }>
  | Readonly<{ kind: 'invalid'; recordIndex: number; reason: 'invalid_scope' | 'duplicate_intent' | 'invalid_transition' | 'identity_mismatch' }>;

/** Canonical diagnosis only. Replaying an acknowledged state never grants fresh authority.
 * Cleanup/reconciliation and backend dispatch are separate, currently unimplemented capabilities. */
export function foldSupervisor(records: readonly AnswerHostRecord[]): SupervisorProjection {
  let state: SupervisorState = { kind: 'absent' };
  let owner: string | undefined;
  let stopped = false;
  for (const [recordIndex, record] of records.entries()) {
    const invalid = (reason: Extract<SupervisorProjection, { kind: 'invalid' }>['reason']): SupervisorProjection =>
      ({ kind: 'invalid', recordIndex, reason });
    switch (record.kind) {
      case 'owner_acquired': owner = record.epoch; break;
      case 'owner_released': owner = undefined; break;
      case 'stopped': stopped = true; break;
      case 'supervisor_create_intended':
        if (!owner || owner !== record.epoch || stopped) return invalid('invalid_scope');
        if (state.kind !== 'absent') return invalid('duplicate_intent');
        state = { kind: 'create_pending', intent: record };
        break;
      case 'supervisor_created':
      case 'supervisor_start_intended':
      case 'supervisor_started':
      case 'supervisor_stop_intended':
      case 'supervisor_process_stopped':
      case 'supervisor_unconfirmed': {
        if (state.kind === 'absent' || state.kind === 'unconfirmed') return invalid('invalid_transition');
        if (!owner || owner !== record.epoch || state.intent.epoch !== record.epoch)
          return invalid('invalid_scope');
        if (state.intent.supervisor !== record.supervisor) return invalid('identity_mismatch');
        if ('binding' in record && 'binding' in state && state.binding
          && (record.binding.daemon !== state.binding.daemon || record.binding.environment !== state.binding.environment))
          return invalid('identity_mismatch');
        const intent: SupervisorCreateIntent = state.intent;
        switch (record.kind) {
          case 'supervisor_created':
            if (state.kind !== 'create_pending') return invalid('invalid_transition');
            state = { kind: 'created', intent, binding: record.binding }; break;
          case 'supervisor_start_intended':
            if (stopped) return invalid('invalid_scope');
            if (state.kind !== 'created') return invalid('invalid_transition');
            state = { kind: 'start_pending', intent, binding: state.binding }; break;
          case 'supervisor_started':
            // Preserve an already-issued start acknowledgment even after host cancellation.
            if (state.kind !== 'start_pending') return invalid('invalid_transition');
            state = { kind: 'running', intent, binding: state.binding }; break;
          case 'supervisor_stop_intended':
            // Cleanup intent is allowed after host cancellation, never new execution.
            if (state.kind !== 'created' && state.kind !== 'running') return invalid('invalid_transition');
            state = { kind: 'stop_pending', intent, binding: state.binding }; break;
          case 'supervisor_process_stopped':
            if (state.kind !== 'stop_pending') return invalid('invalid_transition');
            state = { kind: 'process_stopped', intent, binding: state.binding }; break;
          case 'supervisor_unconfirmed': {
            const pending = { create: 'create_pending', start: 'start_pending', stop: 'stop_pending' } as const;
            if (state.kind !== 'create_pending' && state.kind !== 'start_pending' && state.kind !== 'stop_pending')
              return invalid('invalid_transition');
            if (state.kind !== pending[record.operation]) return invalid('invalid_transition');
            const prior: PendingSupervisorState = state.kind === 'create_pending'
              ? state : { kind: state.kind, intent, binding: state.binding };
            state = { kind: 'unconfirmed', pending: prior, outcome: record };
            break;
          }
        }
        break;
      }
      default: break;
    }
  }
  return { kind: 'valid', state };
}
