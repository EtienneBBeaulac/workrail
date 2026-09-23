/** Design-only admission for automatic discovery; no candidate runtime exists. */
import type { RecoverHostSessionResult } from './host-composition.js';
type NoExecutionAuthority = Readonly<{ owner?: never; enrollment?: never; runner?: never }>;
export type ClaimUnownedResult =
  | Extract<RecoverHostSessionResult, { kind: 'ready' }>
  | (Exclude<RecoverHostSessionResult, { kind: 'ready' }> & NoExecutionAuthority)
  | (Readonly<{ kind: 'busy'; detail: string }> & NoExecutionAuthority);

/** Validate canonical pointer, terminal state, capability and ownership under the
 * same session transaction. Only confirmed unowned work can acquire a new monotonic
 * fence. Concurrent claims have one ready winner; others are busy, including repeat
 * claims by that winner's automatic loop. Busy/refused/terminal results do not write
 * ownership, mint a runner or invoke the model. Unknown ownership is not unowned.
 * Unconfirmed grants no authority and may require trusted reconciliation; never
 * turn it into permission for blind forced replacement. No caller-generated IDs.
 * The port is intentionally narrower than the privileged scheduler recover method.
 */
export interface AutomaticRecoveryPort {
  readonly conditionalRecovery?: never;
  readonly replaceIfCurrent?: never;
  readonly recover?: never;
  readonly releaseOwnership?: never;
  claimUnowned(rawPointer: unknown, signal: AbortSignal): Promise<ClaimUnownedResult>;
}
