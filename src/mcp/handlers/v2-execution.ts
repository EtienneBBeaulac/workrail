import type { ToolContext, ToolResult } from '../types.js';
import { error, success } from '../types.js';
import type { V2ContinueWorkflowInput, V2StartWorkflowInput } from '../v2/tools.js';
import { V2ContinueWorkflowOutputSchema, V2StartWorkflowOutputSchema } from '../output-schemas.js';
import { deriveIsComplete, derivePendingStep } from '../../v2/durable-core/projections/snapshot-state.js';
import type { ExecutionSnapshotFileV1 } from '../../v2/durable-core/schemas/execution-snapshot/index.js';
import { asDelimiterSafeIdV1 } from '../../v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
import {
  assertTokenScopeMatchesStateBinary,
  type AttemptId,
  asAttemptId,
} from '../../v2/durable-core/tokens/index.js';
import { createWorkflow } from '../../types/workflow.js';
import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';
import {
  asWorkflowId,
  asSessionId,
  asRunId,
  asNodeId,
  type SessionId,
  type RunId,
  type NodeId,
  type WorkflowHash,
} from '../../v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../v2/durable-core/ids/workflow-hash-ref.js';
import type { LoadedSessionTruthV2 } from '../../v2/ports/session-event-log-store.port.js';
import type { WithHealthySessionLock } from '../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { ExecutionSessionGateErrorV2 } from '../../v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../v2/ports/snapshot-store.port.js';
import type { Sha256PortV2 } from '../../v2/ports/sha256.port.js';
import type { TokenCodecPorts } from '../../v2/durable-core/tokens/token-codec-ports.js';
import { ResultAsync as RA, okAsync, errAsync as neErrorAsync, ok } from 'neverthrow';
import { compileV1WorkflowToPinnedSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { loadValidationResultV1 } from '../../v2/durable-core/domain/validation-loader.js';
import { renderPendingPrompt } from '../../v2/durable-core/domain/prompt-renderer.js';
import { anchorsToObservations, type ObservationEventData } from '../../v2/durable-core/domain/observation-builder.js';
import { createBundledSource } from '../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../types/workflow-definition.js';
import {
  mapStartWorkflowErrorToToolError,
  mapContinueWorkflowErrorToToolError,
  mapTokenDecodeErrorToToolError,
  type StartWorkflowError,
  type ContinueWorkflowError,
} from './v2-execution-helpers.js';
import * as z from 'zod';
import { parseStateTokenOrFail, parseAckTokenOrFail, newAttemptId, attemptIdForNextNode, signTokenOrErr } from './v2-token-ops.js';
import { type InternalError, isInternalError } from './v2-error-mapping.js';
import { mapWorkflowSourceKind, defaultPreferences, derivePreferencesForNode, deriveNextIntent } from './v2-state-conversion.js';
import { checkContextBudget } from './v2-context-budget.js';
import { executeAdvanceCore } from './v2-advance-core.js';
import { EVENT_KIND, OUTPUT_CHANNEL } from '../../v2/durable-core/constants.js';

/**
 * v2 Slice 3: token orchestration (`start_workflow` / `continue_workflow`).
 *
 * Locks (see `docs/design/v2-core-design-locks.md`):
 * - Token validation errors use the closed `TOKEN_*` set.
 * - Rehydrate is side-effect-free.
 * - Advance is idempotent and append-capable only under a witness.
 * - Replay is fact-returning (no recompute) and fail-closed on missing recorded facts.
 */

// ── nextCall builder ─────────────────────────────────────────────────
// Pure function: derives the pre-built continuation template from response values.
// Tells the agent exactly what to call when done — no memory of tool descriptions needed.

type NextCallTemplate = {
  readonly tool: 'continue_workflow';
  readonly params: {
    readonly intent: 'advance';
    readonly stateToken: string;
    readonly ackToken: string;
  };
};

export function buildNextCall(args: {
  readonly stateToken: string;
  readonly ackToken: string | undefined;
  readonly isComplete: boolean;
  readonly pending: { readonly stepId: string } | null;
  readonly retryable?: boolean;
  readonly retryAckToken?: string;
}): NextCallTemplate | null {
  // Workflow complete, nothing to call
  if (args.isComplete && !args.pending) return null;

  // Blocked retryable: use retryAckToken so agent retries with corrected output
  if (args.retryable && args.retryAckToken) {
    return {
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: args.stateToken, ackToken: args.retryAckToken },
    };
  }

  // Blocked non-retryable: agent can't proceed without user intervention
  if (!args.ackToken) return null;

  // Normal: advance with the ackToken from this response
  return {
    tool: 'continue_workflow',
    params: { intent: 'advance', stateToken: args.stateToken, ackToken: args.ackToken },
  };
}

