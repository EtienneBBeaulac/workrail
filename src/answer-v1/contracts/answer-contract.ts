/** Agent-facing values and capabilities shared by host and worker boundaries. */
declare const replyBrand: unique symbol;
declare const readBrand: unique symbol;
declare const recoveryBrand: unique symbol;
declare const gateBrand: unique symbol;
declare const receiptBrand: unique symbol;
declare const approvalBrand: unique symbol;
declare const findingBrand: unique symbol;
declare const chunkBrand: unique symbol;
declare const cursorBrand: unique symbol;
declare const openAttemptBrand: unique symbol;
export type ReplyRef = string & { readonly [replyBrand]: never };
export type ReadRef = string & { readonly [readBrand]: never };
export type RecoveryRef = string & { readonly [recoveryBrand]: never };
export type GateRef = string & { readonly [gateBrand]: never };
export type ApprovalEvidenceRef = string & { readonly [approvalBrand]: never };
export type ReceiptRef = string & { readonly [receiptBrand]: never };
/** Bounded slice of exact stored submitted payload text, at most 4096 UTF-8 bytes. */
export type EvidenceChunk = string & { readonly [chunkBrand]: never };
/** Opaque continuation token bound to the specific read scope and receipt. */
export type EvidenceCursor = string & { readonly [cursorBrand]: never };
/** Opaque token representing an in-flight unconfirmed open attempt for safe reconciliation. */
export type OpenAttemptRef = string & { readonly [openAttemptBrand]: never };
/** Validated by the existing finding schema; original enrichment is retained separately. */
export type ValidatedFinding = Readonly<{
  severity: 'critical' | 'major' | 'minor' | 'nit';
  summary: string;
  findingCategory?: 'correctness' | 'security' | 'architecture' | 'ux' | 'performance' | 'testing' | 'style';
}> & { readonly [findingBrand]: never };
type ReviewFields = Readonly<{
  notes: string;
  verdict: 'clean' | 'minor' | 'blocking';
  confidence: 'high' | 'medium' | 'low';
  findings: readonly ValidatedFinding[];
  summary: string;
}>;
type AtLeastOne<T> = { [K in keyof T]: Readonly<Required<Pick<T, K>> & Partial<Omit<T, K>>> }[keyof T];
export type DomainAnswer =
  | { readonly kind: 'notes'; readonly notes: string }
  | { readonly kind: 'review'; readonly fields: AtLeastOne<ReviewFields> };
// kind is selected by the reply binding after validation, not copied by the agent.
export type QuestionIssue =
  | Readonly<{ kind: 'field'; field: keyof ReviewFields; reason: string }>
  | Readonly<{ kind: 'gate'; rationale: string }>;
export type EvidenceSummary = Readonly<{ receipt: ReceiptRef; description: string }>;
export type WorkView =
  | Readonly<{ kind: 'question'; read: ReadRef; reply: ReplyRef; instruction: string;
      retained: readonly EvidenceSummary[]; issues: readonly QuestionIssue[] }>
  | Readonly<{ kind: 'waiting'; read: ReadRef; reason: 'approval' | 'external_evidence';
      retained: readonly EvidenceSummary[] }>
  | Readonly<{ kind: 'reconciling'; read: ReadRef; description: string; continuation: 'advance_after_confirmation' | 'stop_after_confirmation';
      retained: readonly EvidenceSummary[] }>
  | Readonly<{ kind: 'finished'; read: ReadRef;
      execution: Readonly<{ kind: 'completed' }> | Readonly<{ kind: 'incomplete'; reason: 'cancelled' | 'gate_rejected' | 'timeout' | 'failed'; detail: string }>;
      taskOutcome: 'success' | 'failure' | 'partial' | 'unknown';
      retained: readonly EvidenceSummary[] }>;
type WithoutReply<T> = T extends { readonly kind: 'question' } ? Omit<T, 'reply'> : T;
/** Omission alone allows structural assignment of a wider worker value.
 * Forbid authority fields explicitly; runtime serialization must also enforce this. */
type NoWorkerAuthority = Readonly<{ reply?: never; recovery?: never; attempt?: never }>;
export type InspectionView = WithoutReply<WorkView> & NoWorkerAuthority;
export type OpenRefusedReason =
  | 'storage_unavailable'
  | 'initialization_failed';

export type OpenResult =
  | Readonly<{ kind: 'opened'; recovery: RecoveryRef; view: WorkView }>
  | Readonly<{ kind: 'refused'; reason: OpenRefusedReason; detail: string }>
  | Readonly<{ kind: 'unsupported_workflow'; message: string }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain'; attempt: OpenAttemptRef }>;

