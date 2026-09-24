import { readHostState } from './host-state.js';
import type { ExecutionRef, HostEnrollment } from './contracts/invocation-contract.js';
import type { AnswerReadEngine } from './engine-composition.js';
import { foldSupervisor } from './supervisor-state.js';

declare const cleanupTargetBrand: unique symbol;
/** A cold inspection can authorize only a compare-and-swap cleanup claim, never
 * execution. Keeping this distinct prevents recovery from minting an OwnerFence. */
export type CleanupTarget = Readonly<{
  execution: ExecutionRef; epoch: bigint; supervisor: string;
  [cleanupTargetBrand]: never;
}>;
export type InspectCleanupTargetResult =
  | Readonly<{ kind: 'target'; target: CleanupTarget }>
  | Readonly<{ kind: 'refused'; reason: 'missing_identity' | 'ownership_changed' }>
  | Readonly<{ kind: 'unconfirmed' }>;

export async function inspectCleanupTarget(reader: Readonly<{ engine: AnswerReadEngine; enrollment: HostEnrollment;
  available: (signal: AbortSignal) => boolean }>, signal: AbortSignal): Promise<InspectCleanupTargetResult> {
  if (!reader.available(signal)) return { kind: 'unconfirmed' };
  const loaded = await readHostState(reader.engine, reader.enrollment);
  if (loaded.kind !== 'loaded' || !reader.available(signal)) return { kind: 'unconfirmed' };
  const state = loaded.state;
  if (state.mode !== 'host_bound' || state.ownership.kind === 'unowned')
    return { kind: 'refused', reason: 'ownership_changed' };
  const projection = foldSupervisor(state.records);
  if (projection.kind !== 'valid' || projection.state.kind === 'absent')
    return { kind: 'refused', reason: 'missing_identity' };
  const intent = projection.state.kind === 'unconfirmed' ? projection.state.pending.intent : projection.state.intent;
  if (!intent.daemon) return { kind: 'refused', reason: 'missing_identity' };
  const epoch = state.ownership.kind === 'cleanup' ? state.ownership.previousEpoch : state.ownership.epoch;
  if (epoch.toString() !== intent.epoch || (state.ownership.kind === 'cleanup'
    && state.ownership.supervisor !== intent.supervisor)) return { kind: 'refused', reason: 'ownership_changed' };
  return { kind: 'target', target: Object.freeze({ execution: state.enrollment.execution,
    epoch, supervisor: intent.supervisor }) as CleanupTarget };
}
