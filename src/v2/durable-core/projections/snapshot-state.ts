import type { EngineStateV1, PendingStepV1 } from '../schemas/execution-snapshot/index.js';

export function deriveIsComplete(state: EngineStateV1): boolean {
  return state.kind === 'complete';
}

export function derivePendingStep(state: EngineStateV1): PendingStepV1 | null {
  if (state.kind !== 'running' && state.kind !== 'blocked') return null;
  if (state.pending.kind !== 'some') return null;
  return state.pending.step;
}
