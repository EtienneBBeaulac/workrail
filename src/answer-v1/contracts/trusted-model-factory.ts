import type { SessionJournal } from '../journal.js';
import type { DeliveryRef, OwnerFence } from './invocation-contract.js';
import type { ModelInferenceBoundary } from './host-composition.js';

export type ModelBindingRefusal =
  | 'storage_unavailable' | 'stale_owner' | 'missing_policy'
  | 'invalid_policy' | 'credential_mismatch' | 'missing_credentials'
  | 'unsupported_region' | 'unsupported_call_timeout' | 'unsupported_stall_timeout'
  | 'unsupported_workspace_tool' | 'duplicate_tool_name';
export type BindDeliveryModelResult =
  | Readonly<{ kind: 'created'; model: ModelInferenceBoundary }>
  | Readonly<{ kind: 'refused'; reason: ModelBindingRefusal }>;

/** Privileged host composition, never an agent tool or serialized model input.
 * The factory runs only after delivery persistence is acknowledged. Its returned
 * model retains the prompt-only interface; canonical replay does not call it.
 * Construction must not start background work. Shared resources belong to the
 * injecting host; generate owns and settles its per-call work before returning. */
export interface TrustedDeliveryModelFactory {
  create(context: Readonly<{ journal: SessionJournal; delivery: DeliveryRef; owner: OwnerFence }>,
    signal: AbortSignal): Promise<BindDeliveryModelResult>;
}
