/** Design-only trusted replacement; no process death detector or runtime exists. */
import type { OwnerFence } from './invocation-contract.js';
import type { RecoverHostSessionResult } from './host-composition.js';
type NoExecutionAuthority = Readonly<{ owner?: never; enrollment?: never; runner?: never }>;
export type ConditionalRecoveryResult =
  | Extract<RecoverHostSessionResult, { kind: 'ready' }>
  | (Exclude<RecoverHostSessionResult, { kind: 'ready' }> & NoExecutionAuthority);

/** Trusted host policy authorizes replacement separately from owner comparison.
 * Under the canonical session transaction, validate the pointer, expected fence's
 * execution association, terminal state, capabilities and current ownership. A
 * ready result replaces only that exact execution/epoch, never a refreshed fence.
 * Stale, foreign or now-unowned expectations refuse ownership_changed with no
 * writes, inference or authority. Concurrent matches have at most one ready result.
 * Duplicate/delayed calls do not regain authority. Terminal results are read-only.
 * Unconfirmed writes grant no runner; caller must reconcile, not force a retry.
 * Expected ownership is not evidence of death or an authorization credential.
 * This port cannot release owners or fall back to unconditional recovery.
 */
export interface ConditionalRecoveryPort {
  readonly recover?: never;
  readonly releaseOwnership?: never;
  replaceIfCurrent(rawPointer: unknown, expected: OwnerFence, signal: AbortSignal): Promise<ConditionalRecoveryResult>;
}
