import { randomUUID } from 'node:crypto';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import type { ValidatedStudyManifest } from './study-manifest.mjs';
import { executeTrialPlan } from './trial-executor.mjs';
import type {
  Arm,
  AgentTransport,
  ExecutionResult,
  RunnerClock,
} from './trial-executor-contract.js';
import type {
  BuildObservationRequest,
  ControlOutcome,
  ExecutableIdentity,
  ExecutedPreflight,
  LoadedWorkflowIdentity,
  ObservedBuildIdentity,
  ObservedControl,
  PreflightAdmissionError,
  PreflightAdmissionReceipt,
  PreflightCancellation,
  PreflightCheckId,
  PreflightExecutionReceipt,
  PreflightExecutionRequest,
  PreflightHostEffects,
  PreflightTraceRecord,
  PreflightedExecutionResult,
} from './trial-preflight-contract.js';

type EffectOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'abort' };

type ValidationOutcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

interface CanonicalWorkspaceObservation {
  readonly declaredPath: string;
  readonly canonicalPath: string;
}

interface VerifiedLoadedBuild {
  readonly arm: Arm;
  readonly requestId: string;
  readonly identity: ExecutableIdentity;
  readonly workflow: { readonly identity: LoadedWorkflowIdentity };
  readonly rawTrace: string;
}

