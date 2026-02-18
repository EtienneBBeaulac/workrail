import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
import { createWorkflow } from '../../../types/workflow.js';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import {
  asAttemptId,
  type AttemptId,
} from '../../../v2/durable-core/tokens/index.js';
import {
  type SessionId,
  type RunId,
  type NodeId,
} from '../../../v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../v2/durable-core/ids/workflow-hash-ref.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../../v2/ports/snapshot-store.port.js';
import type { Sha256PortV2 } from '../../../v2/ports/sha256.port.js';
import type { TokenCodecPorts } from '../../../v2/durable-core/tokens/token-codec-ports.js';
import { ResultAsync as RA, okAsync, errAsync as neErrorAsync } from 'neverthrow';
import type { JsonValue } from '../../../v2/durable-core/canonical/json-types.js';
import { createBundledSource } from '../../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../../types/workflow-definition.js';
import { type ContinueWorkflowError } from '../v2-execution-helpers.js';
import * as z from 'zod';
import { type InternalError, isInternalError } from '../v2-error-mapping.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { replayFromRecordedAdvance } from './replay.js';
import { advanceAndRecord } from './advance.js';
import type { ExecutionSessionGateErrorV2 } from '../../../v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';

/**
 * Handle advance intent: execute next step and record the outcome.
 * Acquires a session lock and advances the workflow state.
 */
