import type { V2ToolContext } from '../../mcp/types.js';
import type { RuntimeCloseResult } from './trusted-gate-resolver.port.js';
export type { RuntimeCloseResult } from './trusted-gate-resolver.port.js';
import type { GateSubject, WorkRevisionRef } from './trusted-gate-resolver.port.js';
export type { GateSubject, WorkRevisionRef } from './trusted-gate-resolver.port.js';
import type {
  AssessmentArtifactV1, CodingHandoffArtifactV1, CoordinatorSignalArtifactV1,
  DifferentiationHandoffArtifactV1, DiscoveryHandoffArtifactV1, GateVerdictArtifactV1,
  LoopControlArtifactV1, ReviewVerdictArtifactV1, ShapingHandoffArtifactV1,
} from '../durable-core/schemas/artifacts/index.js';

declare const correctionAuthorityBrand: unique symbol;
declare const correctionReceiptBrand: unique symbol;

export type GateCorrectionAuthorityRef = string & { readonly [correctionAuthorityBrand]: never };
export type GateCorrectionReceiptRef = string & { readonly [correctionReceiptBrand]: never };

export type KnownGateArtifact =
  | AssessmentArtifactV1 | LoopControlArtifactV1 | CoordinatorSignalArtifactV1
  | ReviewVerdictArtifactV1 | DiscoveryHandoffArtifactV1 | GateVerdictArtifactV1
  | ShapingHandoffArtifactV1 | CodingHandoffArtifactV1 | DifferentiationHandoffArtifactV1;

export type GateCorrectionOutput =
  | Readonly<{
      kind: 'notes'; notesMarkdown: string; artifacts?: never;
      context?: never; revision?: never; workerAuthority?: never; authority?: never;
    }>
  | Readonly<{
      kind: 'artifacts'; artifacts: readonly [KnownGateArtifact, ...KnownGateArtifact[]]; notesMarkdown?: string;
      context?: never; revision?: never; workerAuthority?: never; authority?: never;
    }>;

export type InspectCorrectionEligible = Readonly<{
  kind: 'eligible';
  authority: GateCorrectionAuthorityRef;
  subject: GateSubject;
  priorDisposition: 'pending' | 'uncertain' | 'rejected';
}>;

export type InspectCorrectionRefusalReason =
  | 'already_approved' | 'session_completed' | 'stale_subject'
  | 'stale_revision' | 'invalid_token' | 'not_found' | 'storage_unavailable';

export type InspectCorrectionRefused = Readonly<{ kind: 'refused'; reason: InspectCorrectionRefusalReason; detail: string }>;
export type InspectCorrectionCancelled = Readonly<{ kind: 'cancelled'; reason: 'session_cancelled' | 'operation_aborted' }>;

export type InspectCorrectionResult =
  | InspectCorrectionEligible
  | InspectCorrectionRefused
  | InspectCorrectionCancelled;

export type CorrectionRefusalReason =
  | 'invalid_authority' | 'ineligible_gate_state' | 'stale_subject' | 'stale_revision'
  | 'conflicting_correction' | 'validation_failed' | 'session_cancelled' | 'storage_unavailable';

export type GateCorrectionAccepted = Readonly<{
  kind: 'accepted';
  receipt: GateCorrectionReceiptRef;
  reviewGateToken: string;
  priorSubject: GateSubject;
  newSubject: GateSubject;
  continueToken?: never;
  authority?: never;
}>;

export type GateCorrectionReplay = Readonly<{
  kind: 'replay';
  receipt: GateCorrectionReceiptRef;
  reviewGateToken: string;
  priorSubject: GateSubject;
  newSubject: GateSubject;
  continueToken?: never;
  authority?: never;
}>;

export type GateCorrectionRefused = Readonly<{ kind: 'refused'; reason: CorrectionRefusalReason; detail: string }>;
export type GateCorrectionUnconfirmed = Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;
export type GateCorrectionCancelled = Readonly<{ kind: 'cancelled'; reason: 'session_cancelled' | 'operation_aborted' }>;

export type GateCorrectionResult =
  | GateCorrectionAccepted
  | GateCorrectionReplay
  | GateCorrectionRefused
  | GateCorrectionUnconfirmed
  | GateCorrectionCancelled;

/** Trusted supervisor-only port, never exposed to an evaluator or ordinary worker.
 * Eligible targets are current pending/uncertain/rejected subjects. Approval,
 * completion and stop forbid new correction. Validate against the pinned step.
 * Validation failure changes neither journals nor snapshots.
 * Under one canonical transaction recheck authority, current subject and eligibility,
 * then retain corrected output on the new gate occurrence, and the stable receipt.
 * Readers select that occurrence rather than treating the first historical artifact
 * as the corrected verdict. Prior occurrences keep their original output.
 * WorkRevisionRef is derived from canonical structured session/run/occurrence,
 * pinned workflow identity and retained evaluated outputs, not caller text.
 * Old output and decisions remain immutable. No successor executes on correction.
 * Exactly one correction can consume a base subject. Identical validated output
 * replays its original receipt, even after later resolution; different output
 * conflicts. Replay is checked before current-state refusal after authenticating
 * authority, survives factory recreation, and grants no new execution authority.
 * On lost acknowledgement resubmit the same authority/base/output. If commit may
 * have occurred return unconfirmed, never a cancellation implying no effect.
 * reviewGateToken is for resolver inspection of newSubject; old subject resolution
 * refuses stale_revision. A replayed token cannot revive a stopped/completed gate.
 */
export interface TrustedGateCorrectorPort {
  inspectCorrectionTarget(gateToken: string, signal: AbortSignal): Promise<InspectCorrectionResult>;
  submitCorrection(
    authority: GateCorrectionAuthorityRef, subject: GateSubject, output: GateCorrectionOutput, signal: AbortSignal,
  ): Promise<GateCorrectionResult>;
  close(signal: AbortSignal): Promise<RuntimeCloseResult>;
}

/** Test-only acknowledgement fault at the I/O boundary, after the correction's
 * canonical transaction is durable. subject is the new corrected subject.
 * It cannot mutate engine state. Suppression
 * returns unconfirmed; replay reads the committed receipt without re-firing it. */
export interface GateCorrectionCommitFaultSeam {
  afterCommit(subject: GateSubject, signal: AbortSignal): Promise<'acknowledge' | 'suppress_acknowledgement'>;
}

export type TrustedGateCorrectorOptions = Readonly<{
  faultSeam?: GateCorrectionCommitFaultSeam;
  toolContext: V2ToolContext & { readonly v2: NonNullable<V2ToolContext['v2']> };
}>;

export type CreateTrustedGateCorrector = (options: TrustedGateCorrectorOptions, signal: AbortSignal) => Promise<TrustedGateCorrectorPort>;
export type CreateGateCorrector = CreateTrustedGateCorrector;