async function raceWithSignal<T>(
  thunk: () => Promise<T>,
  signal: AbortSignal,
): Promise<EffectOutcome<T>> {
  if (signal.aborted) {
    return { kind: 'abort' };
  }

  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<EffectOutcome<T>>((resolveAbort) => {
    abortListener = () => resolveAbort({ kind: 'abort' });
    signal.addEventListener('abort', abortListener, { once: true });
  });

  let effectPromise: Promise<T>;
  try {
    effectPromise = thunk();
  } catch (syncError: unknown) {
    if (abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
    if (signal.aborted) {
      return { kind: 'abort' };
    }
    return { kind: 'error', error: syncError };
  }

  // Prevent unhandled promise rejection if cancelled early or aborted
  effectPromise.catch(() => {});

  const wrappedPromise = effectPromise.then(
    (value): EffectOutcome<T> => {
      if (signal.aborted) {
        return { kind: 'abort' };
      }
      return { kind: 'value', value };
    },
    (error: unknown): EffectOutcome<T> => {
      if (signal.aborted) {
        return { kind: 'abort' };
      }
      return { kind: 'error', error };
    },
  );

  try {
    const outcome = await Promise.race([wrappedPromise, abortPromise]);
    if (signal.aborted) {
      return { kind: 'abort' };
    }
    return outcome;
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

function isAncestorOrEqual(parent: string, child: string): boolean {
  const normParent = resolve(parent);
  const normChild = resolve(child);
  if (normParent === normChild) return true;
  const rel = relative(normParent, normChild);
  const isOutside = rel === '..' || rel.startsWith(`..${sep}`);
  return !isOutside && !isAbsolute(rel);
}

export type CanonicalOverlap =
  | { readonly overlaps: true; readonly canonicalPath: string }
  | { readonly overlaps: false };

function checkCanonicalOverlap(
  prevCanonical: string,
  currCanonical: string,
): CanonicalOverlap {
  if (isAncestorOrEqual(prevCanonical, currCanonical)) {
    return { overlaps: true, canonicalPath: prevCanonical };
  }
  if (isAncestorOrEqual(currCanonical, prevCanonical)) {
    return { overlaps: true, canonicalPath: currCanonical };
  }
  return { overlaps: false };
}

function validateWorkspaceOverlap(
  resolved: ReadonlyArray<CanonicalWorkspaceObservation>,
  candidate: CanonicalWorkspaceObservation,
): ValidationOutcome<CanonicalWorkspaceObservation, PreflightAdmissionError> {
  for (const prev of resolved) {
    const overlap = checkCanonicalOverlap(prev.canonicalPath, candidate.canonicalPath);
    if (overlap.overlaps) {
      return {
        ok: false,
        error: {
          kind: 'workspace_symlink_alias',
          pathA: prev.declaredPath,
          pathB: candidate.declaredPath,
          canonicalPath: overlap.canonicalPath,
        },
      };
    }
  }
  return { ok: true, value: candidate };
}

function deriveVerifiedWorkspaces(
  observations: ReadonlyArray<CanonicalWorkspaceObservation>,
): ReadonlyArray<string> {
  return Array.from(new Set(observations.map((obs) => obs.canonicalPath)));
}

const EXPECTED_CONTROLS_BY_KIND: Readonly<
  Record<PreflightExecutionRequest['kind'], ReadonlyMap<PreflightCheckId, ControlOutcome>>
> = {
  observation_checker: new Map<PreflightCheckId, ControlOutcome>([
    ['checker_intact', 'accepted'],
    ['checker_removed', 'rejected'],
    ['checker_duplicate', 'rejected'],
    ['checker_artifact_mismatch', 'rejected'],
    ['checker_wrong_run', 'rejected'],
    ['checker_unmatched_fault', 'rejected'],
  ]),
  timeout_enforcement: new Map<PreflightCheckId, ControlOutcome>([
    ['timeout_abort', 'completed'],
    ['timeout_cleanup', 'completed'],
  ]),
  fault_equivalence: new Map<PreflightCheckId, ControlOutcome>([
    ['fault_baseline', 'completed'],
    ['fault_candidate', 'completed'],
  ]),
  review_obligations: new Map<PreflightCheckId, ControlOutcome>([
    ['review_baseline', 'completed'],
    ['review_candidate', 'completed'],
  ]),
};

function getExpectedSha256(
  manifest: ValidatedStudyManifest,
  proofId: string,
): string | undefined {
  if (manifest.preflights.observationCheckerProof.proofId === proofId) {
    return manifest.preflights.observationCheckerProof.sha256;
  }
  if (manifest.preflights.timeoutEnforcementProof.proofId === proofId) {
    return manifest.preflights.timeoutEnforcementProof.sha256;
  }
  for (const faultProof of manifest.preflights.faultEquivalenceProofs) {
    if (faultProof.proofId === proofId) {
      return faultProof.sha256;
    }
  }
  if (
    manifest.stage === 'B' &&
    'stageBReviewObligationsProof' in manifest.preflights &&
    manifest.preflights.stageBReviewObligationsProof.proofId === proofId
  ) {
    return manifest.preflights.stageBReviewObligationsProof.sha256;
  }
  return undefined;
}

function validateObservedBuild(
  observed: ObservedBuildIdentity,
  expectedArm: Arm,
  expectedRequestId: string,
  manifest: ValidatedStudyManifest,
): ValidationOutcome<VerifiedLoadedBuild, PreflightAdmissionError> {
  if (observed.arm !== expectedArm || observed.requestId !== expectedRequestId) {
    return {
      ok: false,
      error: {
        kind: 'build_correlation_mismatch',
        arm: expectedArm,
        expectedRequestId,
        observedRequestId: observed.requestId,
      },
    };
  }

  if (observed.kind === 'unknown') {
    return {
      ok: false,
      error: {
        kind: 'loaded_identity_missing',
        arm: expectedArm,
        reason: observed.reason,
        rawTrace: observed.rawTrace,
      },
    };
  }

  const expectedExecutable: ExecutableIdentity = {
    commit: manifest.git.commit,
    executableSha256: manifest.executables[expectedArm].sha256,
    adapterVersion: manifest.executables[expectedArm].adapterVersion,
  };

  if (
    observed.identity.commit !== expectedExecutable.commit ||
    observed.identity.executableSha256 !== expectedExecutable.executableSha256 ||
    observed.identity.adapterVersion !== expectedExecutable.adapterVersion
  ) {
    return {
      ok: false,
      error: {
        kind: 'loaded_identity_mismatch',
        arm: expectedArm,
        expected: expectedExecutable,
        observed: observed.identity,
        rawTrace: observed.rawTrace,
      },
    };
  }

  if (observed.workflow.kind === 'unknown') {
    return {
      ok: false,
      error: {
        kind: 'loaded_workflow_missing',
        arm: expectedArm,
        reason: observed.workflow.reason,
        rawTrace: observed.rawTrace,
      },
    };
  }

  const expectedWorkflow: LoadedWorkflowIdentity = {
    workflowId: manifest.workflows[expectedArm].workflowId,
    sha256: manifest.workflows[expectedArm].sha256,
  };

  if (
    observed.workflow.identity.workflowId !== expectedWorkflow.workflowId ||
    observed.workflow.identity.sha256 !== expectedWorkflow.sha256
  ) {
    return {
      ok: false,
      error: {
        kind: 'loaded_workflow_mismatch',
        arm: expectedArm,
        expected: expectedWorkflow,
        observed: observed.workflow.identity,
        rawTrace: observed.rawTrace,
      },
    };
  }

  return {
    ok: true,
    value: {
      arm: expectedArm,
      requestId: expectedRequestId,
      identity: observed.identity,
      workflow: { identity: observed.workflow.identity },
      rawTrace: observed.rawTrace,
    },
  };
}

function validatePreflightReceipt(
  receipt: PreflightExecutionReceipt,
  req: PreflightExecutionRequest,
  manifest: ValidatedStudyManifest,
): ValidationOutcome<ExecutedPreflight, PreflightAdmissionError> {
  if (receipt.invocationId !== req.invocationId) {
    return {
      ok: false,
      error: {
        kind: 'preflight_correlation_mismatch',
        proofId: req.proofId,
        detail: `invocationId mismatch: expected ${req.invocationId}, observed ${receipt.invocationId}`,
      },
    };
  }

  if (receipt.proofId !== req.proofId) {
    return {
      ok: false,
      error: {
        kind: 'preflight_correlation_mismatch',
        proofId: req.proofId,
        detail: `proofId mismatch: expected ${req.proofId}, observed ${receipt.proofId}`,
      },
    };
  }

  if (receipt.status === 'failed') {
    return {
      ok: false,
      error: {
        kind: 'preflight_execution_failed',
        proofId: req.proofId,
        failureReason: receipt.failureReason,
        rawTrace: receipt.rawTrace,
      },
    };
  }

  if (receipt.artifactPath !== req.targetArtifactPath) {
    return {
      ok: false,
      error: {
        kind: 'preflight_correlation_mismatch',
        proofId: req.proofId,
        detail: `artifactPath mismatch: expected ${req.targetArtifactPath}, observed ${receipt.artifactPath}`,
      },
    };
  }

  if (receipt.kind !== req.kind) {
    return {
      ok: false,
      error: {
        kind: 'preflight_correlation_mismatch',
        proofId: req.proofId,
        detail: `kind mismatch: expected ${req.kind}, observed ${receipt.kind}`,
      },
    };
  }

  if (req.kind === 'fault_equivalence') {
    if (receipt.kind !== 'fault_equivalence' || receipt.scenario !== req.scenario) {
      return {
        ok: false,
        error: {
          kind: 'preflight_correlation_mismatch',
          proofId: req.proofId,
          detail: 'scenario mismatch for fault_equivalence',
        },
      };
    }
  }

  const expectedSha256 = getExpectedSha256(manifest, req.proofId);
  if (expectedSha256 === undefined || receipt.artifactSha256 !== expectedSha256) {
    return {
      ok: false,
      error: {
        kind: 'preflight_hash_mismatch',
        proofId: req.proofId,
        expectedSha256: expectedSha256 ?? '',
        observedSha256: receipt.artifactSha256,
        rawTrace: receipt.rawTrace,
      },
    };
  }

  return { ok: true, value: receipt };
}

function validateControls(
  controls: ReadonlyArray<ObservedControl>,
  kind: PreflightExecutionRequest['kind'],
  proofId: string,
): ValidationOutcome<void, PreflightAdmissionError> {
  const expectedControls = EXPECTED_CONTROLS_BY_KIND[kind];
  const seenCheckIds = new Set<PreflightCheckId>();

  for (const ctrl of controls) {
    if (seenCheckIds.has(ctrl.checkId)) {
      return {
        ok: false,
        error: {
          kind: 'preflight_control_set_incomplete',
          proofId,
          missingOrDuplicate: `duplicate control checkId: ${ctrl.checkId}`,
        },
      };
    }
    seenCheckIds.add(ctrl.checkId);
  }

  for (const expectedCheckId of expectedControls.keys()) {
    if (!seenCheckIds.has(expectedCheckId)) {
      return {
        ok: false,
        error: {
          kind: 'preflight_control_set_incomplete',
          proofId,
          missingOrDuplicate: `missing control checkId: ${expectedCheckId}`,
        },
      };
    }
  }

  if (controls.length !== expectedControls.size) {
    return {
      ok: false,
      error: {
        kind: 'preflight_control_set_incomplete',
        proofId,
        missingOrDuplicate: `unexpected controls count: expected ${expectedControls.size}, observed ${controls.length}`,
      },
    };
  }

  for (const ctrl of controls) {
    const expectedOutcome = expectedControls.get(ctrl.checkId);
    if (expectedOutcome !== undefined && ctrl.outcome !== expectedOutcome) {
      return {
        ok: false,
        error: {
          kind: 'preflight_control_outcome_mismatch',
          proofId,
          checkId: ctrl.checkId,
          expected: expectedOutcome,
          observed: ctrl.outcome,
        },
      };
    }
  }

  return { ok: true, value: undefined };
}

function validateNormalizedObservations(
  receipt: ExecutedPreflight,
  proofId: string,
): ValidationOutcome<void, PreflightAdmissionError> {
  if (receipt.kind !== 'fault_equivalence' && receipt.kind !== 'review_obligations') {
    return { ok: true, value: undefined };
  }

  const { baseline, candidate } = receipt.observations;
  if (baseline.length !== candidate.length) {
    return {
      ok: false,
      error: {
        kind: 'preflight_observation_mismatch',
        proofId,
        detail: `observation count mismatch: baseline has ${baseline.length}, candidate has ${candidate.length}`,
      },
    };
  }

  const baselineMap = new Map<string, string>();
  for (const obs of baseline) {
    baselineMap.set(obs.id, obs.value);
  }
  if (baselineMap.size !== baseline.length) {
    return {
      ok: false,
      error: {
        kind: 'preflight_observation_mismatch',
        proofId,
        detail: 'duplicate observation id in baseline',
      },
    };
  }

  const candidateMap = new Map<string, string>();
  for (const obs of candidate) {
    candidateMap.set(obs.id, obs.value);
  }
  if (candidateMap.size !== candidate.length) {
    return {
      ok: false,
      error: {
        kind: 'preflight_observation_mismatch',
        proofId,
        detail: 'duplicate observation id in candidate',
      },
    };
  }

  for (const cand of candidate) {
    if (!baselineMap.has(cand.id) || baselineMap.get(cand.id) !== cand.value) {
      return {
        ok: false,
        error: {
          kind: 'preflight_observation_mismatch',
          proofId,
          detail: `observation mismatch for id ${cand.id}: baseline (${baselineMap.get(cand.id)}) vs candidate (${cand.value})`,
        },
      };
    }
  }

  return { ok: true, value: undefined };
}

function createCancelledResult(
  cancellation: PreflightCancellation,
  retainedTraces: ReadonlyArray<PreflightTraceRecord>,
): PreflightedExecutionResult {
  return {
    scope: 'orchestration_only',
    trialAuthorization: false,
    status: 'cancelled',
    attempted: 0,
    ...cancellation,
    retainedTraces,
  };
}

function createRejectedResult(
  error: PreflightAdmissionError,
  retainedTraces: ReadonlyArray<PreflightTraceRecord>,
): PreflightedExecutionResult {
  return {
    scope: 'orchestration_only',
    trialAuthorization: false,
    status: 'rejected',
    attempted: 0,
    error,
    retainedTraces,
  };
}

function createAdmittedResult(
  admissionReceipt: PreflightAdmissionReceipt,
  trialExecution: ExecutionResult,
  retainedTraces: ReadonlyArray<PreflightTraceRecord>,
): PreflightedExecutionResult {
  return {
    scope: 'orchestration_only',
    trialAuthorization: false,
    status: 'admitted',
    admissionReceipt,
    trialExecution,
    retainedTraces,
  };
}

function buildPreflightRequests(
  manifest: ValidatedStudyManifest,
): ReadonlyArray<PreflightExecutionRequest> {
  const requests: PreflightExecutionRequest[] = [
    {
      invocationId: randomUUID(),
      kind: 'observation_checker',
      proofId: manifest.preflights.observationCheckerProof.proofId,
      targetArtifactPath: manifest.preflights.observationCheckerProof.path,
    },
    {
      invocationId: randomUUID(),
      kind: 'timeout_enforcement',
      proofId: manifest.preflights.timeoutEnforcementProof.proofId,
      targetArtifactPath: manifest.preflights.timeoutEnforcementProof.path,
    },
  ];

  for (const faultProof of manifest.preflights.faultEquivalenceProofs) {
    requests.push({
      invocationId: randomUUID(),
      kind: 'fault_equivalence',
      proofId: faultProof.proofId,
      scenario: faultProof.scenario,
      targetArtifactPath: faultProof.path,
    });
  }

  if (manifest.stage === 'B' && 'stageBReviewObligationsProof' in manifest.preflights) {
    requests.push({
      invocationId: randomUUID(),
      kind: 'review_obligations',
      proofId: manifest.preflights.stageBReviewObligationsProof.proofId,
      targetArtifactPath: manifest.preflights.stageBReviewObligationsProof.path,
    });
  }

  return requests;
}

async function observeBuildArm(
  arm: Arm,
  manifest: ValidatedStudyManifest,
  effects: PreflightHostEffects,
  signal: AbortSignal,
  retainedTraces: PreflightTraceRecord[],
): Promise<
  | { readonly kind: 'success'; readonly build: VerifiedLoadedBuild }
  | { readonly kind: 'cancelled'; readonly cancellation: PreflightCancellation }
  | { readonly kind: 'rejected'; readonly error: PreflightAdmissionError }
> {
  if (signal.aborted) {
    return {
      kind: 'cancelled',
      cancellation: { phase: 'build_observation', activity: 'unknown' },
    };
  }

  const requestId = randomUUID();
  const req: BuildObservationRequest = { requestId, arm };
  const outcome = await raceWithSignal(() => effects.observeLoadedBuild(req, signal), signal);

  if (outcome.kind === 'abort') {
    return {
      kind: 'cancelled',
      cancellation: { phase: 'build_observation', activity: 'unknown' },
    };
  }

  if (outcome.kind === 'error') {
    return {
      kind: 'rejected',
      error: {
        kind: 'loaded_identity_missing',
        arm,
        reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        rawTrace: '',
      },
    };
  }

  const observed = outcome.value;
  retainedTraces.push({
    source: 'build_observation',
    label: `build_${arm}`,
    raw: observed.rawTrace,
  });

  const validation = validateObservedBuild(observed, arm, requestId, manifest);
  if (!validation.ok) {
    return { kind: 'rejected', error: validation.error };
  }

  return { kind: 'success', build: validation.value };
}

export async function executePreflightedStudy(
  manifest: ValidatedStudyManifest,
  outputDir: string,
  transport: AgentTransport,
  effects: PreflightHostEffects,
  signal: AbortSignal,
  clock?: RunnerClock,
): Promise<PreflightedExecutionResult> {
  const retainedTraces: PreflightTraceRecord[] = [];

  // Phase 0: Preaborted check
  if (signal.aborted) {
    return createCancelledResult(
      { phase: 'preaborted', activity: 'not_started' },
      retainedTraces,
    );
  }

  // Phase 1: Workspace Canonicalization & Overlap Verification
  const workspaceEntries: string[] = [];
  for (const pair of manifest.pairs) {
    workspaceEntries.push(pair.baseline.workspacePath);
    workspaceEntries.push(pair.candidate.workspacePath);
  }

  const resolvedWorkspaces: CanonicalWorkspaceObservation[] = [];
  for (const declaredPath of workspaceEntries) {
    if (signal.aborted) {
      return createCancelledResult(
        { phase: 'workspace_check', activity: 'unknown' },
        retainedTraces,
      );
    }

    const outcome = await raceWithSignal(() => effects.resolveCanonicalPath(declaredPath), signal);
    if (outcome.kind === 'abort') {
      return createCancelledResult(
        { phase: 'workspace_check', activity: 'unknown' },
        retainedTraces,
      );
    }
    if (outcome.kind === 'error') {
      return createRejectedResult(
        {
          kind: 'workspace_inaccessible',
          path: declaredPath,
          reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        },
        retainedTraces,
      );
    }

    const candidateObs: CanonicalWorkspaceObservation = {
      declaredPath,
      canonicalPath: outcome.value,
    };

    const overlapValidation = validateWorkspaceOverlap(resolvedWorkspaces, candidateObs);
    if (!overlapValidation.ok) {
      return createRejectedResult(overlapValidation.error, retainedTraces);
    }

    resolvedWorkspaces.push(candidateObs);
  }

  const verifiedWorkspaces = deriveVerifiedWorkspaces(resolvedWorkspaces);

  // Phase 2: Build Observation (Sequential & Strongly Typed)
  const baselineOutcome = await observeBuildArm('baseline', manifest, effects, signal, retainedTraces);
  if (baselineOutcome.kind === 'cancelled') {
    return createCancelledResult(baselineOutcome.cancellation, retainedTraces);
  }
  if (baselineOutcome.kind === 'rejected') {
    return createRejectedResult(baselineOutcome.error, retainedTraces);
  }
  const baselineBuild = baselineOutcome.build;

  const candidateOutcome = await observeBuildArm('candidate', manifest, effects, signal, retainedTraces);
  if (candidateOutcome.kind === 'cancelled') {
    return createCancelledResult(candidateOutcome.cancellation, retainedTraces);
  }
  if (candidateOutcome.kind === 'rejected') {
    return createRejectedResult(candidateOutcome.error, retainedTraces);
  }
  const candidateBuild = candidateOutcome.build;

  // Phase 3: Preflight Execution
  const preflightRequests = buildPreflightRequests(manifest);
  const executedProofs: Array<{
    readonly proofId: string;
    readonly invocationId: string;
    readonly artifactSha256: string;
  }> = [];

  for (const req of preflightRequests) {
    if (signal.aborted) {
      return createCancelledResult(
        { phase: 'preflight_execution', activity: 'unknown' },
        retainedTraces,
      );
    }

    const outcome = await raceWithSignal(() => effects.executePreflight(req, signal), signal);
    if (outcome.kind === 'abort') {
      return createCancelledResult(
        { phase: 'preflight_execution', activity: 'unknown' },
        retainedTraces,
      );
    }
    if (outcome.kind === 'error') {
      return createRejectedResult(
        { kind: 'preflight_not_executed', proofId: req.proofId },
        retainedTraces,
      );
    }

    const receipt = outcome.value;
    retainedTraces.push({
      source: 'preflight_execution',
      label: req.proofId,
      raw: receipt.rawTrace,
    });

    if (receipt.status === 'executed') {
      for (const ctrl of receipt.controls) {
        retainedTraces.push({
          source: 'preflight_execution',
          label: ctrl.checkId,
          raw: ctrl.raw,
        });
      }
    }

    const receiptValidation = validatePreflightReceipt(receipt, req, manifest);
    if (!receiptValidation.ok) {
      return createRejectedResult(receiptValidation.error, retainedTraces);
    }
    const executedReceipt = receiptValidation.value;

    const controlsValidation = validateControls(executedReceipt.controls, req.kind, req.proofId);
    if (!controlsValidation.ok) {
      return createRejectedResult(controlsValidation.error, retainedTraces);
    }

    const obsValidation = validateNormalizedObservations(executedReceipt, req.proofId);
    if (!obsValidation.ok) {
      return createRejectedResult(obsValidation.error, retainedTraces);
    }

    executedProofs.push({
      proofId: req.proofId,
      invocationId: req.invocationId,
      artifactSha256: executedReceipt.artifactSha256,
    });
  }

  // Preflight successfully admitted!
  const admittedAtMs = clock ? clock.nowMs() : Date.now();
  const admissionReceipt: PreflightAdmissionReceipt = {
    stage: manifest.stage,
    admittedAtMs,
    baselineIdentity: baselineBuild.identity,
    candidateIdentity: candidateBuild.identity,
    baselineWorkflow: baselineBuild.workflow.identity,
    candidateWorkflow: candidateBuild.workflow.identity,
    verifiedWorkspaces,
    executedProofs,
  };

  const trialExecution = await executeTrialPlan(
    manifest,
    outputDir,
    transport,
    signal,
    clock,
  );

  return createAdmittedResult(admissionReceipt, trialExecution, retainedTraces);
}
