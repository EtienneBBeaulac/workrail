import type { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
import { toPendingStep } from '../../output-schemas.js';
import { deriveIsComplete, derivePendingStep } from '../../../v2/durable-core/projections/snapshot-state.js';
import type { ExecutionSnapshotFileV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import {
  asAttemptId,
  type AttemptId,
} from '../../../v2/durable-core/tokens/index.js';
import { createWorkflow } from '../../../types/workflow.js';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import {
  asRunId,
  asNodeId,
  type SessionId,
  type RunId,
  type NodeId,
  type WorkflowHash,
} from '../../../v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../v2/durable-core/ids/workflow-hash-ref.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { Sha256PortV2 } from '../../../v2/ports/sha256.port.js';
import type { TokenCodecPorts } from '../../../v2/durable-core/tokens/token-codec-ports.js';
import { ResultAsync as RA, okAsync, errAsync as neErrorAsync, ok } from 'neverthrow';
import { loadValidationResultV1 } from '../../../v2/durable-core/domain/validation-loader.js';
import {
  derivePreferencesOrDefault,
  type ContinueWorkflowError,
} from '../v2-execution-helpers.js';
import { renderPendingPrompt, type StepMetadata } from '../../../v2/durable-core/domain/prompt-renderer.js';
import * as z from 'zod';
import { attemptIdForNextNode, mintContinueAndCheckpointTokens } from '../v2-token-ops.js';
import { deriveNextIntent } from '../v2-state-conversion.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { buildNextCall } from './index.js';
import { projectAssessmentsV2, getLatestAssessmentForNode } from '../../../v2/projections/assessments.js';
import { assertOutput, assertContinueTokenPresence } from '../../assert-output.js';



/**
 * Build response for advanced outcome (execution advanced to new node).
 */
export function buildAdvancedReplayResponse(args: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly fromNodeId: NodeId;
  readonly toNodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly toSnapshot: ExecutionSnapshotFileV1;
  readonly workflow: ReturnType<typeof createWorkflow>;
  readonly truth: LoadedSessionTruthV2;
  readonly workflowHash: WorkflowHash;
  readonly ports: TokenCodecPorts;
  readonly sha256: Sha256PortV2;
  readonly aliasStore: import('../../../v2/ports/token-alias-store.port.js').TokenAliasStorePortV2;
  readonly entropy: import('../../../v2/ports/random-entropy.port.js').RandomEntropyPortV2;
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const { sessionId, runId, fromNodeId, toNodeId, attemptId, toSnapshot, workflow, truth, workflowHash, ports, sha256, aliasStore, entropy } = args;
  
  const toNodeIdBranded = asNodeId(String(toNodeId));
  const pending = derivePendingStep(toSnapshot.enginePayload.engineState);
  const isComplete = deriveIsComplete(toSnapshot.enginePayload.engineState);

  const nextAttemptIdRes = attemptIdForNextNode(attemptId, sha256);
  if (nextAttemptIdRes.isErr()) {
    return neErrorAsync({ kind: 'invariant_violation' as const, message: `Failed to derive next attemptId: ${nextAttemptIdRes.error.message}` });
  }
  const nextAttemptId = nextAttemptIdRes.value;

  const wfRefRes = deriveWorkflowHashRef(workflowHash);
  if (wfRefRes.isErr()) {
    return neErrorAsync({ kind: 'precondition_failed' as const, message: wfRefRes.error.message, suggestion: 'Ensure workflowHash is a valid sha256 digest.' });
  }

  const entryBase = {
    sessionId: String(sessionId),
    runId: String(runId),
    nodeId: String(toNodeIdBranded),
    attemptId: String(nextAttemptId),
    workflowHashRef: String(wfRefRes.value),
  };

  const nextTokensMint: RA<{ continueToken: string; checkpointToken: string }, ContinueWorkflowError> =
    mintContinueAndCheckpointTokens({ entry: entryBase, ports, aliasStore, entropy })
      .mapErr((failure) => ({ kind: 'token_signing_failed' as const, cause: failure as never }));

  if (toSnapshot.enginePayload.engineState.kind === 'blocked') {
    const blocked = toSnapshot.enginePayload.engineState.blocked;
    const blockers = blocked.blockers;
    const retryable = blocked.kind === 'retryable_block';

    // Conditionally mint retryContinueToken (only for retryable blocks)
    const retryContinueMint: RA<string | undefined, ContinueWorkflowError> = retryable
      ? mintContinueAndCheckpointTokens({
          entry: {
            aliasSlot: 'retry',
            sessionId: String(sessionId),
            runId: String(runId),
            nodeId: String(toNodeIdBranded),
            attemptId: String(blocked.retryAttemptId),
            workflowHashRef: String(wfRefRes.value),
          },
          ports,
          aliasStore,
          entropy,
        }).map((tokens) => tokens.continueToken)
          .mapErr((failure) => ({ kind: 'token_signing_failed' as const, cause: failure as never }))
      : okAsync(undefined);

    const validation = loadValidationResultV1(truth.events, String(blocked.validationRef)).unwrapOr(null) ?? undefined;
    const assessmentFollowup =
      blocked.reason.kind === 'assessment_followup_required'
        ? {
            title: `Assessment follow-up matched ${blocked.reason.assessmentId}.${blocked.reason.dimensionId} == ${blocked.reason.level}`,
            guidance: blocked.reason.guidance,
          }
        : undefined;

    // S9: Render pending step — fail explicitly on missing step (no silent fallback)
    let blockedMeta: StepMetadata | null = null;
    if (pending) {
      const result = renderPendingPrompt({
        workflow,
        stepId: String(pending.stepId),
        loopPath: pending.loopPath,
        truth,
        runId: asRunId(String(runId)),
        nodeId: asNodeId(String(toNodeIdBranded)),
        rehydrateOnly: false,
      });
      if (result.isErr()) {
        return neErrorAsync({ kind: 'prompt_render_failed' as const, message: result.error.message });
      }
      blockedMeta = result.value;
    }

    const preferences = derivePreferencesOrDefault({ truth, runId, nodeId: toNodeIdBranded });
    const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete, pending: blockedMeta });

    // Pass the object literal directly into .parse() rather than first
    // assigning `const payload: z.infer<typeof V2ContinueWorkflowOutputSchema>
    // = {...}`. The direct form lets TypeScript narrow the discriminated-union
    // literal (`kind: 'blocked'`) inside the call-site expression without
    // requiring an explicit `as` cast. The `const payload: T = {...}` pattern
    // works for simple object shapes where no discriminant narrowing is needed.
    return nextTokensMint.andThen((nextTokens) =>
      retryContinueMint.andThen((retryContinueToken) => {
        // TypeScript requires `as` cast here for discriminated union literal narrowing;
        // `const payload: T = {...}` works for simple object shapes but not discriminated unions.
        const out = assertOutput(
          {
            kind: 'blocked' as const,
            continueToken: pending ? nextTokens.continueToken : undefined,
            checkpointToken: pending ? nextTokens.checkpointToken : undefined,
            isComplete,
            pending: toPendingStep(blockedMeta),
            preferences,
            nextIntent,
            nextCall: buildNextCall({ continueToken: pending ? nextTokens.continueToken : undefined, isComplete, pending: blockedMeta, retryContinueToken }),
            blockers,
            retryable,
            retryContinueToken,
            validation,
            assessmentFollowup,
          } as z.infer<typeof V2ContinueWorkflowOutputSchema>,
          assertContinueTokenPresence,
        );
        return okAsync(out);
      })
    );
  }

  // S9: Render pending step — fail explicitly on missing step (no silent fallback)
  let okMeta: StepMetadata | null = null;
  if (pending) {
    const result = renderPendingPrompt({
      workflow,
      stepId: String(pending.stepId),
      loopPath: pending.loopPath,
      truth,
      runId: asRunId(String(runId)),
      nodeId: asNodeId(String(toNodeIdBranded)),
      rehydrateOnly: false,
    });
    if (result.isErr()) {
      return neErrorAsync({ kind: 'prompt_render_failed' as const, message: result.error.message });
    }
    okMeta = result.value;
  }

  const preferences = derivePreferencesOrDefault({ truth, runId, nodeId: toNodeIdBranded });
  const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete, pending: okMeta });

  // Collect step-scoped execution facts for the step that just completed (fromNodeId).
  // Assessment was submitted and accepted on fromNodeId, not toNodeId.
  const stepContext = buildStepContext(truth.events, fromNodeId);

  return nextTokensMint.andThen((nextTokens) => {
    const out = assertOutput(
      {
        kind: 'ok' as const,
        continueToken: pending ? nextTokens.continueToken : undefined,
        checkpointToken: pending ? nextTokens.checkpointToken : undefined,
        isComplete,
        pending: toPendingStep(okMeta),
        preferences,
        nextIntent,
        nextCall: buildNextCall({ continueToken: pending ? nextTokens.continueToken : undefined, isComplete, pending: okMeta }),
        stepContext,
      } as z.infer<typeof V2ContinueWorkflowOutputSchema>,
      assertContinueTokenPresence,
    );
    return okAsync(out);
  });
}

