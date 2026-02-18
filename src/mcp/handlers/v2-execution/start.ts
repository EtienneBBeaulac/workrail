import type { V2ToolContext } from '../../types.js';
import { V2StartWorkflowOutputSchema } from '../../output-schemas.js';
import { deriveIsComplete, derivePendingStep } from '../../../v2/durable-core/projections/snapshot-state.js';
import type { ExecutionSnapshotFileV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import { asDelimiterSafeIdV1 } from '../../../v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
import { createWorkflow } from '../../../types/workflow.js';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import {
  asWorkflowId,
  asSessionId,
  asRunId,
  asNodeId,
  type SessionId,
  type RunId,
  type NodeId,
  type WorkflowHash,
} from '../../../v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../v2/durable-core/ids/workflow-hash-ref.js';
import type { Sha256PortV2 } from '../../../v2/ports/sha256.port.js';
import type { TokenCodecPorts } from '../../../v2/durable-core/tokens/token-codec-ports.js';
import { ResultAsync as RA, okAsync, errAsync as neErrorAsync } from 'neverthrow';
import { compileV1WorkflowToPinnedSnapshot } from '../../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../../v2/durable-core/canonical/json-types.js';
import { anchorsToObservations, type ObservationEventData } from '../../../v2/durable-core/domain/observation-builder.js';
import { createBundledSource } from '../../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../../types/workflow-definition.js';
import {
  renderPendingPromptOrDefault,
  type StartWorkflowError,
} from '../v2-execution-helpers.js';
import * as z from 'zod';
import { newAttemptId, signTokenOrErr } from '../v2-token-ops.js';
import { mapWorkflowSourceKind, deriveNextIntent } from '../v2-state-conversion.js';
import { defaultPreferences } from '../v2-execution-helpers.js';
import { checkContextBudget } from '../v2-context-budget.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { buildNextCall } from './index.js';

/**
 * Load workflow, compile it, hash it, and pin to store for deterministic execution.
 */
export function loadAndPinWorkflow(args: {
  readonly workflowId: string;
  readonly workflowService: import('../../../application/services/workflow-service.js').WorkflowService;
  readonly crypto: Sha256PortV2;
  readonly pinnedStore: import('../../../v2/ports/pinned-workflow-store.port.js').PinnedWorkflowStorePortV2;
}): RA<{
  readonly workflow: import('../../../types/workflow.js').Workflow;
  readonly workflowHash: WorkflowHash;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly firstStep: { readonly id: string };
}, StartWorkflowError> {
  const { workflowId, workflowService, crypto, pinnedStore } = args;

  return RA.fromPromise(workflowService.getWorkflowById(workflowId), (e) => ({
    kind: 'precondition_failed' as const,
    message: e instanceof Error ? e.message : String(e),
  }))
    .andThen((workflow): RA<{ workflow: import('../../../types/workflow.js').Workflow; firstStep: { readonly id: string } }, StartWorkflowError> => {
      if (!workflow) {
        return neErrorAsync({ kind: 'workflow_not_found' as const, workflowId: asWorkflowId(workflowId) });
      }
      const firstStep = workflow.definition.steps[0];
      if (!firstStep) {
        return neErrorAsync({ kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(workflowId) });
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
            });
          }
          const pinnedWorkflow = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());
          return okAsync({ workflow, firstStep, workflowHash, pinnedWorkflow });
        });
    });
}

/**
 * Build initial domain events for a new workflow session.
 * Includes session_created, run_started, node_created, preferences, context, and observations.
 */