/**
 * Replay response from recorded advance facts (idempotent path).
 * Fact-returning response: load recorded outcome and return from durable facts without recompute.
 */
function replayFromRecordedAdvance(args: {
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
  readonly snapshotStore: import('../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
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

  if (recordedEvent.data.outcome.kind === 'blocked') {
    const blockers = recordedEvent.data.outcome.blockers;
    const snapNode = truth.events.find(
      (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
        e.kind === EVENT_KIND.NODE_CREATED && e.scope?.nodeId === String(nodeId)
    );

    const snapRA = snapNode
      ? snapshotStore.getExecutionSnapshotV1(snapNode.data.snapshotRef).mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
      : okAsync(null);

    return snapRA.map((snap) => {
      const pendingNow = snap ? derivePendingStep(snap.enginePayload.engineState) : null;
      const isCompleteNow = snap ? deriveIsComplete(snap.enginePayload.engineState) : false;

      // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
      const meta = pendingNow
        ? renderPendingPrompt({
            workflow: pinnedWorkflow,
            stepId: String(pendingNow.stepId),
            loopPath: pendingNow.loopPath,
            truth,
            runId: asRunId(String(runId)),
            nodeId: asNodeId(String(nodeId)),
            rehydrateOnly: false,
          }).unwrapOr({
            stepId: String(pendingNow.stepId),
            title: String(pendingNow.stepId),
            prompt: `Pending step: ${String(pendingNow.stepId)}`,
            requireConfirmation: false,
          })
        : null;

      const preferences = derivePreferencesForNode({ truth, runId, nodeId });
      const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: isCompleteNow, pending: meta });

      // Mint checkpoint token for replay (idempotent — same inputs produce same token)
      const replayCheckpointTokenRes = pendingNow
        ? signTokenOrErr({
            payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
            ports: tokenCodecPorts,
          })
        : ok(undefined);

      return V2ContinueWorkflowOutputSchema.parse({
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
      });
    });
  }

  const toNodeId = recordedEvent.data.outcome.toNodeId;
  const toNodeIdBranded = asNodeId(String(toNodeId));
  const toNode = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === EVENT_KIND.NODE_CREATED && e.scope?.nodeId === String(toNodeId)
  );
  if (!toNode) {
    return neErrorAsync({
      kind: 'invariant_violation' as const,
      message: 'Missing node_created for advanced toNodeId (invariant violation).',
      suggestion: 'Retry; if this persists, treat as invariant violation.',
    });
  }

  return snapshotStore
    .getExecutionSnapshotV1(toNode.data.snapshotRef)
    .mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
    .andThen((snap) => {
      if (!snap) {
        return neErrorAsync({
          kind: 'invariant_violation' as const,
          message: 'Missing execution snapshot for advanced node (invariant violation).',
          suggestion: 'Retry; if this persists, treat as invariant violation.',
        });
      }

      const pending = derivePendingStep(snap.enginePayload.engineState);
      const isComplete = deriveIsComplete(snap.enginePayload.engineState);

      const nextAttemptId = attemptIdForNextNode(attemptId, sha256);
      const nextAckTokenRes = pending
        ? signTokenOrErr({
            payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId: toNodeIdBranded, attemptId: nextAttemptId },
            ports: tokenCodecPorts,
          })
        : ok(undefined);
      if (nextAckTokenRes.isErr()) {
        return neErrorAsync({ kind: 'token_signing_failed' as const, cause: nextAckTokenRes.error });
      }

      // Mint checkpoint token (available when there's a pending step)
      const nextCheckpointTokenRes = pending
        ? signTokenOrErr({
            payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId: toNodeIdBranded, attemptId: nextAttemptId },
            ports: tokenCodecPorts,
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
        ports: tokenCodecPorts,
      });
      if (nextStateTokenRes.isErr()) {
        return neErrorAsync({ kind: 'token_signing_failed' as const, cause: nextStateTokenRes.error });
      }

      if (snap.enginePayload.engineState.kind === 'blocked') {
        const blocked = snap.enginePayload.engineState.blocked;
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
              ports: tokenCodecPorts,
            })
          : ok(undefined);
        if (retryAckTokenRes.isErr()) {
          return neErrorAsync({ kind: 'token_signing_failed' as const, cause: retryAckTokenRes.error });
        }
        const validation = loadValidationResultV1(truth.events, String(blocked.validationRef)).unwrapOr(null) ?? undefined;

        // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
        const meta = pending
          ? renderPendingPrompt({
              workflow: pinnedWorkflow,
              stepId: String(pending.stepId),
              loopPath: pending.loopPath,
              truth,
              runId: asRunId(String(runId)),
              nodeId: asNodeId(String(toNodeIdBranded)),
              rehydrateOnly: false,
            }).unwrapOr({
              stepId: String(pending.stepId),
              title: String(pending.stepId),
              prompt: `Pending step: ${String(pending.stepId)}`,
              requireConfirmation: false,
            })
          : null;

        const preferences = derivePreferencesForNode({ truth, runId, nodeId: toNodeIdBranded });
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
        ? renderPendingPrompt({
            workflow: pinnedWorkflow,
            stepId: String(pending.stepId),
            loopPath: pending.loopPath,
            truth,
            runId: asRunId(String(runId)),
            nodeId: asNodeId(String(toNodeIdBranded)),
            rehydrateOnly: false,
          }).unwrapOr({
            stepId: String(pending.stepId),
            title: String(pending.stepId),
            prompt: `Pending step: ${String(pending.stepId)}`,
            requireConfirmation: false,
          })
        : { stepId: '', title: '', prompt: '', requireConfirmation: false };

      const preferences = derivePreferencesForNode({ truth, runId, nodeId: toNodeIdBranded });
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
    });
}

