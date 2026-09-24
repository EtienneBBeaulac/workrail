/** Read-only contract for console answer-driven execution read projections.
 * Read capability contracts; no execution or model authority.
 */
import type {
  InspectionView,
  EvidenceReadResult,
  ReceiptRef,
  EvidenceCursor,
  EvidenceChunk,
} from './answer-contract.js';
import type { SessionId } from '../../v2/durable-core/ids/index.js';

export type ConsoleAnswerUnavailableReason =
  | 'missing'
  | 'corrupt'
  | 'unsupported_version'
  | 'storage_unavailable'
  | 'profile_disabled';

export type ConsoleAnswerNotEnrolledReason =
  | 'legacy_workflow'
  | 'not_enrolled';

export type ConsoleAnswerRefusedReason =
  | 'bound_session_required'
  | 'invalid_scope';

/** Tagged outcome representing the read result of a session answer inspection. */
export type ConsoleAnswerOutcome =
  | Readonly<{
      kind: 'loaded';
      sessionId: SessionId;
      view: InspectionView;
      reply?: never;
      recovery?: never;
    }>
  | Readonly<{
      kind: 'unavailable';
      sessionId: SessionId;
      reason: ConsoleAnswerUnavailableReason;
      detail?: string;
      reply?: never;
      recovery?: never;
    }>
  | Readonly<{
      kind: 'not_enrolled';
      sessionId: SessionId;
      reason: ConsoleAnswerNotEnrolledReason;
      reply?: never;
      recovery?: never;
    }>
  | Readonly<{
      kind: 'refused';
      sessionId: SessionId;
      reason: ConsoleAnswerRefusedReason;
      detail?: string;
      reply?: never;
      recovery?: never;
    }>;

/** Successful bounded chunk page from evidence reading. */
export type ConsoleReceiptPage = EvidenceReadResult &
  (Readonly<{ kind: 'complete' }> | Readonly<{ kind: 'more' }>) & {
    readonly reply?: never;
    readonly recovery?: never;
  };

/** Tagged outcome representing the read result of an exact evidence receipt. */
export type ConsoleReceiptOutcome =
  | Readonly<{
      kind: 'loaded';
      sessionId: SessionId;
      receipt: ReceiptRef;
      page: ConsoleReceiptPage;
      reply?: never;
      recovery?: never;
    }>
  | Readonly<{
      kind: 'unavailable';
      sessionId: SessionId;
      receipt: ReceiptRef;
      reason: ConsoleAnswerUnavailableReason;
      detail?: string;
      reply?: never;
      recovery?: never;
    }>
  | Readonly<{
      kind: 'not_enrolled';
      sessionId: SessionId;
      reason: ConsoleAnswerNotEnrolledReason;
      reply?: never;
      recovery?: never;
    }>
  | Readonly<{
      kind: 'refused';
      sessionId: SessionId;
      receipt: ReceiptRef;
      reason: ConsoleAnswerRefusedReason;
      detail?: string;
      reply?: never;
      recovery?: never;
    }>;

/** HTTP response DTO for GET /api/v2/sessions/:sessionId/answer */
export type ConsoleAnswerSuccessDTO = Readonly<{
  success: true;
  data: Readonly<{
    sessionId: SessionId;
    view: InspectionView;
    reply?: never;
    recovery?: never;
  }>;
  reply?: never;
  recovery?: never;
}>;

export type ConsoleAnswerFailureDTO = Readonly<{
  success: false;
  error: string;
  outcome:
    | Readonly<{ kind: 'unavailable'; sessionId: SessionId; reason: ConsoleAnswerUnavailableReason; detail?: string; reply?: never; recovery?: never }>
    | Readonly<{ kind: 'not_enrolled'; sessionId: SessionId; reason: ConsoleAnswerNotEnrolledReason; reply?: never; recovery?: never }>
    | Readonly<{ kind: 'refused'; sessionId: SessionId; reason: ConsoleAnswerRefusedReason; detail?: string; reply?: never; recovery?: never }>;
  reply?: never;
  recovery?: never;
}>;

export type ConsoleAnswerResponseDTO = ConsoleAnswerSuccessDTO | ConsoleAnswerFailureDTO;

/** HTTP response DTO for GET /api/v2/sessions/:sessionId/answer/receipts/:receipt */
export type ConsoleReceiptSuccessDTO = Readonly<{
  success: true;
  data: Readonly<{
    sessionId: SessionId;
    receipt: ReceiptRef;
    page: ConsoleReceiptPage;
    reply?: never;
    recovery?: never;
  }>;
  reply?: never;
  recovery?: never;
}>;

export type ConsoleReceiptFailureDTO = Readonly<{
  success: false;
  error: string;
  outcome:
    | Readonly<{ kind: 'unavailable'; sessionId: SessionId; receipt: ReceiptRef; reason: ConsoleAnswerUnavailableReason; detail?: string; reply?: never; recovery?: never }>
    | Readonly<{ kind: 'not_enrolled'; sessionId: SessionId; reason: ConsoleAnswerNotEnrolledReason; reply?: never; recovery?: never }>
    | Readonly<{ kind: 'refused'; sessionId: SessionId; receipt: ReceiptRef; reason: ConsoleAnswerRefusedReason; detail?: string; reply?: never; recovery?: never }>;
  reply?: never;
  recovery?: never;
}>;

export type ConsoleReceiptResponseDTO = ConsoleReceiptSuccessDTO | ConsoleReceiptFailureDTO;

/** Unbound console reader capability (first profile). SessionId is a selector, not authority.
 * Bound sessions must refuse unless a trusted scoped host inspector is injected.
 */
export interface ConsoleSessionAnswerReader {
  readonly scope: 'unbound';
  getAnswer(sessionId: SessionId, signal?: AbortSignal): Promise<ConsoleAnswerOutcome>;
  getReceipt(sessionId: SessionId, receipt: ReceiptRef, cursor?: EvidenceCursor, signal?: AbortSignal): Promise<ConsoleReceiptOutcome>;
}

/** Host-bound console reader capability where trusted injected context fixes session identity.
 * Host route handler compares selector sessionId with injected boundSessionId.
 */
export interface ConsoleHostScopedAnswerReader {
  readonly scope: 'host_bound';
  readonly boundSessionId: SessionId;
  getAnswer(signal?: AbortSignal): Promise<ConsoleAnswerOutcome>;
  getReceipt(receipt: ReceiptRef, cursor?: EvidenceCursor, signal?: AbortSignal): Promise<ConsoleReceiptOutcome>;
}

export type ConsoleReaderBinding = ConsoleSessionAnswerReader | ConsoleHostScopedAnswerReader;