export function buildInitialEvents(args: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly workflowId: string;
  readonly workflowHash: WorkflowHash;
  readonly workflowSourceKind: 'bundled' | 'user' | 'project' | 'remote' | 'plugin';
  readonly workflowSourceRef: string;
  readonly snapshotRef: import('../../../v2/durable-core/ids/index.js').SnapshotRef;
  readonly context: import('../../../v2/durable-core/canonical/json-types.js').JsonObject | undefined;
  readonly observations: readonly ObservationEventData[];
  readonly idFactory: { readonly mintEventId: () => string };
}): readonly DomainEventV1[] {
  const {
    sessionId,
    runId,
    nodeId,
    workflowId,
    workflowHash,
    workflowSourceKind,
    workflowSourceRef,
    snapshotRef,
    context,
    observations,
    idFactory,
  } = args;

  const evtSessionCreated = idFactory.mintEventId();
  const evtRunStarted = idFactory.mintEventId();
  const evtNodeCreated = idFactory.mintEventId();
  const evtPreferencesChanged = idFactory.mintEventId();
  const changeId = idFactory.mintEventId();

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
        workflowId,
        workflowHash,
        workflowSourceKind,
        workflowSourceRef,
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

  const mutableEvents: DomainEventV1[] = [...baseEvents];

  // Emit context_set if initial context provided (S8: context persistence)
  if (context) {
    const evtContextSet = idFactory.mintEventId();
    const contextId = idFactory.mintEventId();
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
        context: context as unknown as JsonValue,
        source: 'initial' as const,
      },
    } as DomainEventV1);
  }

  // Emit observation_recorded events for workspace anchors (WU2: observability)
  // Note: observation_recorded has no scope (session-level, not run/node-level).
  // Omit the scope field entirely rather than setting to undefined -- JCS rejects undefined.
  for (const obs of observations) {
    const obsEventId = idFactory.mintEventId();
    mutableEvents.push({
      v: 1,
      eventId: obsEventId,
      eventIndex: mutableEvents.length,
      sessionId,
      kind: EVENT_KIND.OBSERVATION_RECORDED,
      dedupeKey: `observation_recorded:${sessionId}:${obs.key}`,
      data: {
        key: obs.key,
        value: obs.value,
        confidence: obs.confidence,
      },
    } as DomainEventV1);
  }

  return mutableEvents;
}

/**
 * Mint state, ack, and checkpoint tokens for a new workflow session.
 */
export function mintStartTokens(args: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: import('../../../v2/durable-core/tokens/index.js').AttemptId;
  readonly workflowHashRef: import('../../../v2/durable-core/ids/index.js').WorkflowHashRef;
  readonly ports: TokenCodecPorts;
}): RA<{
  readonly stateToken: string;
  readonly ackToken: string;
  readonly checkpointToken: string;
}, StartWorkflowError> {
  const { sessionId, runId, nodeId, attemptId, workflowHashRef, ports } = args;

  const statePayload = {
    tokenVersion: 1 as const,
    tokenKind: 'state' as const,
    sessionId,
    runId,
    nodeId,
    workflowHashRef,
  };

  const ackPayload = {
    tokenVersion: 1 as const,
    tokenKind: 'ack' as const,
    sessionId,
    runId,
    nodeId,
    attemptId,
  };

  const checkpointPayload = {
    tokenVersion: 1 as const,
    tokenKind: 'checkpoint' as const,
    sessionId,
    runId,
    nodeId,
    attemptId,
  };

  const stateTokenRes = signTokenOrErr({ payload: statePayload, ports });
  if (stateTokenRes.isErr()) {
    return neErrorAsync({ kind: 'token_signing_failed' as const, cause: stateTokenRes.error });
  }

  const ackTokenRes = signTokenOrErr({ payload: ackPayload, ports });
  if (ackTokenRes.isErr()) {
    return neErrorAsync({ kind: 'token_signing_failed' as const, cause: ackTokenRes.error });
  }

  const checkpointTokenRes = signTokenOrErr({ payload: checkpointPayload, ports });
  if (checkpointTokenRes.isErr()) {
    return neErrorAsync({ kind: 'token_signing_failed' as const, cause: checkpointTokenRes.error });
  }

  return okAsync({
    stateToken: stateTokenRes.value,
    ackToken: ackTokenRes.value,
    checkpointToken: checkpointTokenRes.value,
  });
}