/**
 * Compute next state, append events, and return success sentinel (first-advance path).
 * Executed under a healthy session lock witness.
 */
/**
 * Route advance requests: validate run/node existence, load snapshot,
 * then delegate to executeAdvanceCore with the appropriate AdvanceMode.
 *
 * This is a thin orchestrator — all business logic lives in v2-advance-core.ts.
 */
function advanceAndRecord(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly workflowHash: WorkflowHash;
  readonly dedupeKey: string;
  readonly inputContext: JsonValue | undefined;
  readonly inputOutput: V2ContinueWorkflowInput['output'];
  readonly lock: WithHealthySessionLock;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly snapshotStore: import('../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sessionStore: import('../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly idFactory: { readonly mintNodeId: () => NodeId; readonly mintEventId: () => string };
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { truth, sessionId, runId, nodeId, attemptId, workflowHash, dedupeKey, inputContext, inputOutput, lock, pinnedWorkflow, snapshotStore, sessionStore, sha256, idFactory } = args;

  // Enforce invariants: do not record advance attempts for unknown nodes.
  const hasRun = truth.events.some((e) => e.kind === EVENT_KIND.RUN_STARTED && e.scope?.runId === String(runId));
  const hasNode = truth.events.some(
    (e) => e.kind === EVENT_KIND.NODE_CREATED && e.scope?.runId === String(runId) && e.scope?.nodeId === String(nodeId)
  );
  if (!hasRun || !hasNode) {
    return neErrorAsync({ kind: 'missing_node_or_run' as const });
  }

  // Load current node snapshot to compute next state.
  const nodeCreated = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> => e.kind === EVENT_KIND.NODE_CREATED && e.scope?.nodeId === String(nodeId)
  );
  if (!nodeCreated) {
    return neErrorAsync({ kind: 'missing_node_or_run' as const });
  }
  if (String(nodeCreated.data.workflowHash) !== String(workflowHash)) {
    return neErrorAsync({ kind: 'workflow_hash_mismatch' as const });
  }

  return snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef).andThen((snap) => {
    if (!snap) return neErrorAsync({ kind: 'missing_snapshot' as const } as InternalError);
    const engineState = snap.enginePayload.engineState;

    // Route: blocked_attempt → retry mode, else → fresh mode
    if (nodeCreated.data.nodeKind === 'blocked_attempt') {
      if (engineState.kind !== 'blocked') {
        return neErrorAsync({ kind: 'invariant_violation' as const, message: 'blocked_attempt node requires engineState.kind=blocked' } as InternalError);
      }
      const blocked = engineState.blocked;
      if (blocked.kind !== 'retryable_block') {
        return neErrorAsync({
          kind: 'token_scope_mismatch' as const,
          message: 'Cannot retry a terminal blocked_attempt node (blocked.kind=terminal_block).',
        } as InternalError);
      }

      return executeAdvanceCore({
        mode: { kind: 'retry', blockedNodeId: nodeId, blockedSnapshot: snap },
        truth, sessionId, runId, attemptId, workflowHash, dedupeKey,
        inputContext, inputOutput, lock, pinnedWorkflow,
        ports: { snapshotStore, sessionStore, sha256, idFactory },
      });
    }

    // Fresh advance
    return executeAdvanceCore({
      mode: { kind: 'fresh', sourceNodeId: nodeId, snapshot: snap },
      truth, sessionId, runId, attemptId, workflowHash, dedupeKey,
      inputContext, inputOutput, lock, pinnedWorkflow,
      ports: { snapshotStore, sessionStore, sha256, idFactory },
    });
  });
}