/** Reconciliation retains the caller's original attempt. Uncertainty cannot issue a replacement. */
export type OpenReconcileResult =
  | Exclude<OpenResult, { readonly kind: 'unconfirmed' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain'; attempt?: never }>
  | Readonly<{ kind: 'invalid_attempt' }>;

/** Request to open an unbound session. Mode is fixed (unbound); callers cannot select mode or supply idempotency IDs or owner tokens. */
export type UnboundWorkRequest = Readonly<{
  workflowId: string;
  workspacePath: string;
  goal: string;
  enrollmentMode?: never;
  owner?: never;
  fence?: never;
  idempotencyId?: never;
  attempt?: never;
}>;

/** Opens a NEW logical unbound session, not a content-addressed deduplication by goal.
 * An unconfirmed result's attempt authenticates the canonical original request and one
 * enrollment identity. reconcileOpen must reuse that identity without allocating another.
 * Loss of the entire initial reply before its attempt reaches the trusted transport is
 * not covered by this port; the transport must retain its own operation correlation. */
export interface UnboundSessionOpener {
  open(request: UnboundWorkRequest, signal: AbortSignal): Promise<OpenResult>;
}
export type AnswerResult =
  | Readonly<{ kind: 'recorded'; receipt: ReceiptRef; disposition: 'accepted' | 'partial' | 'rejected'; view: WorkView }>
  | Readonly<{ kind: 'replay'; receipt: ReceiptRef; original: InspectionView }>
  | Readonly<{ kind: 'conflict'; original: ReceiptRef; current: InspectionView }>
  | Readonly<{ kind: 'not_retained'; reason: 'invalid_reference' | 'capture_limit' | 'unavailable_storage' | 'stale_reference' | 'session_terminated' | 'bound_session_required' }>;

/** Chunked evidence retrieval over exact stored canonical submitted JSON without writable capabilities. */
type EvidencePage = Readonly<{ receipt: ReceiptRef; disposition: 'accepted' | 'partial' | 'rejected';
  encoding: 'canonical_json' | 'raw_utf8'; chunk: EvidenceChunk }>;
type EvidenceReadPayload =
  | (EvidencePage & Readonly<{ kind: 'complete' }>)
  | (EvidencePage & Readonly<{ kind: 'more'; next: EvidenceCursor }>)
  | Readonly<{ kind: 'refused'; reason: 'invalid_scope' | 'corrupt' | 'storage_unavailable' | 'bound_session_required' }>;
export type EvidenceReadResult = EvidenceReadPayload & NoWorkerAuthority;

/** A lost acknowledgement may follow a durable write; retry uses the original reply. */
export type WorkerSubmissionResult = AnswerResult | Readonly<{kind:'unconfirmed';reason:'commit_uncertain'}>;

/** Unbound MCP sessions only. Calls on host-bound sessions return not_retained with reason 'bound_session_required'. */
export interface WorkerPort {
  answer(reply: ReplyRef, answer: DomainAnswer, signal: AbortSignal): Promise<WorkerSubmissionResult>;
}

/** Unbound MCP inspector only. Bound enrollments refuse here. */
export interface InspectorPort {
  readonly scope: 'unbound';
  inspect(read: ReadRef, signal: AbortSignal): Promise<InspectionView | Readonly<{ kind: 'unavailable'; reason: string }>>;
  inspectReceipt(read: ReadRef, receipt: ReceiptRef, signal: AbortSignal, cursor?: EvidenceCursor): Promise<EvidenceReadResult>;
}

/** Host-bound inspector where trusted injected context fixes task identity. No caller-supplied task ID.
 * Runtime validates read+receipt against the injected task; possession of another task's refs refuses. */
export interface HostInspectorPort {
  readonly scope: 'host_bound';
  inspect(read: ReadRef, signal: AbortSignal): Promise<InspectionView | Readonly<{ kind: 'unavailable'; reason: string }>>;
  inspectReceipt(read: ReadRef, receipt: ReceiptRef, signal: AbortSignal, cursor?: EvidenceCursor): Promise<EvidenceReadResult>;
}

/** Issued only to an authorized worker/host; inspection cannot acquire this capability. */
export interface RecoveryPort {
  recover(recovery: RecoveryRef, signal: AbortSignal): Promise<WorkView | Readonly<{ kind: 'unavailable'; reason: string }>>;
  /** Reconciles an uncertain enrollment attempt using its typed attempt reference. */
  reconcileOpen(attempt: OpenAttemptRef, signal: AbortSignal): Promise<OpenReconcileResult>;
}
export type GateDecision =
  | Readonly<{ kind: 'approved'; evidence: ApprovalEvidenceRef }>
  | Readonly<{ kind: 'rejected'; rationale: string }>
  | Readonly<{ kind: 'uncertain'; rationale: string }>;
export type ResolutionResult =
  | Readonly<{ kind: 'recorded'; receipt: ReceiptRef; view: InspectionView }>
  | Readonly<{ kind: 'replay'; receipt: ReceiptRef; original: InspectionView }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_authority' | 'stale_revision' | 'conflicting_decision' | 'unavailable_storage' | 'session_terminated' }>;
export interface ResolverPort {
  resolve(gate: GateRef, decision: GateDecision, signal: AbortSignal): Promise<ResolutionResult>;
}
