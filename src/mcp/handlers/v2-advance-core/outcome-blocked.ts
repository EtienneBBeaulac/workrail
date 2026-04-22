/**
 * Blocked outcome builder.
 * Handles the path when an advance is blocked by validation or requirements.
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
import type { ValidationResult } from '../../../types/validation.js';

import { buildBlockerReport } from '../../../v2/durable-core/domain/reason-model.js';
import { buildValidationPerformedEvent } from '../../../v2/durable-core/domain/validation-event-builder.js';
import { buildBlockedNodeSnapshot } from '../../../v2/durable-core/domain/blocked-node-builder.js';
import { buildAssessmentRecordedEvent } from '../../../v2/durable-core/domain/assessment-recorded-event-builder.js';
import { buildAssessmentConsequenceAppliedEvent } from '../../../v2/durable-core/domain/assessment-consequence-event-builder.js';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import type { InternalError } from '../v2-error-mapping.js';
import type { AdvanceMode } from './index.js';
import { buildAndAppendPlan, buildArtifactOutputs } from './event-builders.js';
import type { AdvanceContext, ComputedAdvanceResults, AdvanceCorePorts } from './index.js';
import type { ValidatedAdvanceInputs } from './input-validation.js';

export function buildBlockedOutcome(args: {
  readonly mode: AdvanceMode;
  readonly snap: ExecutionSnapshotFileV1;
  readonly ctx: AdvanceContext;
  readonly computed: ComputedAdvanceResults;
  readonly v: ValidatedAdvanceInputs;
  readonly lock: WithHealthySessionLock;
  readonly ports: AdvanceCorePorts;
  readonly lockedIndex: SessionIndex;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { mode, snap, lock, ports } = args;
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash } = args.ctx;
  const { reasons, outputRequirement, validation } = args.computed;
  const { snapshotStore, sessionStore, sha256, idFactory } = ports;

  // Single source of truth: reasons = post-guardrail blocking reasons.
  // Use the same array for both blockers and primaryReason (architectural fix).
  const blockersRes = buildBlockerReport(reasons);
  if (blockersRes.isErr()) {
    return errAsync({ kind: 'invariant_violation' as const, message: blockersRes.error.message } as const);
  }

  const validationId = validation ? `validation_${String(attemptId)}` : undefined;
  const extraEventsToAppend: Array<Omit<DomainEventV1, 'eventIndex' | 'sessionId' | 'timestampMs'>> = [];
  if (validation && outputRequirement.kind !== 'not_required' && outputRequirement.kind !== 'satisfied') {
    const validationEventRes = buildValidationPerformedEvent({
      sessionId: String(sessionId),
      validationId: validationId!,
      attemptId: String(attemptId),
      contractRef: outputRequirement.contractRef,
      scope: { runId: String(runId), nodeId: String(currentNodeId) },
      minted: { eventId: idFactory.mintEventId() },
      result: validation,
    });
    if (validationEventRes.isErr()) {
      return errAsync({ kind: 'invariant_violation' as const, message: validationEventRes.error.message } as const);
    }
    extraEventsToAppend.push(validationEventRes.value);
  }
  const primaryReason = reasons[0];
  if (!primaryReason) {
    // Invariant: shouldBlockNow=true requires reasons.length > 0 (checked at call site).
    // If this fires, the shouldBlock logic is broken.
    return errAsync({ kind: 'invariant_violation' as const, message: 'shouldBlockNow=true requires at least one effective reason (post-guardrails)' } as const);
  }

  const blockedSnapshotRes = buildBlockedNodeSnapshot({
    priorSnapshot: snap,
    primaryReason,
    attemptId,
    validationRef: validationId,
    blockers: blockersRes.value,
    sha256,
  });
  if (blockedSnapshotRes.isErr()) {
    return errAsync({ kind: 'invariant_violation' as const, message: blockedSnapshotRes.error.message } as const);
  }

  const outputAppendResult = args.ctx.inputOutput?.artifacts
    ? (() => {
        const outputsRes = buildArtifactOutputs(args.ctx.inputOutput.artifacts, attemptId, sha256);
        if (outputsRes.isErr()) {
          return outputsRes;
        }
        return outputsRes;
      })()
    : undefined;
  if (outputAppendResult?.isErr()) {
    return errAsync(outputAppendResult.error);
  }
  const outputsToAppend =
    outputAppendResult && outputAppendResult.isOk()
      ? outputAppendResult.value
      : [];

  const validated = args.v;
  // Emit one assessment_recorded event per accepted assessment (one per assessmentRef).
  // recordedAssessments[i] and acceptedArtifacts[i] are positionally aligned — built in the same loop.
  const acceptedArtifacts = validated?.assessmentValidation?.acceptedArtifacts ?? [];
  for (let i = 0; i < acceptedArtifacts.length; i++) {
    const { artifactIndex } = acceptedArtifacts[i]!;
    const recordedAssessment = validated?.assessmentValidation?.recordedAssessments[i];
    if (!recordedAssessment) continue;

    const assessmentOutput = outputsToAppend[artifactIndex];
    if (!assessmentOutput || assessmentOutput.outputChannel !== 'artifact') {
      return errAsync({ kind: 'invariant_violation' as const, message: 'Accepted assessment artifact did not produce a matching artifact output on blocked path.' } as const);
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
      return errAsync({ kind: 'invariant_violation' as const, message: assessmentEventRes.error.message } as const);
    }
    extraEventsToAppend.push(assessmentEventRes.value);
  }

  if (validated?.triggeredAssessmentConsequence) {
    const consequenceEventRes = buildAssessmentConsequenceAppliedEvent({
      sessionId: String(sessionId),
      attemptId: String(attemptId),
      scope: { runId: String(runId), nodeId: String(currentNodeId) },
      assessmentId: validated.triggeredAssessmentConsequence.assessmentId,
      dimensionId: validated.triggeredAssessmentConsequence.firstMatchedDimensionId,
      level: validated.triggeredAssessmentConsequence.triggerLevel,
      guidance: validated.triggeredAssessmentConsequence.guidance,
      minted: { eventId: idFactory.mintEventId() },
    });
    if (consequenceEventRes.isErr()) {
      return errAsync({ kind: 'invariant_violation' as const, message: consequenceEventRes.error.message } as const);
    }
    extraEventsToAppend.push(consequenceEventRes.value);
  }

  return snapshotStore.putExecutionSnapshotV1(blockedSnapshotRes.value).andThen((blockedSnapshotRef) => {
    return buildAndAppendPlan({
      kind: 'blocked',
      truth, lockedIndex: args.lockedIndex, sessionId, runId, currentNodeId, attemptId, workflowHash,
      extraEventsToAppend, blockers: blockersRes.value, snapshotRef: blockedSnapshotRef,
      outputsToAppend,
      sessionStore, idFactory, lock,
    });
  });
}

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}
