import type { WorkspaceFailure } from './workspace-effect-contract.js';
import type { TrustedDeliveryModelFactory, ModelBindingRefusal } from './trusted-model-factory.js';
import type { ModelCallFailure } from './model-call-contract.js';
import type { DaemonExecutionPolicy } from '../../v2/durable-core/schemas/session/daemon-policy.js';
import type { ConditionalRecoveryPort } from './conditional-recovery-contract.js';
import type { AutomaticRecoveryPort } from './automatic-recovery-contract.js';
/** Host composition ports. Brands prevent caller confusion, not runtime forgery. */
import type {
  EvidenceSummary, HostInspectorPort, InspectorPort, OpenAttemptRef, OpenResult,
  QuestionIssue, ReceiptRef, RecoveryPort, RecoveryRef, ReplyRef, ReadRef,
  UnboundSessionOpener, UnboundWorkRequest, WorkerPort, WorkView,
} from './answer-contract.js';
import type {
  BoundAnswerDispatcher, CapturedResponse, DeliveryRef, ExecutionOwnerPort,
  ExecutionRef, FencedAnswerCommitter, HostEnrollment, HostExecutorPorts,
  InvocationJournal, InvocationRef, OwnerFence, PreparedAnswer, RawModelResponse,
  RecoveryResult, ResponseRef, TerminalReason,
} from './invocation-contract.js';

/** Untrusted serialized enrollment locator and format version; no leases or fences. */
export type PersistedHostPointer = Readonly<{
  formatVersion: 1;
  executionId: string;
  recoveryLocator: string;
  owner?: never; fence?: never; epoch?: never; lease?: never;
}>;

export type HydrateEnrollmentResult =
  | Readonly<{ kind: 'hydrated'; enrollment: HostEnrollment }>
  | Readonly<{ kind: 'refused'; reason: 'missing' | 'corrupt' | 'unsupported_version' | 'storage_unavailable'; detail: string }>;

/** Validates untrusted raw input at the system boundary without cast. */
export interface HostEnrollmentHydrator {
  hydrate(rawInput: unknown, signal: AbortSignal): Promise<HydrateEnrollmentResult>;
  dehydrate(enrollment: HostEnrollment): PersistedHostPointer;
}

export type HostJournalStorageConfig = Readonly<{
  /** Canonical session-journal root used by BOTH engine and host records, not a companion store. */
  journalRootDir: string;
  hostIndexRootDir: string;
}>;

/** Shared authoritative configuration consumed by both host scheduler and worker composition. */
export type SharedAuthorityConfig = Readonly<{
  storage: HostJournalStorageConfig;
  keyringPath: string;
  workflowStoragePath: string;
}>;

export type EngineEnrollResult =
  | Readonly<{ kind: 'enrolled'; enrollment: HostEnrollment; initialView: WorkView }>
  | Readonly<{ kind: 'refused'; reason: 'unsupported_workflow' | 'unsupported_execution_policy' | 'storage_unavailable' | 'initialization_failed'; detail: string }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** Request to enroll a host session. Mode is fixed (host_bound); callers cannot select mode or supply idempotency IDs or owner tokens. */
export type HostWorkRequest = Readonly<{
  workflowId: string;
  goal: string;
  workspacePath: string;
  daemonPolicy?: DaemonExecutionPolicy;
  enrollmentMode?: never;
  owner?: never;
  fence?: never;
  idempotencyId?: never;
  attempt?: never;
}>;

/** Authoritative engine boundary; canonical execution identity and fence checked at shared transaction. */
export type HostRecoveryStatus =
  | Readonly<{ kind: 'active' }>
  | Readonly<{ kind: 'stopped'; execution: ExecutionRef; reason: TerminalReason; detail: string; read: ReadRef }>
  | Readonly<{ kind: 'settled'; receipt: ReceiptRef; view: Extract<WorkView, { kind: 'finished' }> }>
  | Readonly<{ kind: 'unavailable'; reason: 'missing' | 'corrupt' | 'unsupported_version' | 'storage_unavailable' }>;

export interface AuthoritativeEngineBoundary {
  readonly committer: FencedAnswerCommitter;
  readStatus(enrollment: HostEnrollment, signal: AbortSignal): Promise<HostRecoveryStatus>;
  bindInspector(enrollment: HostEnrollment): HostInspectorPort;
  /** These operations share the same authority store/transaction rules as committer. */
  readonly journal: InvocationJournal;
  readonly ownerPort: ExecutionOwnerPort;
  enrollSession(pointer: PersistedHostPointer, request: HostWorkRequest, signal: AbortSignal): Promise<EngineEnrollResult>;
}

export type ModelPromptInput = Readonly<{
  instruction: string;
  issues: readonly QuestionIssue[];
  retainedSummaries: readonly EvidenceSummary[];
  reply?: never; recovery?: never; owner?: never; attempt?: never;
}>;

