import type { AgentEvent, RunnerClock, TrialRequest, LedgerRecord } from './trial-executor-contract.js';
import type { PreflightHostEffects, PreflightAdmissionReceipt, PreflightTraceRecord } from './trial-preflight-contract.js';
import type { ReviewVerdictArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import type { StageBCall, StageBObservation, StageBFault, StageBTrial, StageBScorerReport } from './stage-b-scorer-contract.js';
import type { Trial as StageATrial, score as scoreStageA } from './usability-scorer.mjs';

export type HostRecordPayload =
  | { readonly kind: 'coverage'; readonly status: 'opened' | 'closed' }
  | { readonly kind: 'tool_call'; readonly conversationId: string; readonly call: StageBCall }
  | { readonly kind: 'commit'; readonly conversationId: string; readonly eventId: string; readonly callId: string; readonly observation: StageBObservation }
  | { readonly kind: 'retained_snapshot'; readonly observation: StageBObservation }
  | { readonly kind: 'read'; readonly conversationId: string; readonly callId: string; readonly observation: StageBObservation }
  | { readonly kind: 'engine_recreated'; readonly priorInstanceId: string; readonly instanceId: string; readonly priorConversationId: string; readonly recoveryConversationId: string }
  | { readonly kind: 'fault'; readonly fault: StageATrial['fault'] | StageBFault }
  | { readonly kind: 'submitted_review'; readonly conversationId: string; readonly artifact: ReviewVerdictArtifactV1 }
  | { readonly kind: 'accepted_review'; readonly conversationId: string; readonly artifact: ReviewVerdictArtifactV1 }
  | { readonly kind: 'unauthorized_effect'; readonly effect: string }
  | { readonly kind: 'host_completion'; readonly completed: boolean }
  | { readonly kind: 'host_termination'; readonly termination: StageATrial['termination'] | StageBTrial['termination'] }
  | { readonly kind: 'token_usage'; readonly tokensUsed: number | null }
  | { readonly kind: 'observed_answer'; readonly observation: StageBObservation };

export type HostRecord = {
  readonly recordId: string;
  readonly runId: string;
  readonly atMs: number;
  readonly source: string;
  readonly rawProvenance: string;
} & HostRecordPayload;

export type ExtendedTransportEvent =
  | { readonly type: 'agent'; readonly event: AgentEvent }
  | { readonly type: 'host'; readonly record: HostRecord };

export interface ExtendedAgentTransport {
  startFresh(request: TrialRequest, signal: AbortSignal): AsyncIterable<ExtendedTransportEvent>;
}

export type StageAScoreReport = ReturnType<typeof scoreStageA>;

export interface BaseStudyReport {
  readonly version: 1;
  readonly scope: 'orchestration_only';
  readonly trialAuthorization: false;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly status:
    | 'measurement_thresholds_met'
    | 'no_advantage'
    | 'inconclusive'
    | 'incomplete_evidence'
    | 'rejected_safety'
    | 'failed'
    | 'complete_measurement';
  readonly preflight: PreflightAdmissionReceipt | null;
  readonly preflightTraces: readonly PreflightTraceRecord[];
  readonly agentLedger: readonly LedgerRecord[];
  readonly hostLedger: readonly HostRecord[];
  readonly slots: readonly ({ readonly runId: string } & (
    | { readonly status: 'normalized' }
    | { readonly status: 'unscorable'; readonly reason: 'missing_host_evidence' | 'unknown_model' | 'failed' | 'unknown_remote' | 'invalid_evidence' }
    | { readonly status: 'not_attempted' }
  ))[];
}

export interface StageAStudyReport extends BaseStudyReport {
  readonly stage: 'A';
  readonly trials: readonly StageATrial[];
  readonly scoreReport: StageAScoreReport | null;
}

export interface StageBStudyReport extends BaseStudyReport {
  readonly stage: 'B';
  readonly trials: readonly StageBTrial[];
  readonly scoreReport: StageBScorerReport | null;
}

export type RejectedBytesReason = 'hash_mismatch' | 'invalid_json' | 'invalid_declaration';

export type UnresolvedStudyReport = {
  readonly version: 1;
  readonly scope: 'orchestration_only';
  readonly trialAuthorization: false;
  readonly manifestPath: string;
  readonly stage: 'unresolved';
  readonly status: 'failed';
  readonly scoreReport: null;
  readonly trials: readonly [];
  readonly preflight: null;
  readonly preflightTraces: readonly [];
  readonly agentLedger: readonly [];
  readonly hostLedger: readonly [];
  readonly slots: readonly Extract<BaseStudyReport['slots'][number], { readonly status: 'not_attempted' }>[];
} & (
  | {
      readonly failureKind: 'unreadable_manifest';
      readonly manifestSha256: null;
      readonly reason?: never;
    }
  | {
      readonly failureKind: 'rejected_bytes';
      readonly manifestSha256: string;
      readonly reason: RejectedBytesReason;
    }
);

export type StudyReport = StageAStudyReport | StageBStudyReport | UnresolvedStudyReport;

export interface RunStudyOptions {
  readonly manifestPath: string;
  readonly expectedManifestSha256: string;
  readonly outputDir: string;
  readonly transport: ExtendedAgentTransport;
  readonly effects: PreflightHostEffects;
  readonly signal: AbortSignal;
  readonly clock?: RunnerClock;
}

export function runStudy(options: RunStudyOptions): Promise<StudyReport>;

/** Composition contract (experimental only): verify frozen manifest bytes and every
 * referenced artifact before preflight. Delegate to executePreflightedStudy using
 * an adapter which appends each host record to host-observations.ndjson before
 * pulling again and forwards only agent events to the existing executor.
 * Derive observations from that persisted journal and attempts.ndjson, never agent
 * trace claims. Write study-report.json equal to the returned report. Every manifest
 * slot appears exactly once in slots; failed/unknown attempts remain unscorable,
 * not fabricated finished Stage A trials. Missing observed model cannot be filled
 * from requested environment. Stage A trials contains only normalized records;
 * missing slots force incomplete_evidence. Fixture tests confer no live admission.
 */

/** Stage B recovery requires, in order: acknowledged commit, fault receipt,
 * engine_recreated with distinct instance IDs, conversation_restarted with matching
 * prior/new IDs, then a read of the committed work from the new conversation.
 * Every call/commit/read/review artifact binds to the currently observed conversation.
 * Missing, mismatched or repeated boundaries are incomplete evidence, never a
 * recovered trial. Engine identities are host observations, not agent prose.
 * All observed environments, including restarted conversations, must match the
 * frozen arm environment. Missing identity stays unknown and prevents scoring. */