export async function handleV2StartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  return executeStartWorkflow(input, ctx).match(
    (payload) => success(payload),
    (e) => mapStartWorkflowErrorToToolError(e)
  );
}

function executeStartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): RA<z.infer<typeof V2StartWorkflowOutputSchema>, StartWorkflowError> {
  if (!ctx.v2) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 tools disabled', suggestion: 'Enable v2Tools flag' });
  }

  const { gate, sessionStore, snapshotStore, pinnedStore, crypto, tokenCodecPorts, idFactory } = ctx.v2;
  if (!idFactory) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing idFactory',
      suggestion: 'Reinitialize v2 tool context (idFactory must be provided when v2Tools are enabled).',
    });
  }
  if (!tokenCodecPorts) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing tokenCodecPorts dependency',
      suggestion: 'Reinitialize v2 tool context (tokenCodecPorts must be provided when v2Tools are enabled).',
    });
  }

  const ctxCheck = checkContextBudget({ tool: 'start_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  return RA.fromPromise(ctx.workflowService.getWorkflowById(input.workflowId), (e) => ({
    kind: 'precondition_failed' as const,
    message: e instanceof Error ? e.message : String(e),
  }))
    .andThen((workflow) => {
      if (!workflow) {
        return neErrorAsync({ kind: 'workflow_not_found' as const, workflowId: asWorkflowId(input.workflowId) });
      }
      const firstStep = workflow.definition.steps[0];
      if (!firstStep) {
        return neErrorAsync({ kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(input.workflowId) });
      }
      return okAsync({ workflow, firstStep });
    })
    .andThen(({ workflow, firstStep }) => {
      // Pin the full v1 workflow definition for determinism.
      const compiled = compileV1WorkflowToPinnedSnapshot(workflow);
      const workflowHashRes = workflowHashForCompiledSnapshot(compiled as unknown as JsonValue, crypto);
      if (workflowHashRes.isErr()) {
        return neErrorAsync({ kind: 'hash_computation_failed' as const, message: workflowHashRes.error.message });
      }
      const workflowHash = workflowHashRes.value;

      return pinnedStore.get(workflowHash)
        .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
        .andThen((existingPinned) => {
          if (!existingPinned) {
            return pinnedStore.put(workflowHash, compiled)
              .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }));
          }
          return okAsync(undefined);
        })
        .andThen(() => pinnedStore.get(workflowHash).mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause })))
        .andThen((pinned) => {
          if (!pinned || pinned.sourceKind !== 'v1_pinned' || !hasWorkflowDefinitionShape(pinned.definition)) {
            return neErrorAsync({
              kind: 'invariant_violation' as const,
              message: 'Failed to pin executable workflow snapshot (missing or invalid pinned workflow).',
              suggestion: 'Retry start_workflow; if this persists, treat as invariant violation.',
            });
          }
          const pinnedWorkflow = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());
          return okAsync({ workflow, firstStep, workflowHash, pinnedWorkflow });
        });
    })
    .andThen(({ workflow, firstStep, workflowHash, pinnedWorkflow }) => {
      // Resolve workspace anchors for observation events (graceful: empty on failure)
      const workspaceAnchor = ctx.v2?.workspaceAnchor;
      const anchorsRA: RA<readonly ObservationEventData[], never> = workspaceAnchor
        ? workspaceAnchor.resolveAnchors()
            .map((anchors) => anchorsToObservations(anchors))
            .orElse(() => okAsync([] as readonly ObservationEventData[]))
        : okAsync([] as readonly ObservationEventData[]);

      return anchorsRA.andThen((observations) => {
      const sessionId = idFactory.mintSessionId();
      const runId = idFactory.mintRunId();
      const nodeId = idFactory.mintNodeId();

      const snapshot: ExecutionSnapshotFileV1 = {
        v: 1 as const,
        kind: 'execution_snapshot' as const,
        enginePayload: {
          v: 1 as const,
          engineState: {
            kind: 'running' as const,
            completed: { kind: 'set' as const, values: [] },
            loopStack: [],
            pending: { kind: 'some' as const, step: { stepId: asDelimiterSafeIdV1(firstStep.id), loopPath: [] } },
          },
        },
      };

      return snapshotStore.putExecutionSnapshotV1(snapshot)
        .mapErr((cause) => ({ kind: 'snapshot_creation_failed' as const, cause }))
        .andThen((snapshotRef) => {
          const evtSessionCreated = idFactory.mintEventId();
          const evtRunStarted = idFactory.mintEventId();
          const evtNodeCreated = idFactory.mintEventId();

          return gate.withHealthySessionLock(sessionId, (lock) => {
            const evtPreferencesChanged = idFactory.mintEventId();
            const changeId = idFactory.mintEventId();
            const evtContextSet = idFactory.mintEventId();
            const contextId = idFactory.mintEventId();

            const baseEvents: DomainEventV1[] = [
              {
                v: 1,
                eventId: evtSessionCreated,
                eventIndex: 0,
                sessionId,
                kind: EVENT_KIND.SESSION_CREATED,
                dedupeKey: `session_created:${sessionId}`,
                data: {},
              },
              {
                v: 1,
                eventId: evtRunStarted,
                eventIndex: 1,
                sessionId,
                kind: EVENT_KIND.RUN_STARTED,
                dedupeKey: `run_started:${sessionId}:${runId}`,
                scope: { runId },
                data: {
                  workflowId: workflow.definition.id,
                  workflowHash,
                  workflowSourceKind: mapWorkflowSourceKind(workflow.source.kind),
                  workflowSourceRef:
                    workflow.source.kind === 'user' || workflow.source.kind === 'project' || workflow.source.kind === 'custom'
                      ? workflow.source.directoryPath
                      : workflow.source.kind === 'git'
                        ? `${workflow.source.repositoryUrl}#${workflow.source.branch}`
                        : workflow.source.kind === 'remote'
                          ? workflow.source.registryUrl
                          : workflow.source.kind === 'plugin'
                            ? `${workflow.source.pluginName}@${workflow.source.pluginVersion}`
                            : '(bundled)',
                },
              },
              {
                v: 1,
                eventId: evtNodeCreated,
                eventIndex: 2,
                sessionId,
                kind: EVENT_KIND.NODE_CREATED,
                dedupeKey: `node_created:${sessionId}:${runId}:${nodeId}`,
                scope: { runId, nodeId },
                data: {
                  nodeKind: 'step' as const,
                  parentNodeId: null,
                  workflowHash,
                  snapshotRef,
                },
              },
              {
                v: 1,
                eventId: evtPreferencesChanged,
                eventIndex: 3,
                sessionId,
                kind: EVENT_KIND.PREFERENCES_CHANGED,
                dedupeKey: `preferences_changed:${sessionId}:${runId}:${nodeId}:${changeId}`,
                scope: { runId, nodeId },
                data: {
                  changeId,
                  source: 'system' as const,
                  delta: [
                    { key: 'autonomy' as const, value: defaultPreferences.autonomy },
                    { key: 'riskPolicy' as const, value: defaultPreferences.riskPolicy },
                  ],
                  effective: {
                    autonomy: defaultPreferences.autonomy,
                    riskPolicy: defaultPreferences.riskPolicy,
                  },
                },
              },
            ];

            // Build events array with dynamic indexing (base + context + observations)
            const mutableEvents: DomainEventV1[] = [...baseEvents];

            // Emit context_set if initial context provided (S8: context persistence)
            if (input.context) {
              mutableEvents.push({
                v: 1,
                eventId: evtContextSet,
                eventIndex: mutableEvents.length,
                sessionId,
                kind: EVENT_KIND.CONTEXT_SET,
                dedupeKey: `context_set:${sessionId}:${runId}:${contextId}`,
                scope: { runId },
                data: {
                  contextId,
                  context: input.context as unknown as JsonValue,
                  source: 'initial' as const,
                },
              } as DomainEventV1);
            }

            // Emit observation_recorded events for workspace anchors (WU2: observability)
            for (const obs of observations) {
              const obsEventId = idFactory.mintEventId();
              mutableEvents.push({
                v: 1,
                eventId: obsEventId,
                eventIndex: mutableEvents.length,
                sessionId,
                kind: EVENT_KIND.OBSERVATION_RECORDED,
                dedupeKey: `observation_recorded:${sessionId}:${obs.key}`,
                scope: undefined,
                data: {
                  key: obs.key,
                  value: obs.value,
                  confidence: obs.confidence,
                },
              } as DomainEventV1);
            }

            const eventsArray: readonly DomainEventV1[] = mutableEvents;

            return sessionStore.append(lock, {
              events: eventsArray,
              snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: evtNodeCreated }],
            });
          })
            .mapErr((cause) => ({ kind: 'session_append_failed' as const, cause }))
            .map(() => ({ workflow, firstStep, workflowHash, pinnedWorkflow, sessionId, runId, nodeId }));
        });
      }); // close anchorsRA.andThen
    })
    .andThen(({ pinnedWorkflow, firstStep, workflowHash, sessionId, runId, nodeId }) => {
      const wfRefRes = deriveWorkflowHashRef(workflowHash);
      if (wfRefRes.isErr()) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: wfRefRes.error.message,
          suggestion: 'Ensure the pinned workflowHash is a valid sha256 digest.',
        });
      }
      const statePayload = {
        tokenVersion: 1 as const,
        tokenKind: 'state' as const,
        sessionId,
        runId,
        nodeId,
        workflowHashRef: wfRefRes.value,
      };
      const attemptId = newAttemptId(idFactory);
      const ackPayload = {
        tokenVersion: 1 as const,
        tokenKind: 'ack' as const,
        sessionId,
        runId,
        nodeId,
        attemptId,
      };
      const stateToken = signTokenOrErr({ payload: statePayload, ports: tokenCodecPorts });
      if (stateToken.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: stateToken.error });
      
      const ackToken = signTokenOrErr({ payload: ackPayload, ports: tokenCodecPorts });
      if (ackToken.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: ackToken.error });

      // Mint checkpoint token (available from first step)
      const checkpointToken = signTokenOrErr({
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
        ports: tokenCodecPorts,
      });
      if (checkpointToken.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: checkpointToken.error });

      // S9: Use renderPendingPrompt for consistency (no recovery for start)
      const metaRes = renderPendingPrompt({
        workflow: pinnedWorkflow,
        stepId: firstStep.id,
        loopPath: [],
        truth: { events: [], manifest: [] }, // start has no prior events
                    runId: asRunId(String(runId)),
            nodeId: asNodeId(String(nodeId)),
            rehydrateOnly: false,
      });
      
      const meta = metaRes.isOk() ? metaRes.value : {
        stepId: firstStep.id,
        title: firstStep.title,
        prompt: firstStep.prompt,
        requireConfirmation: Boolean(firstStep.requireConfirmation),
      };
      
      const pending = { stepId: meta.stepId, title: meta.title, prompt: meta.prompt };

      const preferences = defaultPreferences;
      const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: false, pending: meta });

      return okAsync(V2StartWorkflowOutputSchema.parse({
        stateToken: stateToken.value,
        ackToken: ackToken.value,
        checkpointToken: checkpointToken.value,
        isComplete: false,
        pending,
        preferences,
        nextIntent,
        nextCall: buildNextCall({ stateToken: stateToken.value, ackToken: ackToken.value, isComplete: false, pending }),
      }));
    });
}

