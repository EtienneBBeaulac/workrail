/**
 * Success outcome builder.
 * Handles the path when an advance succeeds (not blocked).
 */

import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
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
import { collectArtifactsForEvaluation } from '../v2-context-budget.js';
import {
  buildGapEvents,
  buildRecommendationWarningEvents,
  buildContextSetEvent,
  buildSuccessValidationEvent,
  buildDecisionTraceEvent,
} from '../v2-advance-events.js';
import type { AdvanceMode, AdvanceContext, ComputedAdvanceResults, AdvanceCorePorts } from './index.js';
import type { ValidatedAdvanceInputs } from './input-validation.js';
import { buildAndAppendPlan, buildNotesOutputs, buildArtifactOutputs } from './event-builders.js';

type PartialEvent = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

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
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { mode, v, lock, ports } = args;
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash, inputOutput, pinnedWorkflow, engineState, pendingStep } = args.ctx;
  const { effectiveReasons, outputRequirement, validation } = args.computed;
  const { snapshotStore, sessionStore, sha256, idFactory } = ports;

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

  const artifactsForEval = collectArtifactsForEvaluation({
    truthEvents: truth.events,
    inputArtifacts: inputOutput?.artifacts ?? [],
  });
  const nextRes = interpreter.next(compiledWf.value, advanced.value, v.mergedContext, artifactsForEval);
  if (nextRes.isErr()) {
    return errAsync({ kind: 'advance_next_failed', message: nextRes.error.message } as const);
  }

  const out = nextRes.value;

  // ── Build extra events ──────────────────────────────────────────────

  const extraEventsToAppend: PartialEvent[] = [];

  // Gap events (never-stop mode)
  if (v.autonomy === 'full_auto_never_stop' && effectiveReasons.length > 0) {
    extraEventsToAppend.push(
      ...buildGapEvents({
        gaps: effectiveReasons,
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

    const outputsToAppend = [...notesOutputs, ...artifactOutputsRes.value];

    return buildAndAppendPlan({
      kind: 'advanced',
      truth, sessionId, runId, currentNodeId, attemptId, workflowHash,
      extraEventsToAppend, toNodeKind: successNodeKind(mode),
      snapshotRef: newSnapshotRef, outputsToAppend,
      sessionStore, idFactory, lock,
    });
  });
}

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}