export function executeStartWorkflow(
  input: import('../../v2/tools.js').V2StartWorkflowInput,
  ctx: V2ToolContext
): RA<z.infer<typeof V2StartWorkflowOutputSchema>, StartWorkflowError> {
  const { gate, sessionStore, snapshotStore, pinnedStore, crypto, tokenCodecPorts, idFactory } = ctx.v2;

  const ctxCheck = checkContextBudget({ tool: 'start_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  // 1. Load and pin workflow
  return loadAndPinWorkflow({
    workflowId: input.workflowId,
    workflowService: ctx.workflowService,
    crypto,
    pinnedStore,
  })
    .andThen(({ workflow, firstStep, workflowHash, pinnedWorkflow }) => {
      // 2. Resolve workspace anchors for observation events (graceful: empty on failure)
      const workspaceAnchor = ctx.v2?.workspaceAnchor;
      const anchorsRA: RA<readonly ObservationEventData[], never> = workspaceAnchor
        ? workspaceAnchor.resolveAnchors()
            .map((anchors) => anchorsToObservations(anchors))
            .orElse(() => okAsync([] as readonly ObservationEventData[]))
        : okAsync([] as readonly ObservationEventData[]);

      return anchorsRA.andThen((observations) => {
        // 3. Mint IDs and create initial snapshot
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

        // 4. Store snapshot and append events
        return snapshotStore.putExecutionSnapshotV1(snapshot)
          .mapErr((cause) => ({ kind: 'snapshot_creation_failed' as const, cause }))
          .andThen((snapshotRef) => {
            const workflowSourceRef =
              workflow.source.kind === 'user' || workflow.source.kind === 'project' || workflow.source.kind === 'custom'
                ? workflow.source.directoryPath
                : workflow.source.kind === 'git'
                  ? `${workflow.source.repositoryUrl}#${workflow.source.branch}`
                  : workflow.source.kind === 'remote'
                    ? workflow.source.registryUrl
                    : workflow.source.kind === 'plugin'
                      ? `${workflow.source.pluginName}@${workflow.source.pluginVersion}`
                      : '(bundled)';

            const events = buildInitialEvents({
              sessionId,
              runId,
              nodeId,
              workflowId: workflow.definition.id,
              workflowHash,
              workflowSourceKind: mapWorkflowSourceKind(workflow.source.kind),
              workflowSourceRef,
              snapshotRef,
              context: input.context as import('../../../v2/durable-core/canonical/json-types.js').JsonObject | undefined,
              observations,
              idFactory,
            });

            return gate.withHealthySessionLock(sessionId, (lock) =>
              sessionStore.append(lock, {
                events,
                snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: events[2]!.eventId }],
              })
            )
              .mapErr((cause) => ({ kind: 'session_append_failed' as const, cause }))
              .map(() => ({ workflow, firstStep, workflowHash, pinnedWorkflow, sessionId, runId, nodeId }));
          });
      });
    })
    .andThen(({ pinnedWorkflow, firstStep, workflowHash, sessionId, runId, nodeId }) => {
      // 5. Derive workflow hash ref
      const wfRefRes = deriveWorkflowHashRef(workflowHash);
      if (wfRefRes.isErr()) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: wfRefRes.error.message,
          suggestion: 'Ensure the pinned workflowHash is a valid sha256 digest.',
        });
      }

      // 6. Mint tokens
      const attemptId = newAttemptId(idFactory);
      return mintStartTokens({
        sessionId,
        runId,
        nodeId,
        attemptId,
        workflowHashRef: wfRefRes.value,
        ports: tokenCodecPorts,
      }).andThen((tokens) => {
        // 7. Render pending step and build response
        const meta = renderPendingPromptOrDefault({
          workflow: pinnedWorkflow,
          stepId: firstStep.id,
          loopPath: [],
          truth: { events: [], manifest: [] }, // start has no prior events
          runId: asRunId(String(runId)),
          nodeId: asNodeId(String(nodeId)),
          rehydrateOnly: false,
        });

        const pending = { stepId: meta.stepId, title: meta.title, prompt: meta.prompt };
        const preferences = defaultPreferences;
        const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: false, pending: meta });

        return okAsync(V2StartWorkflowOutputSchema.parse({
          stateToken: tokens.stateToken,
          ackToken: tokens.ackToken,
          checkpointToken: tokens.checkpointToken,
          isComplete: false,
          pending,
          preferences,
          nextIntent,
          nextCall: buildNextCall({ stateToken: tokens.stateToken, ackToken: tokens.ackToken, isComplete: false, pending }),
        }));
      });
    });
}
