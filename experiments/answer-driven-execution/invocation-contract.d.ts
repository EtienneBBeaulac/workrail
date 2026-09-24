/** Design-only ports. Brands prevent caller confusion, not runtime forgery. */
import type { AnswerResult, DomainAnswer, ReplyRef, RecoveryRef, WorkView, ReceiptRef } from './answer-contract.js';
declare const executionBrand: unique symbol;
declare const deliveryBrand: unique symbol;
declare const responseBrand: unique symbol;
declare const invocationBrand: unique symbol;
declare const capturedBrand: unique symbol;
declare const enrollmentBrand: unique symbol;
declare const preparedBrand: unique symbol;
declare const fenceBrand: unique symbol;
export type ExecutionRef = string & { readonly [executionBrand]: never };
export type DeliveryRef = string & { readonly [deliveryBrand]: never };
export type ResponseRef = string & { readonly [responseBrand]: never };
export type InvocationRef = string & { readonly [invocationBrand]: never };
export type OwnerFence = Readonly<{ execution: ExecutionRef; epoch: bigint; [fenceBrand]: never }>;
export type HostEnrollment = Readonly<{ execution: ExecutionRef; recovery: RecoveryRef; [enrollmentBrand]: never }>;

/** Points to the complete immutable response persisted by trusted capture, before selection. */
export type CapturedResponse = Readonly<{
  execution: ExecutionRef; delivery: DeliveryRef; response: ResponseRef; [capturedBrand]: never;
}>;
export type SelectedInvocation = Readonly<{
  invocation: InvocationRef; execution: ExecutionRef; delivery: DeliveryRef;
  response: ResponseRef; toolCallId: string; reply: ReplyRef; answer: DomainAnswer;
}>;
/** Issued only after the authoritative binding commit is confirmed. */
export type PreparedAnswer = SelectedInvocation & { readonly [preparedBrand]: never };

export type AcquireOwnerResult =
  | Readonly<{ kind: 'acquired'; owner: OwnerFence }>
  | Readonly<{ kind: 'refused'; reason: 'session_terminated' | 'storage_unavailable' | 'ownership_changed' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

export type OwnershipSnapshot =
  | Readonly<{ kind: 'unowned' }>
  | Readonly<{ kind: 'owned'; owner: OwnerFence }>;
/** Trusted scheduler only. readOwner reconciles uncertain acquisition; acquireOwner compares
 * expected ownership atomically. Neither operation is exposed to the worker executor. */
export interface ExecutionOwnerPort {
  readOwner(enrollment: HostEnrollment, signal: AbortSignal): Promise<OwnershipSnapshot |
    Readonly<{ kind: 'unavailable'; reason: 'missing' | 'corrupt' | 'unsupported_version' | 'storage_unavailable' }>>;
  acquireOwner(enrollment: HostEnrollment, expected: OwnershipSnapshot, signal: AbortSignal): Promise<AcquireOwnerResult>;
}

export type AppendDeliveryResult =
  | Readonly<{ kind: 'delivered'; delivery: DeliveryRef }>
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'refused'; reason: 'stopped' | 'stale_reply' | 'storage_unavailable' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

export type RedeliverResult =
  | Readonly<{ kind: 'delivered'; delivery: DeliveryRef }>
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'refused'; reason: 'already_captured' | 'stopped' | 'stale_reply' | 'storage_unavailable' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** Model tool call at the raw capture boundary before validation or selection. */
export type RawToolCall = Readonly<{
  id: string;
  name: string;
  argumentsJson: string;
}>;

/** Raw model completion payload captured before journal-owned response selection. */
export type RawModelResponse = Readonly<{
  providerResponseId?: string;
  responseText: string;
  calls: readonly RawToolCall[];
}>;

export type CaptureResult =
  | Readonly<{ kind: 'captured'; response: CapturedResponse }>
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'refused'; reason: 'stopped' | 'invalid_delivery' | 'conflict' | 'duplicate_tool_call_ids' | 'payload_too_large' | 'storage_unavailable' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

export type TerminalReason = 'cancelled' | 'gate_rejected' | 'timeout' | 'failed';

export type CommitStopResult =
  | Readonly<{ kind: 'stopped'; execution: ExecutionRef }>
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'refused'; reason: 'already_finished' | 'storage_unavailable' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

export type PrepareResult =
  | Readonly<{ kind: 'prepared'; answer: PreparedAnswer }>
  | Readonly<{ kind: 'rejected'; receipt: ReceiptRef; view: WorkView }>
  | Readonly<{ kind: 'refused'; reason: 'conflict' | 'stale_owner' | 'stopped' | 'invalid_delivery' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'storage_unavailable' | 'commit_uncertain' }>;

export type RecoveryResult =
  | Readonly<{ kind: 'replay'; answer: PreparedAnswer }>
  | Readonly<{ kind: 'prepare_response'; response: CapturedResponse }>
  | Readonly<{ kind: 'reconciling'; invocation: InvocationRef; reason: 'commit_uncertain' | 'storage_unavailable' }>
  | Readonly<{ kind: 'deliver'; view: Extract<WorkView, { kind: 'question' }> }>
  | Readonly<{ kind: 'redeliver'; oldDelivery: DeliveryRef; view: Extract<WorkView, { kind: 'question' }> }>
  | Readonly<{ kind: 'settled'; result: AnswerResult; view: WorkView }>
  | Readonly<{ kind: 'refused'; reason: 'missing' | 'corrupt' | 'unsupported_version' | 'storage_unavailable' | 'stale_owner' | 'stopped' }>;

export interface InvocationJournal {
  appendDelivery(reply: ReplyRef, owner: OwnerFence, signal: AbortSignal): Promise<AppendDeliveryResult>;
  redeliver(oldDelivery: DeliveryRef, reply: ReplyRef, owner: OwnerFence, signal: AbortSignal): Promise<RedeliverResult>;
  /** Exact recapture returns the original reference; changed captured response conflicts without replacement. */
  captureResponse(delivery: DeliveryRef, response: RawModelResponse, owner: OwnerFence, signal: AbortSignal): Promise<CaptureResult>;
  prepare(response: CapturedResponse, owner: OwnerFence, signal: AbortSignal): Promise<PrepareResult>;
  commitStop(owner: OwnerFence, reason: TerminalReason, detail: string, signal: AbortSignal): Promise<CommitStopResult>;
  /** Repeated recovery rechecks authoritative commit state; reconciling grants no dispatch/inference. */
  recover(enrollment: HostEnrollment, owner: OwnerFence, signal: AbortSignal): Promise<RecoveryResult>;
}

export type FencedCommitResult =
  | AnswerResult
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'commit_uncertain'; invocation: InvocationRef }>;

/** Required transaction boundary for host-bound sessions in the engine, not a host-only precheck. */
export interface FencedAnswerCommitter {
  commit(answer: PreparedAnswer, owner: OwnerFence, signal: AbortSignal): Promise<FencedCommitResult>;
}

export type DispatchResult =
  | AnswerResult
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'dispatch_unconfirmed'; invocation: InvocationRef }>;

/** Host dispatcher coordinating transport to FencedAnswerCommitter and classifying transport uncertainty. */
export interface BoundAnswerDispatcher {
  dispatch(answer: PreparedAnswer, owner: OwnerFence, signal: AbortSignal): Promise<DispatchResult>;
}

/** Worker executor deliberately cannot acquire ownership or inspect another task. */
export type HostExecutorPorts = Readonly<{
  journal: InvocationJournal;
  dispatcher: BoundAnswerDispatcher;
  inspector: import('./answer-contract.js').HostInspectorPort;
}>;