export function handleAdvanceIntent(args: {
  readonly input: V2ContinueWorkflowInput;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly workflowHashRef: string;
  readonly truth: LoadedSessionTruthV2;
  readonly gate: import('../../../v2/usecases/execution-session-gate.js').ExecutionSessionGateV2;
  readonly sessionStore: import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2 & import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2;
  readonly snapshotStore: import('../../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly pinnedStore: import('../../../v2/ports/pinned-workflow-store.port.js').PinnedWorkflowStorePortV2;
  readonly tokenCodecPorts: TokenCodecPorts;
  readonly idFactory: { readonly mintNodeId: () => NodeId; readonly mintEventId: () => string };
  readonly sha256: Sha256PortV2;
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const { input, sessionId, runId, nodeId, attemptId, workflowHashRef, truth, gate, sessionStore, snapshotStore, pinnedStore, tokenCodecPorts, idFactory, sha256 } = args;

  const dedupeKey = `advance_recorded:${sessionId}:${nodeId}:${attemptId}`;

  const runStarted = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'run_started' }> => e.kind === EVENT_KIND.RUN_STARTED && e.scope.runId === String(runId)
  );
  if (!runStarted) {
    return neErrorAsync({
      kind: 'token_unknown_node' as const,
      message: 'No durable run state was found for this token (missing run_started).',
      suggestion: 'Use start_workflow to mint a new run, or use tokens returned by WorkRail for an existing run.',
    });
  }
  const workflowHash = runStarted.data.workflowHash;
  const refRes = deriveWorkflowHashRef(workflowHash);
  if (refRes.isErr()) {
    return neErrorAsync({
      kind: 'precondition_failed' as const,
      message: refRes.error.message,
      suggestion: 'Re-pin the workflow via start_workflow.',
    });
  }
  if (String(refRes.value) !== String(workflowHashRef)) {
    return neErrorAsync({
      kind: 'precondition_failed' as const,
      message: 'workflowHash mismatch for this run.',
      suggestion: 'Use the stateToken returned by WorkRail for this run.',
    });
  }

  const nodeCreated = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === EVENT_KIND.NODE_CREATED && e.scope.nodeId === String(nodeId) && e.scope.runId === String(runId)
  );
  if (!nodeCreated) {
    return neErrorAsync({
      kind: 'token_unknown_node' as const,
      message: 'No durable node state was found for this token (missing node_created).',
      suggestion: 'Use tokens returned by WorkRail for an existing node.',
    });
  }
  const nodeRefRes = deriveWorkflowHashRef(nodeCreated.data.workflowHash);
  if (nodeRefRes.isErr()) {
    return neErrorAsync({
      kind: 'precondition_failed' as const,
      message: nodeRefRes.error.message,
      suggestion: 'Re-pin the workflow via start_workflow.',
    });
  }
  if (String(nodeRefRes.value) !== String(workflowHashRef)) {
    return neErrorAsync({
      kind: 'precondition_failed' as const,
      message: 'workflowHash mismatch for this node.',
      suggestion: 'Use the stateToken returned by WorkRail for this node.',
    });
  }

  const existing = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'advance_recorded' }> => e.kind === EVENT_KIND.ADVANCE_RECORDED && e.dedupeKey === dedupeKey
  );

  return pinnedStore.get(workflowHash)
    .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
    .andThen((compiled) => {
      if (!compiled) return neErrorAsync({ kind: 'pinned_workflow_missing' as const, workflowHash });
      if (compiled.sourceKind !== 'v1_pinned') return neErrorAsync({ kind: 'precondition_failed' as const, message: 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.' });
      if (!hasWorkflowDefinitionShape(compiled.definition)) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: 'Pinned workflow snapshot has an invalid workflow definition shape.',
          suggestion: 'Re-pin the workflow via start_workflow.',
        });
      }

      const pinnedWorkflow = createWorkflow(compiled.definition as WorkflowDefinition, createBundledSource());

      if (existing) {
        return replayFromRecordedAdvance({
          recordedEvent: existing,
          truth,
          sessionId,
          runId,
          nodeId,
          workflowHash,
          attemptId,
          inputStateToken: input.stateToken,
          inputAckToken: input.ackToken!,
          pinnedWorkflow,
          snapshotStore,
          sha256,
          tokenCodecPorts,
        });
      }

      // Acquire the lock only for the first-advance path. Re-check for existing facts under the lock to avoid
      // a race where another writer records advance_recorded after our initial read but before we acquire the lock.
      return gate
        .withHealthySessionLock(sessionId, (lock) =>
          sessionStore.load(sessionId).andThen((truthLocked) => {
            const existingLocked = truthLocked.events.find(
              (e): e is Extract<DomainEventV1, { kind: 'advance_recorded' }> =>
                e.kind === EVENT_KIND.ADVANCE_RECORDED && e.dedupeKey === dedupeKey
            );
            if (existingLocked) return okAsync({ kind: 'replay' as const, truth: truthLocked, recordedEvent: existingLocked });

            return advanceAndRecord({
              truth: truthLocked,
              sessionId,
              runId,
              nodeId,
              attemptId,
              workflowHash,
              dedupeKey,
              inputContext: input.context as JsonValue | undefined,
              inputOutput: input.output,
              lock,
              pinnedWorkflow,
              snapshotStore,
              sessionStore,
              sha256,
              idFactory,
            }).andThen(() =>
              sessionStore
                .load(sessionId)
                .map((truthAfter) => ({ kind: 'replay' as const, truth: truthAfter, recordedEvent: null }))
            );
          })
        )
        .mapErr((cause) => {
          if (isInternalError(cause)) {
            return {
              kind: 'invariant_violation' as const,
              message: `Advance failed due to internal error: ${cause.kind}`,
            };
          }
          if (typeof cause === 'object' && cause !== null && 'code' in cause) {
            const code = (cause as { code: string }).code;
            if (code.startsWith('SNAPSHOT_STORE_')) {
              return { kind: 'snapshot_load_failed' as const, cause: cause as SnapshotStoreError };
            }
            return { kind: 'advance_execution_failed' as const, cause: cause as ExecutionSessionGateErrorV2 | SessionEventLogStoreError };
          }
          return {
            kind: 'invariant_violation' as const,
            message: 'Advance failed with an unknown error shape.',
          };
        })
        .andThen((res) => {
          const truth2 = res.truth;
          const recordedEvent =
            res.recordedEvent ??
            truth2.events.find(
              (e): e is Extract<DomainEventV1, { kind: 'advance_recorded' }> =>
                e.kind === EVENT_KIND.ADVANCE_RECORDED && e.dedupeKey === dedupeKey
            );

          if (!recordedEvent) {
            return neErrorAsync({
              kind: 'invariant_violation' as const,
              message: 'Missing recorded advance outcome after successful append.',
            });
          }

          return replayFromRecordedAdvance({
            recordedEvent,
            truth: truth2,
            sessionId,
            runId,
            nodeId,
            workflowHash,
            attemptId,
            inputStateToken: input.stateToken,
            inputAckToken: input.ackToken!,
            pinnedWorkflow,
            snapshotStore,
            sha256,
            tokenCodecPorts,
          });
        });
    });
}