export type ModelCompletionResult =
  | Readonly<{kind:'workspace_failed'; failure:WorkspaceFailure}>
  | Readonly<{ kind: 'call_failed'; failure: ModelCallFailure }>
  | Readonly<{ kind: 'completed'; response: RawModelResponse }>
  | Readonly<{ kind: 'unavailable'; detail: string }>
  | Readonly<{ kind: 'cancelled' }>;
export interface ModelInferenceBoundary {
  generate(input: ModelPromptInput, signal: AbortSignal): Promise<ModelCompletionResult>;
}

export type JournalFaultBoundary =
  | 'before_effect_intent_append' | 'after_effect_intent_append'
  | 'before_effect_outcome_append' | 'after_effect_outcome_append'
  | 'before_model_call_append' | 'after_model_call_append'
  | 'before_delivery_append' | 'after_delivery_append'
  | 'before_capture_append' | 'after_capture_append'
  | 'before_prepare_commit' | 'after_prepare_commit'
  | 'before_engine_transaction' | 'after_engine_commit'
  | 'before_stop_commit' | 'after_stop_commit';

export type JournalFaultAction =
  | Readonly<{ kind: 'proceed' }>
  | Readonly<{ kind: 'fail_io'; message: string }>
  | Readonly<{ kind: 'simulate_uncertain'; message: string }>
  | Readonly<{ kind: 'pause_at_barrier'; barrierId: string }>;

/** Fault injection is an I/O-boundary test seam, never an engine-state setter.
 * after_* boundaries occur after the corresponding canonical append is durable.
 * simulate_uncertain suppresses acknowledgement; it does not undo committed truth
 * or create a WorkView.reconciling external-effect intent. */
export interface DurableJournalFaultSeam {
  intercept(boundary: JournalFaultBoundary, execution: ExecutionRef, signal: AbortSignal): Promise<JournalFaultAction>;
}

export type TurnUncertainty =
  | Readonly<{stage:'workspace_effect'; execution:ExecutionRef; delivery:DeliveryRef; failure:WorkspaceFailure}>
  | Readonly<{ stage: 'model_call'; execution: ExecutionRef; delivery: DeliveryRef; failure: Extract<ModelCallFailure, { kind: 'unconfirmed' }> }>
  | Readonly<{ stage: 'delivery'; execution: ExecutionRef; reply: ReplyRef }>
  | Readonly<{ stage: 'capture'; execution: ExecutionRef; delivery: DeliveryRef }>
  | Readonly<{ stage: 'prepare'; execution: ExecutionRef; delivery: DeliveryRef; response: ResponseRef }>
  | Readonly<{ stage: 'commit_or_dispatch'; invocation: InvocationRef }>;

export type TurnOutcome =
  | Readonly<{ kind: 'refused'; reason: 'model_binding_refused'; failure: Exclude<ModelBindingRefusal, 'stale_owner' | 'storage_unavailable'>; detail: string }>
  | Readonly<{ kind: 'refused'; reason: 'model_call_refused'; failure: Extract<ModelCallFailure, { kind: 'refused' }>; detail: string }>
  | Readonly<{ kind: 'advanced'; receipt: ReceiptRef; nextView: WorkView }>
  | Readonly<{ kind: 'rejected'; receipt: ReceiptRef; correctionView: WorkView }>
  | Readonly<{ kind: 'settled'; receipt: ReceiptRef; view: WorkView }>
  | Readonly<{ kind: 'no_work_required'; view: Extract<WorkView, { kind: 'waiting' | 'finished' }> }>
  | Readonly<{ kind: 'stopped'; execution: ExecutionRef; reason: TerminalReason; detail: string }>
  | Readonly<{ kind: 'unconfirmed'; uncertainty: TurnUncertainty }>
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'refused'; reason: 'reconciliation_required' | 'delivery_refused' | 'capture_refused' | 'prepare_refused' | 'model_unavailable' | 'dispatch_refused' | 'storage_unavailable'; detail: string }>;

/** Execution-bound runner bound to validated enrollment, owner fence, and immutable dependencies. */
export interface BoundTurnRunner {
  readonly execution: ExecutionRef;
  runTurn(signal: AbortSignal): Promise<TurnOutcome>;
}

export type EnrollHostSessionResult =
  | Readonly<{ kind: 'enrolled'; enrollment: HostEnrollment; runner: BoundTurnRunner; initialView: WorkView; owner: OwnerFence }>
  | Readonly<{ kind: 'refused'; reason: 'unsupported_workflow' | 'unsupported_execution_policy' | 'storage_unavailable' | 'initialization_failed'; detail: string }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain'; pointer: PersistedHostPointer }>;