export async function handleV2ContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  return executeContinueWorkflow(input, ctx).match(
    (payload) => success(payload),
    (e) => mapContinueWorkflowErrorToToolError(e)
  );
}

function executeContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  if (!ctx.v2) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 tools disabled', suggestion: 'Enable v2Tools flag' });
  }

  const { gate, sessionStore, snapshotStore, pinnedStore, sha256, tokenCodecPorts, idFactory } = ctx.v2;
  if (!sha256 || !idFactory) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing required dependencies',
      suggestion: 'Reinitialize v2 tool context (sha256 and idFactory must be provided when v2Tools are enabled).',
    });
  }
  if (!tokenCodecPorts) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing tokenCodecPorts dependency',
      suggestion: 'Reinitialize v2 tool context (tokenCodecPorts must be provided when v2Tools are enabled).',
    });
  }

  const stateRes = parseStateTokenOrFail(input.stateToken, tokenCodecPorts);
  if (!stateRes.ok) return neErrorAsync({ kind: 'validation_failed', failure: stateRes.failure });
  const state = stateRes.token;

  const ctxCheck = checkContextBudget({ tool: 'continue_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  const sessionId = asSessionId(state.payload.sessionId);
  const runId = asRunId(state.payload.runId);
  const nodeId = asNodeId(state.payload.nodeId);
  const workflowHashRef = state.payload.workflowHashRef;

  if (input.intent === 'rehydrate') {
    // REHYDRATE PATH
    return sessionStore.load(sessionId)
      .mapErr((cause) => ({ kind: 'session_load_failed' as const, cause }))
      .andThen((truth) => {
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
              const preferences = derivePreferencesForNode({ truth, runId, nodeId });
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

                const preferences = derivePreferencesForNode({ truth, runId, nodeId });
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
      });
  }

  // ADVANCE PATH — ackToken is guaranteed present by Zod superRefine (intent === 'advance')
  if (!input.ackToken) {
    return neErrorAsync({ kind: 'validation_failed', failure: error('VALIDATION_ERROR', 'ackToken is required for advance intent') });
  }
  const ackRes = parseAckTokenOrFail(input.ackToken, tokenCodecPorts);
  if (!ackRes.ok) return neErrorAsync({ kind: 'validation_failed', failure: ackRes.failure });
  const ack = ackRes.token;

  const scopeRes = assertTokenScopeMatchesStateBinary(state, ack);
  if (scopeRes.isErr()) return neErrorAsync({ kind: 'validation_failed', failure: mapTokenDecodeErrorToToolError(scopeRes.error) });

  const attemptId = asAttemptId(ack.payload.attemptId);
  const dedupeKey = `advance_recorded:${sessionId}:${nodeId}:${attemptId}`;

  return sessionStore.load(sessionId)
    .mapErr((cause) => ({ kind: 'session_load_failed' as const, cause }))
    .andThen((truth) => {
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
                  message: `Advance failed due to internal invariant violation: ${cause.kind}`,
                  suggestion: 'Retry; if this persists, treat as invariant violation.',
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
                message: 'Advance failed with an unknown error shape (invariant violation).',
                suggestion: 'Retry; if this persists, treat as invariant violation.',
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
                  message: 'Missing recorded advance outcome after successful append (invariant violation).',
                  suggestion: 'Retry; if this persists, treat as invariant violation.',
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
    });
}