/**
 * Build the stepContext for the completed node by projecting assessment events.
 * Returns undefined when no step-level facts were recorded (non-assessment steps).
 *
 * On projection error (malformed event log), logs a warning and returns undefined
 * rather than failing the advance — the durable event is authoritative; stepContext
 * is a convenience projection and must not block a successful advance.
 */
function buildStepContext(
  events: readonly DomainEventV1[],
  completedNodeId: NodeId,
): { assessments?: { assessmentId: string; dimensions: { dimensionId: string; level: string; rationale?: string }[]; normalizationNotes: readonly string[] } } | undefined {
  const projection = projectAssessmentsV2(events);
  if (projection.isErr()) {
    console.warn(`[workrail:replay] stepContext projection failed for node '${String(completedNodeId)}' — stepContext will be absent: ${projection.error.message}`);
    return undefined;
  }

  const recorded = getLatestAssessmentForNode(projection.value, String(completedNodeId));
  if (!recorded) return undefined;

  return {
    assessments: {
      assessmentId: recorded.assessmentId,
      dimensions: recorded.dimensions.map((d) => ({
        dimensionId: d.dimensionId,
        level: d.level,
        ...(d.rationale !== undefined ? { rationale: d.rationale } : {}),
      })),
      normalizationNotes: recorded.normalizationNotes,
    },
  };
}

