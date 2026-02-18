import { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
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
  renderPendingPromptOrDefault,
  derivePreferencesOrDefault,
  type ContinueWorkflowError,
} from '../v2-execution-helpers.js';
import * as z from 'zod';
import { attemptIdForNextNode, signTokenOrErr } from '../v2-token-ops.js';
import { deriveNextIntent } from '../v2-state-conversion.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { buildNextCall } from './index.js';

/**
 * Build response for blocked outcome (no advance occurred).
 */
export function buildBlockedReplayResponse(args: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly blockers: import('../../../v2/durable-core/schemas/session/blockers.js').BlockerReportV1;
  readonly snapshot: ExecutionSnapshotFileV1 | null;
  readonly truth: LoadedSessionTruthV2;
  readonly workflow: ReturnType<typeof createWorkflow>;
  readonly inputStateToken: string;
  readonly inputAckToken: string;
  readonly ports: TokenCodecPorts;
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, never> {
  const { sessionId, runId, nodeId, attemptId, blockers, snapshot, truth, workflow, inputStateToken, inputAckToken, ports } = args;

  const pendingNow = snapshot ? derivePendingStep(snapshot.enginePayload.engineState) : null;
  const isCompleteNow = snapshot ? deriveIsComplete(snapshot.enginePayload.engineState) : false;

  // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
  const meta = pendingNow
    ? renderPendingPromptOrDefault({
        workflow,
        stepId: String(pendingNow.stepId),
        loopPath: pendingNow.loopPath,
        truth,
        runId: asRunId(String(runId)),
        nodeId: asNodeId(String(nodeId)),
        rehydrateOnly: false,
      })
    : null;

  const preferences = derivePreferencesOrDefault({ truth, runId, nodeId });
  const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: isCompleteNow, pending: meta });

  // Mint checkpoint token for replay (idempotent — same inputs produce same token)
  const replayCheckpointTokenRes = pendingNow
    ? signTokenOrErr({
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
        ports,
      })
    : ok(undefined);

  return okAsync(V2ContinueWorkflowOutputSchema.parse({
    kind: 'blocked',
    stateToken: inputStateToken,
    ackToken: inputAckToken,
    checkpointToken: replayCheckpointTokenRes.isOk() ? replayCheckpointTokenRes.value : undefined,
    isComplete: isCompleteNow,
    pending: meta ? { stepId: meta.stepId, title: meta.title, prompt: meta.prompt } : null,
    preferences,
    nextIntent,
    nextCall: buildNextCall({ stateToken: inputStateToken, ackToken: inputAckToken, isComplete: isCompleteNow, pending: meta }),
    blockers,
    retryable: undefined,
    retryAckToken: undefined,
    validation: loadValidationResultV1(truth.events, `validation_${String(attemptId)}`).unwrapOr(null) ?? undefined,
  }));
}

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
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const { sessionId, runId, toNodeId, attemptId, toSnapshot, workflow, truth, workflowHash, ports, sha256 } = args;
  
  const toNodeIdBranded = asNodeId(String(toNodeId));
  const pending = derivePendingStep(toSnapshot.enginePayload.engineState);
  const isComplete = deriveIsComplete(toSnapshot.enginePayload.engineState);

  const nextAttemptIdRes = attemptIdForNextNode(attemptId, sha256);
  if (nextAttemptIdRes.isErr()) {
    return neErrorAsync({ kind: 'invariant_violation' as const, message: `Failed to derive next attemptId: ${nextAttemptIdRes.error.message}` });
  }
  const nextAttemptId = nextAttemptIdRes.value;
  
  const nextAckTokenRes = pending
    ? signTokenOrErr({
        payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId: toNodeIdBranded, attemptId: nextAttemptId },
        ports,
      })
    : ok(undefined);
  if (nextAckTokenRes.isErr()) {
    return neErrorAsync({ kind: 'token_signing_failed' as const, cause: nextAckTokenRes.error });
  }

  // Mint checkpoint token (available when there's a pending step)
  const nextCheckpointTokenRes = pending
    ? signTokenOrErr({
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId: toNodeIdBranded, attemptId: nextAttemptId },
        ports,
      })
    : ok(undefined);
  if (nextCheckpointTokenRes.isErr()) {
    return neErrorAsync({ kind: 'token_signing_failed' as const, cause: nextCheckpointTokenRes.error });
  }

  const wfRefRes = deriveWorkflowHashRef(workflowHash);
  if (wfRefRes.isErr()) {
    return neErrorAsync({ kind: 'precondition_failed' as const, message: wfRefRes.error.message, suggestion: 'Ensure workflowHash is a valid sha256 digest.' });
  }
  const nextStateTokenRes = signTokenOrErr({
    payload: { tokenVersion: 1, tokenKind: 'state', sessionId, runId, nodeId: toNodeIdBranded, workflowHashRef: wfRefRes.value },
    ports,
  });
  if (nextStateTokenRes.isErr()) {
    return neErrorAsync({ kind: 'token_signing_failed' as const, cause: nextStateTokenRes.error });
  }

  if (toSnapshot.enginePayload.engineState.kind === 'blocked') {
    const blocked = toSnapshot.enginePayload.engineState.blocked;
    const blockers = blocked.blockers;
    const retryable = blocked.kind === 'retryable_block';
    const retryAckTokenRes = retryable
      ? signTokenOrErr({
          payload: {
            tokenVersion: 1,
            tokenKind: 'ack',
            sessionId,
            runId,
            nodeId: toNodeIdBranded,
            attemptId: asAttemptId(String(blocked.retryAttemptId)),
          },
          ports,
        })
      : ok(undefined);
    if (retryAckTokenRes.isErr()) {
      return neErrorAsync({ kind: 'token_signing_failed' as const, cause: retryAckTokenRes.error });
    }
    const validation = loadValidationResultV1(truth.events, String(blocked.validationRef)).unwrapOr(null) ?? undefined;

    // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
    const meta = pending
      ? renderPendingPromptOrDefault({
          workflow,
          stepId: String(pending.stepId),
          loopPath: pending.loopPath,
          truth,
          runId: asRunId(String(runId)),
          nodeId: asNodeId(String(toNodeIdBranded)),
          rehydrateOnly: false,
        })
      : null;

    const preferences = derivePreferencesOrDefault({ truth, runId, nodeId: toNodeIdBranded });
    const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete, pending: meta });

    return okAsync(
      V2ContinueWorkflowOutputSchema.parse({
        kind: 'blocked',
        stateToken: nextStateTokenRes.value,
        ackToken: pending ? nextAckTokenRes.value : undefined,
        checkpointToken: pending ? nextCheckpointTokenRes.value : undefined,
        isComplete,
        pending: meta ? { stepId: meta.stepId, title: meta.title, prompt: meta.prompt } : null,
        preferences,
        nextIntent,
        nextCall: buildNextCall({ stateToken: nextStateTokenRes.value, ackToken: pending ? nextAckTokenRes.value : undefined, isComplete, pending: meta, retryable, retryAckToken: retryAckTokenRes.value }),
        blockers,
        retryable,
        retryAckToken: retryAckTokenRes.value,
        validation,
      })
    );
  }

  // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
  const meta = pending
    ? renderPendingPromptOrDefault({
        workflow,
        stepId: String(pending.stepId),
        loopPath: pending.loopPath,
        truth,
        runId: asRunId(String(runId)),
        nodeId: asNodeId(String(toNodeIdBranded)),
        rehydrateOnly: false,
      })
    : { stepId: '', title: '', prompt: '', requireConfirmation: false };

  const preferences = derivePreferencesOrDefault({ truth, runId, nodeId: toNodeIdBranded });
  const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete, pending: pending ? meta : null });

  return okAsync(
    V2ContinueWorkflowOutputSchema.parse({
      kind: 'ok',
      stateToken: nextStateTokenRes.value,
      ackToken: pending ? nextAckTokenRes.value : undefined,
      checkpointToken: pending ? nextCheckpointTokenRes.value : undefined,
      isComplete,
      pending: pending ? { stepId: meta.stepId, title: meta.title, prompt: meta.prompt } : null,
      preferences,
      nextIntent,
      nextCall: buildNextCall({ stateToken: nextStateTokenRes.value, ackToken: pending ? nextAckTokenRes.value : undefined, isComplete, pending: pending ? meta : null }),
    })
  );
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
  readonly inputStateToken: string;
  readonly inputAckToken: string;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly snapshotStore: import('../../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly tokenCodecPorts: TokenCodecPorts;
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const {
    recordedEvent,
    truth,
    sessionId,
    runId,
    nodeId,
    workflowHash,
    attemptId,
    inputStateToken,
    inputAckToken,
    pinnedWorkflow,
    snapshotStore,
    sha256,
    tokenCodecPorts,
  } = args;

  // Backward-compat: replay old sessions that used advance_recorded.outcome.kind='blocked'
  // (deprecated by ADR 008 — new advances create blocked_attempt nodes instead).
  // Keep until all persisted sessions have been migrated or expired.
  if (recordedEvent.data.outcome.kind === 'blocked') {
    const blockers = recordedEvent.data.outcome.blockers;
    const snapNode = truth.events.find(
      (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
        e.kind === EVENT_KIND.NODE_CREATED && e.scope?.nodeId === String(nodeId)
    );

    const snapRA = snapNode
      ? snapshotStore.getExecutionSnapshotV1(snapNode.data.snapshotRef).mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
      : okAsync(null);

    return snapRA.andThen((snapshot) => buildBlockedReplayResponse({
      sessionId,
      runId,
      nodeId,
      attemptId,
      blockers,
      snapshot,
      truth,
      workflow: pinnedWorkflow,
      inputStateToken,
      inputAckToken,
      ports: tokenCodecPorts,
    }));
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
      });
    });
}