export type RecoverHostSessionResult =
  | Readonly<{ kind: 'ready'; enrollment: HostEnrollment; runner: BoundTurnRunner; owner: OwnerFence }>
  | Readonly<{ kind: 'stopped'; execution: ExecutionRef; reason: TerminalReason; detail: string; read: ReadRef }>
  | Readonly<{ kind: 'settled'; receipt: ReceiptRef; view: Extract<WorkView, { kind: 'finished' }> }>
  | Readonly<{ kind: 'refused'; reason: 'missing' | 'corrupt' | 'unsupported_version' | 'storage_unavailable' | 'stale_owner' | 'ownership_changed' | 'unsupported_execution_policy'; detail: string }>
  | Readonly<{
      kind: 'refused';
      reason: 'unsupported_capability';
      missingOutput: SupportedAnswerOutput;
      detail: string;
      runner?: never;
      enrollment?: never;
      owner?: never;
    }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** Trusted scheduler owns owner acquisition and runner binding. Diagnostics ports only here. */
export interface TrustedAnswerScheduler {
  /** Give only this port to authorized replacement callers; never to discovery. */
  readonly conditionalRecovery: ConditionalRecoveryPort;
  /** Pass only this capability to automatic discovery consumers. */
  readonly automaticRecovery: AutomaticRecoveryPort;
  readonly hydrator: HostEnrollmentHydrator;
  enroll(request: HostWorkRequest, signal: AbortSignal): Promise<EnrollHostSessionResult>;
  recover(rawPointer: unknown, signal: AbortSignal): Promise<RecoverHostSessionResult>;
  bindDiagnosticPorts(enrollment: HostEnrollment): HostExecutorPorts;
  /** Trusted production handoff: compare and release only this current fence under the
   * canonical transaction gate. Retain epoch history and pending work; do not stop it.
   * Old runners become stale. On uncertainty, the scheduler must reconcile ownership
   * internally before granting a fresh runner or confirming release. */
  releaseOwnership(enrollment: HostEnrollment, owner: OwnerFence, signal: AbortSignal): Promise<ReleaseOwnershipResult>;
  close(signal: AbortSignal): Promise<RuntimeCloseResult>;
}

export type ReleaseOwnershipResult =
  | Readonly<{ kind: 'released' }>
  | Readonly<{ kind: 'stale_owner' }>
  | Readonly<{ kind: 'refused'; reason: 'missing' | 'corrupt' | 'storage_unavailable' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** Close rejects new work, cancels/drains owned operations and releases owned resources.
 * Durable owner history may remain: scheduler recovery atomically replaces the prior
 * fence after reconciling state. close is not an ownership release or session stop.
 * An expired cancellation/deadline does not imply all operations or locks were released. */
export type RuntimeCloseResult =
  | Readonly<{ kind: 'closed' }>
  | Readonly<{ kind: 'incomplete'; reason: 'cancelled' | 'work_in_flight' | 'cleanup_failed'; detail: string }>;

export type AnswerHostConfig = SharedAuthorityConfig & Readonly<{
  faultSeam?: DurableJournalFaultSeam;
}> & (
  | Readonly<{ model: ModelInferenceBoundary; modelFactory?: never }>
  | Readonly<{ model?: never; modelFactory: TrustedDeliveryModelFactory }>
);

export type AnswerWorkerConfig = SharedAuthorityConfig;

export type CreateAnswerHostResult =
  | Readonly<{ kind: 'created'; scheduler: TrustedAnswerScheduler }>
  | Readonly<{ kind: 'refused'; reason: 'storage_unavailable' | 'unsupported_version' | 'missing_authority'; detail: string }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** Proposed entrypoint at 'src/answer-v1/host.ts'. Test runner detects absence as runtime_unavailable. */

export type CreateAnswerWorkerResult =
  | Readonly<{
      kind: 'created';
      worker: WorkerPort;
      inspector: InspectorPort;
      opener: UnboundSessionOpener;
      recovery: RecoveryPort;
      close(signal: AbortSignal): Promise<RuntimeCloseResult>;
    }>
  | Readonly<{ kind: 'refused'; reason: 'storage_unavailable' | 'unsupported_version' | 'missing_authority'; detail: string }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

/** Proposed entrypoint at 'src/answer-v1/worker.ts'. Test runner detects absence as runtime_unavailable. */

/** Proposed options for the existing production composeServer entrypoint.
 * Required when WORKRAIL_AGENT_PROFILE=answers; rejected for other profiles.
 * It constructs createAnswerWorker from these values, not an injected fake engine. */
export type AnswerMcpCompositionOptions = Readonly<{ answerAuthority: SharedAuthorityConfig }>;

/** Supported output contracts for actual candidate build capability descriptors. */
export type SupportedAnswerOutput = 'notes' | 'wr.contracts.review_verdict';

/** Minimal read-only runtime capability descriptor exported by candidate build entrypoints. */
export type RuntimeCapabilityDescriptor = Readonly<{
  enrollmentFormatVersion: 1;
  journalFormatVersion: 1;
  supportedOutputs: readonly SupportedAnswerOutput[];
}>;

/** Proposed export on candidate build entrypoint alongside createAnswerHost. */
export declare const runtimeCapabilities: RuntimeCapabilityDescriptor;
