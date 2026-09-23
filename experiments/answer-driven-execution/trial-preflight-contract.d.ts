// trial-preflight-contract.ts
import type { Arm, AgentTransport, ExecutionResult, RunnerClock } from './trial-executor-contract.js';
import type { ValidatedStudyManifest } from './study-manifest.mjs';

export interface ExecutableIdentity {
  readonly commit: string;
  readonly executableSha256: string;
  readonly adapterVersion: string;
}

export interface LoadedWorkflowIdentity {
  readonly workflowId: string;
  readonly sha256: string;
}

export interface BuildObservationRequest {
  readonly requestId: string;
  readonly arm: Arm;
}

export type ObservedBuildIdentity =
  | {
      readonly kind: 'observed';
      readonly requestId: string;
      readonly arm: Arm;
      readonly identity: ExecutableIdentity;
      readonly workflow: { readonly kind: 'observed'; readonly identity: LoadedWorkflowIdentity } | { readonly kind: 'unknown'; readonly reason: string };
      readonly rawTrace: string;
    }
  | {
      readonly kind: 'unknown';
      readonly requestId: string;
      readonly arm: Arm;
      readonly reason: string;
      readonly rawTrace: string;
    };

export type PreflightKind =
  | 'observation_checker'
  | 'timeout_enforcement'
  | 'fault_equivalence'
  | 'review_obligations';

export type PreflightExecutionRequest =
  | {
      readonly invocationId: string;
      readonly kind: 'observation_checker';
      readonly proofId: string;
      readonly targetArtifactPath: string;
    }
  | {
      readonly invocationId: string;
      readonly kind: 'timeout_enforcement';
      readonly proofId: string;
      readonly targetArtifactPath: string;
    }
  | {
      readonly invocationId: string;
      readonly kind: 'fault_equivalence';
      readonly proofId: string;
      readonly scenario: string;
      readonly targetArtifactPath: string;
    }
  | {
      readonly invocationId: string;
      readonly kind: 'review_obligations';
      readonly proofId: string;
      readonly targetArtifactPath: string;
    };

export type PreflightCheckId =
  | 'checker_intact'
  | 'checker_removed'
  | 'checker_duplicate'
  | 'checker_artifact_mismatch'
  | 'checker_wrong_run'
  | 'checker_unmatched_fault'
  | 'timeout_abort'
  | 'timeout_cleanup'
  | 'fault_baseline'
  | 'fault_candidate'
  | 'review_baseline'
  | 'review_candidate';

export type ControlOutcome = 'accepted' | 'rejected' | 'completed';

export interface ObservedControl {
  readonly checkId: PreflightCheckId;
  readonly outcome: ControlOutcome;
  readonly raw: string;
}

export interface NormalizedObservation {
  readonly id: string;
  readonly value: string;
}

export type ExecutedPreflight = {
  readonly status: 'executed';
  readonly invocationId: string;
  readonly proofId: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly controls: ReadonlyArray<ObservedControl>;
  readonly rawTrace: string;
} & (
  | { readonly kind: 'observation_checker' | 'timeout_enforcement' }
  | { readonly kind: 'fault_equivalence'; readonly scenario: string;
      readonly observations: { readonly baseline: ReadonlyArray<NormalizedObservation>; readonly candidate: ReadonlyArray<NormalizedObservation> } }
  | { readonly kind: 'review_obligations';
      readonly observations: { readonly baseline: ReadonlyArray<NormalizedObservation>; readonly candidate: ReadonlyArray<NormalizedObservation> } }
);
export type PreflightExecutionReceipt = ExecutedPreflight | {
  readonly status: 'failed'; readonly invocationId: string; readonly proofId: string;
  readonly failureReason: string; readonly rawTrace: string;
};

export interface PreflightTraceRecord {
  readonly source: 'workspace_check' | 'build_observation' | 'preflight_execution';
  readonly label: string;
  readonly raw: string;
}

