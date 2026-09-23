import type { ReviewVerdictArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';

import type { STAGE_B_SCENARIOS } from './study-manifest.mjs';
export type StageBScenario = (typeof STAGE_B_SCENARIOS)[number];

export type StageBArm = 'baseline' | 'candidate';
export type StageBRepetition = 1 | 2 | 3 | 4 | 5;
export type StageBTermination = 'finished' | 'timeout' | 'assisted' | 'failed' | 'unknown';

export type StageBOperation = 'read' | 'write';

export type StageBCallOutcome =
  | 'success'
  | 'invalid_arguments'
  | 'invalid_authority'
  | 'rejected_content'
  | 'infrastructure_error'
  | 'injected_fault';

export interface StageBCall {
  readonly id: string;
  readonly atMs: number;
  readonly operation: StageBOperation;
  readonly outcome: StageBCallOutcome;
}

export interface StageBObservation {
  readonly id: string;
  readonly value: string;
}

export type StageBFault =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'missing_summary';
      readonly callId: string;
      readonly noticeAtMs: number;
    }
  | {
      readonly kind: 'recovery_after_partial_work';
      readonly callId: string;
      readonly noticeAtMs: number;
      readonly committedEventId: string;
      readonly priorConversationId: string;
      readonly recoveryConversationId: string;
    };

export type EffectCoverage = 'known' | 'unknown';

export interface StageBCommit {
  readonly eventId: string;
  readonly callId: string;
  readonly runId: string;
  readonly observation: StageBObservation;
}

export interface StageBRead {
  readonly callId: string;
  readonly runId: string;
  readonly observation: StageBObservation;
}

export interface StageBTrial {
  readonly scenario: StageBScenario;
  readonly repetition: StageBRepetition;
  readonly arm: StageBArm;
  readonly runId: string;
  readonly model: string;
  readonly effort: string;
  readonly fixture: string;
  readonly effectCoverage: EffectCoverage;
  readonly expectedReview: ReviewVerdictArtifactV1;
  readonly expectedObservations: readonly StageBObservation[];
  readonly calls: readonly StageBCall[];
  readonly fault: StageBFault;
  readonly commits: readonly StageBCommit[];
  readonly retained: readonly StageBObservation[];
  readonly reads: readonly StageBRead[];
  readonly submittedArtifact: ReviewVerdictArtifactV1 | null;
  readonly acceptedArtifact: ReviewVerdictArtifactV1 | null;
  readonly completed: boolean;
  readonly unauthorizedEffects: readonly string[];
  readonly termination: StageBTermination;
  readonly elapsedMs: number;
  readonly tokensUsed: number | null;
}

export interface StageBStudy {
  readonly version: 1;
  readonly stage: 'B';
  readonly trials: readonly StageBTrial[];
}

export interface StageBMeasurement {
  readonly scenario: StageBScenario;
  readonly repetition: StageBRepetition;
  readonly arm: StageBArm;
  readonly success: boolean;
  readonly completed: boolean;
  readonly issues: readonly string[];
  readonly safety: readonly string[];
  readonly exactAcceptedWork: boolean;
  readonly validArtifact: boolean;
  readonly invalidCalls: number;
  readonly infrastructureErrors: number;
  readonly calls: number;
  readonly elapsedMs: number;
  readonly termination: StageBTermination;
  readonly tokensUsed: number | null;
}

export type StageBReportStatus =
  | 'complete_measurement'
  | 'incomplete_evidence'
  | 'rejected_safety';

export interface StageBNoncompletionCount {
  readonly baseline: number;
  readonly candidate: number;
}

export interface StageBScorerReport {
  readonly status: StageBReportStatus;
  readonly scope: 'normalized_stage_b_evidence_only';
  readonly releaseApproval: false;
  readonly issues: readonly string[];
  readonly noncompletion: StageBNoncompletionCount;
  readonly measurements: readonly StageBMeasurement[];
}

export interface StageBInvalidInputIssue {
  readonly path: string;
  readonly message: string;
}

export type StageBScoreInputResult =
  | {
      readonly kind: 'scored';
      readonly report: StageBScorerReport;
    }
  | {
      readonly kind: 'invalid_input';
      readonly issues: readonly StageBInvalidInputIssue[];
    };

export type ScoreStageB = (study: StageBStudy) => StageBScorerReport;
export type ScoreStageBInput = (input: unknown) => StageBScoreInputResult;
