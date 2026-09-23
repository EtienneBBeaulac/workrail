import type { V2ToolContext } from '../../mcp/types.js';
export type RuntimeCloseResult = Readonly<{ kind: 'closed' }> | Readonly<{ kind: 'incomplete'; reason: 'cancelled' | 'work_in_flight' | 'cleanup_failed'; detail: string }>;
import type { SessionId, RunId, NodeId } from '../durable-core/ids/session-ids.js';

declare const authorityBrand: unique symbol;
declare const revisionBrand: unique symbol;
declare const receiptBrand: unique symbol;

/** Privileged resolver capability issued exclusively to trusted daemon boundary. Never exposed to agents. */
export type GateAuthorityRef = string & { readonly [authorityBrand]: never };

/** Content-addressed or monotonic work revision hash binding the exact evaluated work. */
export type WorkRevisionRef = string & { readonly [revisionBrand]: never };

/** Stable receipt for an accepted gate resolution. Replayed idempotently. */
export type GateReceiptRef = string & { readonly [receiptBrand]: never };

/** Canonical durable session identifier. Reuses v2 SessionId brand. */
export type SessionIdRef = SessionId;

/** Canonical engine execution run identifier. Reuses v2 RunId brand. */
export type RunIdRef = RunId;

/** Exact gate occurrence subject. gateNodeId identifies the actual durable occurrence, including loops and forks. */
export type GateSubject = Readonly<{
  sessionId: SessionIdRef;
  runId: RunIdRef;
  stepId: string;
  gateNodeId: NodeId;
  workRevision: WorkRevisionRef;
}>;

/** Evaluator/host decision on a pending gate occurrence. */
export type GateResolutionDecision =
  | Readonly<{ kind: 'approved'; rationale: string; evidenceRef?: string }>
  | Readonly<{ kind: 'rejected'; rationale: string }>
  | Readonly<{ kind: 'uncertain'; rationale: string }>;

export type InspectPendingRefusalReason =
  | 'invalid_token'
  | 'not_pending'
  | 'missing_work'
  | 'session_cancelled'
  | 'storage_unavailable';

export type InspectPendingResult =
  | Readonly<{
      kind: 'inspected';
      authority: GateAuthorityRef;
      subject: GateSubject;
    }>
  | Readonly<{
      kind: 'refused';
      reason: InspectPendingRefusalReason;
      detail: string;
    }>;

export type GateRefusalReason =
  | 'session_busy'
  | 'invalid_authority'
  | 'stale_revision'
  | 'subject_mismatch'
  | 'conflicting_decision'
  | 'session_cancelled'
  | 'storage_unavailable';

/** Confirmed approved resolution: yields stable receipt and actual next continueToken to advance after-gate step. */
export type GateResolutionAccepted = Readonly<{
  kind: 'accepted';
  disposition: 'approved';
  receipt: GateReceiptRef;
  continueToken: string;
  subject: GateSubject;
}>;

/** Rejected resolution: terminal resolution for current revision; retains work, no forward continuation. */
export type GateResolutionHeldRejected = Readonly<{
  kind: 'held';
  disposition: 'rejected';
  continueToken?: never;
  receipt: GateReceiptRef;
  subject: GateSubject;
}>;

/** Uncertain observation: non-terminal observation; remains pending for subsequent authorized decision. */
export type GateResolutionHeldUncertain = Readonly<{
  kind: 'held';
  disposition: 'uncertain';
  continueToken?: never;
  receipt: GateReceiptRef;
  subject: GateSubject;
}>;

/** Rejected or uncertain resolution: must remain held (distinct disposition), no next continueToken.
 * Distinguishes an uncertain pending observation from a rejected resolution via minimal ADT.
 */
export type GateResolutionHeld =
  | GateResolutionHeldRejected
  | GateResolutionHeldUncertain;

/** Replay of existing resolution. Approved replay includes continueToken; held replay does not. */
export type GateResolutionReplay =
  | Readonly<{
      kind: 'replay';
      disposition: 'approved';
      receipt: GateReceiptRef;
      continueToken: string;
      subject: GateSubject;
    }>
  | Readonly<{
      kind: 'replay';
      disposition: 'rejected';
      continueToken?: never;
      receipt: GateReceiptRef;
      subject: GateSubject;
    }>
  | Readonly<{
      kind: 'replay';
      disposition: 'uncertain';
      continueToken?: never;
      receipt: GateReceiptRef;
      subject: GateSubject;
    }>;

export type GateResolutionRefused = Readonly<{
  kind: 'refused';
  reason: GateRefusalReason;
  detail: string;
}>;

export type GateResolutionUnconfirmed = Readonly<{
  kind: 'unconfirmed';
  reason: 'commit_uncertain';
}>;

export type GateResolutionResult =
  | GateResolutionAccepted
  | GateResolutionHeld
  | GateResolutionReplay
  | GateResolutionRefused
  | GateResolutionUnconfirmed;

/** Proposed effectful resolver boundary at trusted daemon layer.
 * Not exposed to worker agent tool surfaces. */
export interface TrustedGateResolverPort {
  /** Inspects actual persisted pending gate to issue authenticated authority and exact subject. */
  inspectPending(
    gateToken: string,
    signal: AbortSignal,
  ): Promise<InspectPendingResult>;

  /** Under the canonical session transaction, commit the decision and successor
   * transition before confirming approval. Replay reads that same committed record;
   * a returned token alone is not proof of advancement. */
  resolveGate(
    authority: GateAuthorityRef,
    subject: GateSubject,
    decision: GateResolutionDecision,
    signal: AbortSignal,
  ): Promise<GateResolutionResult>;

  /** Abort-aware closure releasing held resources. */
  close(signal: AbortSignal): Promise<RuntimeCloseResult>;
}

/** Explicit options binding resolver to existing V2ToolContext/store/keys.
 * Mandatory parameter; never defaults to real home data. */
export type TrustedGateResolverOptions = Readonly<{
  toolContext: V2ToolContext & { readonly v2: NonNullable<V2ToolContext['v2']> };
}>;

/** Proposed effectful factory export signature at src/daemon/trusted-gate-resolver.ts. */
export type CreateGateResolver = (
  options: TrustedGateResolverOptions,
  signal: AbortSignal,
) => Promise<TrustedGateResolverPort>;

export type CreateTrustedGateResolver = CreateGateResolver;