/**
 * Replay response from recorded advance facts (idempotent path).
 * Fact-returning response: load recorded outcome and return from durable facts without recompute.
 */
export function replayFromRecordedAdvance(args: {
  readonly recordedEvent: Extract<DomainEventV1, { kind: 'advance_recorded' }>;
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly workflowHash: WorkflowHash;
  readonly attemptId: AttemptId;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly snapshotStore: import('../../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly tokenCodecPorts: TokenCodecPorts;
  readonly aliasStore: import('../../../v2/ports/token-alias-store.port.js').TokenAliasStorePortV2;
  readonly entropy: import('../../../v2/ports/random-entropy.port.js').RandomEntropyPortV2;
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const {
    recordedEvent,
    truth,
    sessionId,
    runId,
    nodeId,
    workflowHash,
    attemptId,
    pinnedWorkflow,
    snapshotStore,
    sha256,
    tokenCodecPorts,
    aliasStore,
    entropy,
  } = args;

  // Legacy blocked outcomes (deprecated by ADR 008) are treated as invariant violations
  if (recordedEvent.data.outcome.kind === 'blocked') {
    return neErrorAsync({
      kind: 'invariant_violation' as const,
      message: 'Legacy blocked advance_recorded outcomes are no longer supported. Sessions must be re-created.',
    });
  }

  // Advanced outcome
  const toNodeId = asNodeId(String(recordedEvent.data.outcome.toNodeId));
  const toNode = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === EVENT_KIND.NODE_CREATED && e.scope?.nodeId === String(toNodeId)
  );
  if (!toNode) {
    return neErrorAsync({
      kind: 'invariant_violation' as const,
      message: 'Missing node_created for advanced toNodeId.',
    });
  }

  return snapshotStore
    .getExecutionSnapshotV1(toNode.data.snapshotRef)
    .mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
    .andThen((toSnapshot) => {
      if (!toSnapshot) {
        return neErrorAsync({
          kind: 'invariant_violation' as const,
          message: 'Missing execution snapshot for advanced node.',
        });
      }

      return buildAdvancedReplayResponse({
        sessionId,
        runId,
        fromNodeId: nodeId,
        toNodeId,
        attemptId,
        toSnapshot,
        workflow: pinnedWorkflow,
        truth,
        workflowHash,
        ports: tokenCodecPorts,
        sha256,
        aliasStore,
        entropy,
      });
    });
}
