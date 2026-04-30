/**
 * Success outcome builder.
 * Handles the path when an advance succeeds (not blocked).
 */

import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
import type { SessionIndex } from '../../../v2/durable-core/session-index.js';
import type { ExecutionSnapshotFileV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import type { SessionId, RunId, NodeId, WorkflowHash } from '../../../v2/durable-core/ids/index.js';
import type { AttemptId } from '../../../v2/durable-core/tokens/index.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../../v2/ports/snapshot-store.port.js';
import type { WithHealthySessionLock } from '../../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { JsonObject } from '../../../v2/durable-core/canonical/json-types.js';
import type { WorkflowEvent } from '../../../domain/execution/event.js';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';

import { WorkflowCompiler } from '../../../application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../../application/services/workflow-interpreter.js';
import { checkRecommendationExceedance } from '../../../v2/durable-core/domain/recommendation-warnings.js';
import type { InternalError } from '../v2-error-mapping.js';
import { toV1ExecutionState, fromV1ExecutionState } from '../v2-state-conversion.js';
import {
  buildGapEvents,
  buildRecommendationWarningEvents,
  buildContextSetEvent,
  buildSuccessValidationEvent,
  buildDecisionTraceEvent,
  buildRunCompletedEvent,
} from '../v2-advance-events.js';
import type { AdvanceMode, AdvanceContext, ComputedAdvanceResults, AdvanceCorePorts } from './index.js';
import type { ValidatedAdvanceInputs } from './input-validation.js';
import { buildAndAppendPlan, buildNotesOutputs, buildArtifactOutputs } from './event-builders.js';
import { buildAssessmentRecordedEvent } from '../../../v2/durable-core/domain/assessment-recorded-event-builder.js';

/**
 * Read a string observation value from the session event log.
 * Returns null if no matching observation_recorded event is found.
 *
 * WHY direct field access (no cast): after `e.kind === 'observation_recorded'` narrows
 * the union, `e.data` is typed as the observation_recorded data shape. All four value
 * types (`short_string`, `git_sha1`, `sha256`, `path`) have `.value: string`.
 */
function readObservation(events: readonly DomainEventV1[], key: string): string | null {
  for (const e of events) {
    if (e.kind !== 'observation_recorded') continue;
    if (e.data.key !== key) continue;
    return e.data.value.value;
  }
  return null;
}


type PartialEvent = Omit<DomainEventV1, 'eventIndex' | 'sessionId' | 'timestampMs'>;

/** The toNodeKind to use when the advance succeeds (not blocked). */
function successNodeKind(mode: AdvanceMode): 'step' | undefined {
  switch (mode.kind) {
    case 'fresh': return undefined; // uses default in buildAckAdvanceAppendPlanV1
    case 'retry': return 'step';
  }
}

export function buildSuccessOutcome(args: {
  readonly mode: AdvanceMode;
  readonly ctx: AdvanceContext;
  readonly computed: ComputedAdvanceResults;
  readonly v: ValidatedAdvanceInputs;
  readonly lock: WithHealthySessionLock;
  readonly ports: AdvanceCorePorts;
  readonly lockedIndex: SessionIndex;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { mode, v, lock, ports } = args;
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash, inputOutput, pinnedWorkflow, engineState, pendingStep } = args.ctx;
  const { reasons, outputRequirement, validation } = args.computed;
  const { snapshotStore, sessionStore, sha256, idFactory, gitSnapshot } = ports;

  // Compile + interpret
  const compiler = new WorkflowCompiler();
  const interpreter = new WorkflowInterpreter();
  const compiledWf = compiler.compile(pinnedWorkflow);
  if (compiledWf.isErr()) {
    return errAsync({ kind: 'advance_apply_failed', message: compiledWf.error.message } as const);
  }

  const currentState = toV1ExecutionState(engineState);
  const event: WorkflowEvent = {
    kind: 'step_completed',
    stepInstanceId: {
      stepId: pendingStep.stepId,
      loopPath: pendingStep.loopPath.map(f => ({ loopId: f.loopId, iteration: f.iteration })),
    },
  };
  const advanced = interpreter.applyEvent(currentState, event);
  if (advanced.isErr()) {
    return errAsync({ kind: 'advance_apply_failed', message: advanced.error.message } as const);
  }

  // WHY only inputArtifacts (not truth.events): interpreter.next() evaluates the current
  // decision -- e.g. whether a while loop should continue. For artifact_contract loops, the
  // exit-decision comes from the step that just completed; its artifact is always in
  // inputOutput.artifacts (the current continue_workflow call). Historical truth.events
  // artifacts are from previous steps and previous loops -- passing them caused sequential
  // artifact_contract while loops to be contaminated by stale stop decisions from earlier loops.
  // The pure interpreter should receive only what is relevant to the current decision.
  const artifactsForEval = inputOutput?.artifacts ?? [];
  const nextRes = interpreter.next(compiledWf.value, advanced.value, v.mergedContext, artifactsForEval);
  if (nextRes.isErr()) {
    // Distinguish missing context (recoverable, agent can fix) from other errors (system failures).
    // MissingContext means a loop requires a context variable the agent hasn't set yet.
    if (nextRes.error._tag === 'MissingContext') {
      return errAsync({ kind: 'advance_next_missing_context', message: nextRes.error.message } as const);
    }
    return errAsync({ kind: 'advance_next_failed', message: nextRes.error.message } as const);
  }

  const out = nextRes.value;

  // ── Build extra events ──────────────────────────────────────────────

  const extraEventsToAppend: PartialEvent[] = [];

  // Gap events (never-stop mode)
  if (v.autonomy === 'full_auto_never_stop' && reasons.length > 0) {
    extraEventsToAppend.push(
      ...buildGapEvents({
        gaps: reasons,
        sessionId: String(sessionId),
        runId,
        nodeId: currentNodeId,
        attemptId,
        idFactory,
      })
    );
  }

  // Recommendation warnings
  const workflowRecommendations = pinnedWorkflow.definition.recommendedPreferences;
  if (workflowRecommendations && v.effectivePrefs) {
    const warnings = checkRecommendationExceedance(
      { autonomy: v.autonomy, riskPolicy: v.riskPolicy },
      workflowRecommendations
    );
    extraEventsToAppend.push(
      ...buildRecommendationWarningEvents({
        recommendations: warnings,
        sessionId: String(sessionId),
        runId,
        nodeId: currentNodeId,
        idFactory,
      })
    );
  }

  // Context set events
  if (v.inputContextObj) {
    const contextEvent = buildContextSetEvent({
      mergedContext: v.mergedContext as JsonObject,
      sessionId: String(sessionId),
      runId,
      idFactory,
    });
    if (contextEvent) {
      extraEventsToAppend.push(contextEvent);
    }
  }

  // Validation event — mode-driven: retry always emits, fresh never emits on success
  const validationEvent = buildSuccessValidationEvent({
    mode,
    outputRequirement,
    validation,
    attemptId,
    sessionId: String(sessionId),
    runId,
    nodeId: currentNodeId,
    idFactory,
  });
  if (validationEvent) {
    extraEventsToAppend.push(validationEvent);
  }

  // Decision trace
  const traceEventRes = buildDecisionTraceEvent({
    decisions: out.trace,
    sessionId: String(sessionId),
    runId,
    nodeId: currentNodeId,
    idFactory,
  });
  if (traceEventRes.isErr()) {
    return errAsync(traceEventRes.error);
  }
  if (traceEventRes.value) {
    extraEventsToAppend.push(traceEventRes.value);
  }

  // ── Build outputs ───────────────────────────────────────────────────

  const newEngineState = fromV1ExecutionState(out.state);
  const snapshotFile: ExecutionSnapshotFileV1 = {
    v: 1,
    kind: 'execution_snapshot',
    enginePayload: { v: 1, engineState: newEngineState },
  };

  return snapshotStore.putExecutionSnapshotV1(snapshotFile).andThen((newSnapshotRef) => {
    const allowNotesAppend = v.validationCriteria
      ? Boolean(v.notesMarkdown && validation && validation.valid)
      : Boolean(v.notesMarkdown);

    const notesOutputs = buildNotesOutputs(allowNotesAppend, attemptId, inputOutput);
    const artifactOutputsRes = buildArtifactOutputs(inputOutput?.artifacts ?? [], attemptId, sha256);
    if (artifactOutputsRes.isErr()) {
      return errAsync(artifactOutputsRes.error);
    }

    // Emit one assessment_recorded event per accepted assessment (one per assessmentRef).
    // recordedAssessments[i] and acceptedArtifacts[i] are positionally aligned — built in the same loop.
    const acceptedArtifacts = v.assessmentValidation?.acceptedArtifacts ?? [];
    for (let i = 0; i < acceptedArtifacts.length; i++) {
      const { artifactIndex } = acceptedArtifacts[i]!;
      const recordedAssessment = v.assessmentValidation?.recordedAssessments[i];
      if (!recordedAssessment) continue;

      const assessmentOutput = artifactOutputsRes.value[artifactIndex];
      if (!assessmentOutput || assessmentOutput.outputChannel !== 'artifact') {
        return errAsync({
          kind: 'invariant_violation',
          message: 'Accepted assessment artifact did not produce a matching artifact output.',
        });
      }

      const assessmentEventRes = buildAssessmentRecordedEvent({
        sessionId: String(sessionId),
        attemptId: String(attemptId),
        artifactOutputId: String(assessmentOutput.outputId),
        scope: { runId: String(runId), nodeId: String(currentNodeId) },
        assessment: recordedAssessment,
        minted: { eventId: idFactory.mintEventId() },
      });
      if (assessmentEventRes.isErr()) {
        return errAsync({ kind: 'invariant_violation', message: assessmentEventRes.error.message });
      }
      extraEventsToAppend.push(assessmentEventRes.value);
    }

    const outputsToAppend = [...notesOutputs, ...artifactOutputsRes.value];

    // Emit run_completed when the session finishes successfully.
    // WHY here (inside andThen): newEngineState is available, and async git I/O is
    // safe inside a ResultAsync chain. resolveEndGitSha is best-effort (never throws).
    if (newEngineState.kind === 'complete') {
      const repoRoot = readObservation(truth.events, 'repo_root');
      const startGitSha = readObservation(truth.events, 'git_head_sha');
      const gitBranch = readObservation(truth.events, 'git_branch');

      // durationMs: first event timestampMs to last event timestampMs.
      const firstTs = truth.events[0]?.timestampMs;
      const lastTs = truth.events[truth.events.length - 1]?.timestampMs;
      const durationMs = (firstTs !== undefined && lastTs !== undefined) ? (lastTs - firstTs) : undefined;

      return RA.fromPromise(
        gitSnapshot.resolveEndSnapshot(repoRoot, startGitSha),
        (e) => ({ kind: 'advance_apply_failed' as const, message: String(e) }),
      ).andThen(({ endSha: endGitSha, commitShas }) => {
        // WHY GitSnapshotPortV2 instead of direct execFile: git I/O belongs behind a port.
        // The port runs git rev-parse HEAD and git log --no-merges --first-parent in parallel,
        // capturing both the end SHA and the branch-local commits produced during this session.
        const agentCommitShas: readonly string[] = commitShas;
        const captureConfidence: 'high' | 'none' = agentCommitShas.length > 0 ? 'high' : 'none';
        extraEventsToAppend.push(buildRunCompletedEvent({
          sessionId: String(sessionId),
          runId: String(runId),
          startGitSha,
          endGitSha,
          gitBranch,
          agentCommitShas,
          captureConfidence,
          durationMs,
          idFactory,
        }));
        return buildAndAppendPlan({
          kind: 'advanced',
          truth, lockedIndex: args.lockedIndex, sessionId, runId, currentNodeId, attemptId, workflowHash,
          extraEventsToAppend, toNodeKind: successNodeKind(mode),
          snapshotRef: newSnapshotRef, outputsToAppend,
          sessionStore, idFactory, lock,
        });
      });
    }

    return buildAndAppendPlan({
      kind: 'advanced',
      truth, lockedIndex: args.lockedIndex, sessionId, runId, currentNodeId, attemptId, workflowHash,
      extraEventsToAppend, toNodeKind: successNodeKind(mode),
      snapshotRef: newSnapshotRef, outputsToAppend,
      sessionStore, idFactory, lock,
    });
  });
}

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}
