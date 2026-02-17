import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
import { deriveIsComplete, derivePendingStep } from '../../../v2/durable-core/projections/snapshot-state.js';
import { createWorkflow } from '../../../types/workflow.js';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import {
  asSessionId,
  asRunId,
  asNodeId,
  type SessionId,
  type RunId,
  type NodeId,
} from '../../../v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../v2/durable-core/ids/workflow-hash-ref.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { TokenCodecPorts } from '../../../v2/durable-core/tokens/token-codec-ports.js';
import { ResultAsync as RA, okAsync, errAsync as neErrorAsync } from 'neverthrow';
import { createBundledSource } from '../../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../../types/workflow-definition.js';
import {
  derivePreferencesOrDefault,
  type ContinueWorkflowError,
} from '../v2-execution-helpers.js';
import { renderPendingPrompt } from '../../../v2/durable-core/domain/prompt-renderer.js';
import * as z from 'zod';
import { newAttemptId, signTokenOrErr } from '../v2-token-ops.js';
import { deriveNextIntent } from '../v2-state-conversion.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { buildNextCall } from './index.js';

/**
 * Handle rehydrate intent: side-effect-free state restoration.
 * Returns current workflow state without advancing execution.
 */
export function handleRehydrateIntent(args: {
  readonly input: V2ContinueWorkflowInput;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly workflowHashRef: string;
  readonly truth: LoadedSessionTruthV2;
  readonly tokenCodecPorts: TokenCodecPorts;
  readonly pinnedStore: import('../../../v2/ports/pinned-workflow-store.port.js').PinnedWorkflowStorePortV2;
  readonly snapshotStore: import('../../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly idFactory: { readonly mintAttemptId: () => import('../../../v2/durable-core/tokens/index.js').AttemptId };
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const { input, sessionId, runId, nodeId, workflowHashRef, truth, tokenCodecPorts, pinnedStore, snapshotStore, idFactory } = args;

  const runStarted = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'run_started' }> => e.kind === EVENT_KIND.RUN_STARTED && e.scope.runId === String(runId)
  );
  const workflowId = runStarted?.data.workflowId;
  if (!runStarted || typeof workflowId !== 'string' || workflowId.trim() === '') {
    return neErrorAsync({
      kind: 'token_unknown_node' as const,
      message: 'No durable run state was found for this stateToken (missing run_started).',
      suggestion: 'Use start_workflow to mint a new run, or use a stateToken returned by WorkRail for an existing run.',
    });
  }
  const workflowHash = runStarted.data.workflowHash;
  const expectedRefRes = deriveWorkflowHashRef(workflowHash);
  if (expectedRefRes.isErr()) {
    return neErrorAsync({
      kind: 'precondition_failed' as const,
      message: expectedRefRes.error.message,
      suggestion: 'Re-pin the workflow via start_workflow.',
    });
  }
  if (String(expectedRefRes.value) !== String(workflowHashRef)) {
    return neErrorAsync({ kind: 'precondition_failed' as const, message: 'workflowHash mismatch for this run.', suggestion: 'Use the stateToken returned by WorkRail for this run.' });
  }

  const nodeCreated = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === EVENT_KIND.NODE_CREATED && e.scope.nodeId === String(nodeId) && e.scope.runId === String(runId)
  );
  if (!nodeCreated) {
    return neErrorAsync({
      kind: 'token_unknown_node' as const,
      message: 'No durable node state was found for this stateToken (missing node_created).',
      suggestion: 'Use a stateToken returned by WorkRail for an existing node.',
    });
  }
  const expectedNodeRefRes = deriveWorkflowHashRef(nodeCreated.data.workflowHash);
  if (expectedNodeRefRes.isErr()) {
    return neErrorAsync({
      kind: 'precondition_failed' as const,
      message: expectedNodeRefRes.error.message,
      suggestion: 'Re-pin the workflow via start_workflow.',
    });
  }
  if (String(expectedNodeRefRes.value) !== String(workflowHashRef)) {
    return neErrorAsync({ kind: 'precondition_failed' as const, message: 'workflowHash mismatch for this node.', suggestion: 'Use the stateToken returned by WorkRail for this node.' });
  }

  return snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef)
    .mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
    .andThen((snapshot) => {
      if (!snapshot) {
        return neErrorAsync({
          kind: 'token_unknown_node' as const,
          message: 'No execution snapshot was found for this node.',
          suggestion: 'Use a stateToken returned by WorkRail for an existing node.',
        });
      }

      const engineState = snapshot.enginePayload.engineState;
      const pending = derivePendingStep(engineState);
      const isComplete = deriveIsComplete(engineState);

      if (!pending) {
        const preferences = derivePreferencesOrDefault({ truth, runId, nodeId });
        const nextIntent = deriveNextIntent({ rehydrateOnly: true, isComplete, pending: null });

        return okAsync(V2ContinueWorkflowOutputSchema.parse({
          kind: 'ok',
          stateToken: input.stateToken,
          isComplete,
          pending: null,
          preferences,
          nextIntent,
          nextCall: buildNextCall({ stateToken: input.stateToken, ackToken: undefined, isComplete, pending: null }),
        }));
      }

      const attemptId = newAttemptId(idFactory);
      const ackTokenRes = signTokenOrErr({
        payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId, attemptId },
        ports: tokenCodecPorts,
      });
      if (ackTokenRes.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: ackTokenRes.error });

      // Mint checkpoint token for rehydrate (available when pending step exists)
      const checkpointTokenRes = signTokenOrErr({
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
        ports: tokenCodecPorts,
      });
      if (checkpointTokenRes.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: checkpointTokenRes.error });

      return pinnedStore.get(workflowHash)
        .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
        .andThen((pinned) => {
          if (!pinned) return neErrorAsync({ kind: 'pinned_workflow_missing' as const, workflowHash });
          if (pinned.sourceKind !== 'v1_pinned') return neErrorAsync({ kind: 'precondition_failed' as const, message: 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.' });
          if (!hasWorkflowDefinitionShape(pinned.definition)) {
            return neErrorAsync({
              kind: 'precondition_failed' as const,
              message: 'Pinned workflow snapshot has an invalid workflow definition shape.',
              suggestion: 'Re-pin the workflow via start_workflow.',
            });
          }
          
          const wf = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());
          
          // S9: Use renderPendingPrompt (includes recap recovery + function expansion)
          const metaRes = renderPendingPrompt({
            workflow: wf,
            stepId: String(pending.stepId),
            loopPath: pending.loopPath,
            truth,
            runId: asRunId(String(runId)),
            nodeId: asNodeId(String(nodeId)),
            rehydrateOnly: true,
          });
          
          if (metaRes.isErr()) {
            return neErrorAsync({
              kind: 'invariant_violation' as const,
              message: `Prompt rendering failed: ${metaRes.error.message}`,
              suggestion: 'Retry; if this persists, treat as invariant violation.',
            });
          }
          
          const meta = metaRes.value;

          const preferences = derivePreferencesOrDefault({ truth, runId, nodeId });
          const nextIntent = deriveNextIntent({ rehydrateOnly: true, isComplete, pending: meta });

          return okAsync(V2ContinueWorkflowOutputSchema.parse({
            kind: 'ok',
            stateToken: input.stateToken,
            ackToken: ackTokenRes.value,
            checkpointToken: checkpointTokenRes.value,
            isComplete,
            pending: { stepId: meta.stepId, title: meta.title, prompt: meta.prompt },
            preferences,
            nextIntent,
            nextCall: buildNextCall({ stateToken: input.stateToken, ackToken: ackTokenRes.value, isComplete, pending: meta }),
          }));
        });
    });
}