export type PreflightAdmissionError =
  | {
      readonly kind: 'workspace_symlink_alias';
      readonly pathA: string;
      readonly pathB: string;
      readonly canonicalPath: string;
    }
  | {
      readonly kind: 'workspace_inaccessible';
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'loaded_identity_missing';
      readonly arm: Arm;
      readonly reason: string;
      readonly rawTrace: string;
    }
  | {
      readonly kind: 'loaded_identity_mismatch';
      readonly arm: Arm;
      readonly expected: ExecutableIdentity;
      readonly observed: ExecutableIdentity;
      readonly rawTrace: string;
    }
  | {
      readonly kind: 'loaded_workflow_missing';
      readonly arm: Arm;
      readonly reason: string;
      readonly rawTrace: string;
    }
  | {
      readonly kind: 'loaded_workflow_mismatch';
      readonly arm: Arm;
      readonly expected: LoadedWorkflowIdentity;
      readonly observed: LoadedWorkflowIdentity;
      readonly rawTrace: string;
    }
  | {
      readonly kind: 'build_correlation_mismatch';
      readonly arm: Arm;
      readonly expectedRequestId: string;
      readonly observedRequestId: string;
    }
  | {
      readonly kind: 'preflight_not_executed';
      readonly proofId: string;
    }
  | {
      readonly kind: 'preflight_execution_failed';
      readonly proofId: string;
      readonly failureReason: string;
      readonly rawTrace: string;
    }
  | {
      readonly kind: 'preflight_correlation_mismatch';
      readonly proofId: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'preflight_hash_mismatch';
      readonly proofId: string;
      readonly expectedSha256: string;
      readonly observedSha256: string;
      readonly rawTrace: string;
    }
  | {
      readonly kind: 'preflight_control_set_incomplete';
      readonly proofId: string;
      readonly missingOrDuplicate: string;
    }
  | {
      readonly kind: 'preflight_control_outcome_mismatch';
      readonly proofId: string;
      readonly checkId: PreflightCheckId;
      readonly expected: ControlOutcome;
      readonly observed: ControlOutcome;
    }
  | {
      readonly kind: 'preflight_observation_mismatch';
      readonly proofId: string;
      readonly detail: string;
    };

export interface PreflightHostEffects {
  readonly resolveCanonicalPath: (path: string) => Promise<string>;
  readonly observeLoadedBuild: (request: BuildObservationRequest, signal: AbortSignal) => Promise<ObservedBuildIdentity>;
  readonly executePreflight: (request: PreflightExecutionRequest, signal: AbortSignal) => Promise<PreflightExecutionReceipt>;
}

export interface PreflightAdmissionReceipt {
  readonly stage: 'A' | 'B';
  readonly admittedAtMs: number;
  readonly baselineIdentity: ExecutableIdentity;
  readonly candidateIdentity: ExecutableIdentity;
  readonly baselineWorkflow: LoadedWorkflowIdentity;
  readonly candidateWorkflow: LoadedWorkflowIdentity;
  readonly verifiedWorkspaces: ReadonlyArray<string>;
  readonly executedProofs: ReadonlyArray<{
    readonly proofId: string;
    readonly invocationId: string;
    readonly artifactSha256: string;
  }>;
}

export type PreflightCancellation =
  | { readonly phase: 'preaborted'; readonly activity: 'not_started' }
  | { readonly phase: 'workspace_check' | 'build_observation' | 'preflight_execution'; readonly activity: 'unknown' };

export type PreflightedExecutionResult = {
  readonly scope: 'orchestration_only';
  readonly trialAuthorization: false;
} & (
  | {
      readonly status: 'admitted';
      readonly admissionReceipt: PreflightAdmissionReceipt;
      readonly trialExecution: ExecutionResult;
      readonly retainedTraces: ReadonlyArray<PreflightTraceRecord>;
    }
  | {
      readonly status: 'rejected';
      readonly attempted: 0;
      readonly error: PreflightAdmissionError;
      readonly retainedTraces: ReadonlyArray<PreflightTraceRecord>;
    }
  | ({
      readonly status: 'cancelled';
      readonly attempted: 0;
      readonly retainedTraces: ReadonlyArray<PreflightTraceRecord>;
    } & PreflightCancellation)
);

export function executePreflightedStudy(
  manifest: ValidatedStudyManifest,
  outputDir: string,
  transport: AgentTransport,
  effects: PreflightHostEffects,
  signal: AbortSignal,
  clock?: RunnerClock
): Promise<PreflightedExecutionResult>;

/** Internal experiment orchestration, not real-study authorization. Before agent
 * dispatch: realpath every workspace and reject overlap; observe both loaded builds
 * and exact loaded workflows; invoke every manifest preflight, validate host-issued
 * correlations and artifact identities, exact control sets/outcomes and equal normalized
 * paired observations. Supports explicit cancellation without waiting on noncooperative
 * producers. Retain raw build/producer/control traces including refusal and interruption
 * evidence. Trusted effects supply observations, not caller approval. Real producers
 * and arming remain separate.
 */
