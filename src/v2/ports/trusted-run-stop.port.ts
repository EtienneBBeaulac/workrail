import type { V2ToolContext } from '../../mcp/types.js';
import type { RuntimeCloseResult } from './trusted-gate-resolver.port.js';
export type { RuntimeCloseResult } from './trusted-gate-resolver.port.js';
import type { SessionId, RunId } from '../durable-core/ids/session-ids.js';

declare const stopAuthorityBrand: unique symbol;
declare const stopReceiptBrand: unique symbol;

export type RunStopAuthorityRef = string & { readonly [stopAuthorityBrand]: never };
export type RunStopReceiptRef = string & { readonly [stopReceiptBrand]: never };

export type RunSubject = Readonly<{
  sessionId: SessionId;
  runId: RunId;
  gateNodeId?: never;
  workRevision?: never;
}>;

export type InspectRunStopEligible = Readonly<{
  kind: 'eligible';
  authority: RunStopAuthorityRef;
  subject: RunSubject;
}>;

export type InspectRunStopRefusalReason =
  | 'invalid_token'
  | 'not_found'
  | 'storage_unavailable';

export type InspectRunStopRefused = Readonly<{
  kind: 'refused';
  reason: InspectRunStopRefusalReason;
  detail: string;
}>;

export type InspectRunStopResult =
  | InspectRunStopEligible
  | InspectRunStopRefused
  | Readonly<{ kind: 'already_completed'; subject: RunSubject }>
  | Readonly<{ kind: 'already_stopped'; receipt: RunStopReceiptRef; subject: RunSubject; reason: 'cancelled'; detail: string }>
  | Readonly<{ kind: 'cancelled_operation'; reason: 'operation_aborted' }>;

export type RunStopRefusalReason =
  | 'invalid_authority'
  | 'subject_mismatch'
  | 'storage_unavailable';

export type RunStopResult =
  | Readonly<{ kind: 'stopped'; receipt: RunStopReceiptRef; subject: RunSubject; reason: 'cancelled'; detail: string; continueToken?: never; authority?: never }>
  | Readonly<{ kind: 'replay'; receipt: RunStopReceiptRef; subject: RunSubject; reason: 'cancelled'; detail: string; continueToken?: never; authority?: never }>
  | Readonly<{ kind: 'already_completed'; subject: RunSubject }>
  | Readonly<{ kind: 'refused'; reason: RunStopRefusalReason; detail: string }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>
  | Readonly<{ kind: 'cancelled_operation'; reason: 'operation_aborted' }>;

export interface RunStopCommitFaultSeam {
  afterCommit(subject: RunSubject, signal: AbortSignal): Promise<'acknowledge' | 'suppress_acknowledgement'>;
}

/** Supervisor-only cancellation of one canonical engine run, not a gate revision.
 * Authenticate capability and scope before exposing history or committing. Validation
 * may read the authority store; it cannot assume authentication without that read.
 * Under the shared canonical session gate, inspect completion/stop and append exactly
 * one run_stopped event with scope.runId and data { receipt, reason: 'cancelled', detail }.
 * Replay preserves the first receipt/detail even when a later caller supplies different
 * detail. Already-completed runs are not rewritten. Inspecting a stopped run returns
 * already_stopped with history, not fresh authority. Capabilities survive recreation.
 * A later correction revision does not invalidate an issued run-stop capability.
 * Resolver inspect/resolve refuse session_cancelled; correction inspection returns
 * cancelled/session_cancelled and submission refuses session_cancelled. Ordinary
 * fresh V2 advance refuses PRECONDITION_FAILED with not_retryable and details
 * {kind:'run_stopped', subject, receipt, reason:'cancelled', detail}. All read the same
 * canonical record; no adapter-local stop flag and no synthetic host enrollment.
 * A cancelled_operation is pre-commit only. Lost acknowledgement after commit is
 * unconfirmed and the caller reconciles by repeating stop with the same capability.
 * close is not stop. Already-running I/O cancels cooperatively; completed effects
 * remain committed. This does not promise immediate process quiescence.
 */
export interface TrustedRunStopperPort {
  inspectTarget(gateToken: string, signal: AbortSignal): Promise<InspectRunStopResult>;
  stop(
    authority: RunStopAuthorityRef,
    subject: RunSubject,
    detail: string,
    signal: AbortSignal,
  ): Promise<RunStopResult>;
  close(signal: AbortSignal): Promise<RuntimeCloseResult>;
}

export type TrustedRunStopperOptions = Readonly<{
  faultSeam?: RunStopCommitFaultSeam;
  toolContext: V2ToolContext & { readonly v2: NonNullable<V2ToolContext['v2']> };
}>;

export type CreateTrustedRunStopper = (
  options: TrustedRunStopperOptions,
  signal: AbortSignal,
) => Promise<TrustedRunStopperPort>;
