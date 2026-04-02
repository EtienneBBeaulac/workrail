import type { V2ToolContext } from '../../types.js';
import { V2StartWorkflowOutputSchema, toPendingStep } from '../../output-schemas.js';
import { deriveIsComplete, derivePendingStep } from '../../../v2/durable-core/projections/snapshot-state.js';
import type { ExecutionSnapshotFileV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import { asExpandedStepIdV1 } from '../../../v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
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
import { validateWorkflowPhase1a, type ValidationPipelineDepsPhase1a } from '../../../application/services/workflow-validation-pipeline.js';
import { workflowHashForCompiledSnapshot } from '../../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../../v2/durable-core/canonical/json-types.js';
import { anchorsToObservations, type ObservationEventData } from '../../../v2/durable-core/domain/observation-builder.js';
import { createBundledSource } from '../../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../../types/workflow-definition.js';
import type { CompiledWorkflowSnapshotV1 } from '../../../v2/durable-core/schemas/compiled-workflow/index.js';
import {
  type StartWorkflowError,
} from '../v2-execution-helpers.js';
import { renderPendingPrompt } from '../../../v2/durable-core/domain/prompt-renderer.js';
import { resolveWorkspaceAnchors } from '../v2-workspace-resolution.js';
import * as z from 'zod';
import { newAttemptId, mintContinueAndCheckpointTokens } from '../v2-token-ops.js';
import { mapWorkflowSourceKind, deriveNextIntent } from '../v2-state-conversion.js';
import { defaultPreferences } from '../v2-execution-helpers.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { buildNextCall } from './index.js';
import { resolveFirstStep } from '../../../v2/durable-core/domain/start-construction.js';
import { createWorkflowReaderForRequest, hasRequestWorkspaceSignal } from '../shared/request-workflow-reader.js';
import { buildStepContentEnvelope, type StepContentEnvelope, type ResolvedReference } from '../../step-content-envelope.js';
import { resolveBindingBaseDir } from '../v2-workspace-resolution.js';
import { resolveWorkflowReferences } from '../v2-reference-resolver.js';

/**
 * Result of executeStartWorkflow — includes both the public response and
 * the internal content envelope for the formatter.
 */
export interface StartWorkflowResult {
  readonly response: z.infer<typeof V2StartWorkflowOutputSchema>;
  readonly contentEnvelope: StepContentEnvelope;
}

/**
 * Load workflow, compile it, hash it, and pin to store for deterministic execution.
 */
export function loadAndPinWorkflow(args: {
  readonly workflowId: string;
  readonly workflowReader: Pick<import('../../../types/storage.js').IWorkflowReader, 'getWorkflowById'>;
  readonly crypto: Sha256PortV2;
  readonly pinnedStore: import('../../../v2/ports/pinned-workflow-store.port.js').PinnedWorkflowStorePortV2;
  readonly validationPipelineDeps: ValidationPipelineDepsPhase1a;
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
}): RA<{
  readonly workflow: import('../../../types/workflow.js').Workflow;
  readonly workflowHash: WorkflowHash;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly firstStep: { readonly id: string };
  readonly resolvedReferences: readonly ResolvedReference[];
}, StartWorkflowError> {
  const { workflowId, workflowReader, crypto, pinnedStore, validationPipelineDeps, workspacePath, resolvedRootUris } = args;

  return RA.fromPromise(workflowReader.getWorkflowById(workflowId), (e) => ({
    kind: 'precondition_failed' as const,
    message: e instanceof Error ? e.message : String(e),
  }))
    .andThen((workflow): RA<{ workflow: import('../../../types/workflow.js').Workflow }, StartWorkflowError> => {
      if (!workflow) {
        return neErrorAsync({ kind: 'workflow_not_found' as const, workflowId: asWorkflowId(workflowId) });
      }
      // Cheap pre-check: workflow has steps (avoids expensive pinning for zero-step workflows)
      if (workflow.definition.steps.length === 0) {
        return neErrorAsync({ kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(workflowId) });
      }
      return okAsync({ workflow });
    })
    .andThen(({ workflow }) => {
      // Run the Phase 1a validation pipeline before creating any durable state.
      // Phases: schema → structural → v1 compilation → normalization.
      // This replaces the previous normalize-only call with full validation.
      const pipelineOutcome = validateWorkflowPhase1a(workflow, validationPipelineDeps);
      if (pipelineOutcome.kind !== 'phase1a_valid') {
        // Map pipeline failure variants to StartWorkflowError
        const message = pipelineOutcome.kind === 'schema_failed'
          ? `Schema validation failed: ${pipelineOutcome.errors.map(e => e.message ?? e.instancePath).join('; ')}`
          : pipelineOutcome.kind === 'structural_failed'
            ? `Structural validation failed: ${pipelineOutcome.issues.join('; ')}`
            : pipelineOutcome.kind === 'v1_compilation_failed'
              ? `Compilation failed: ${pipelineOutcome.cause.message}`
              : pipelineOutcome.kind === 'normalization_failed'
                ? `Normalization failed: ${pipelineOutcome.cause.message}`
                : pipelineOutcome.kind === 'executable_compilation_failed'
                  ? `Executable compilation failed: ${pipelineOutcome.cause.message}`
                  : 'Unknown validation failure';
        return neErrorAsync({
          kind: 'workflow_compile_failed' as const,
          message,
        });
      }
      const compiled = pipelineOutcome.snapshot;
      const bindingBaseDir = resolveBindingBaseDir(workspacePath, resolvedRootUris ?? []);

      return enrichPinnedSnapshotWithResolvedReferences(compiled, workflow.definition.references ?? [], bindingBaseDir)
        .andThen(({ snapshot: enrichedCompiled, resolvedReferences }) => {
          const workflowHashRes = workflowHashForCompiledSnapshot(enrichedCompiled as unknown as JsonValue, crypto);
          if (workflowHashRes.isErr()) {
            return neErrorAsync({ kind: 'hash_computation_failed' as const, message: workflowHashRes.error.message });
          }
          const workflowHash = workflowHashRes.value;

          return pinnedStore.get(workflowHash)
            .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
            .andThen((existingPinned) => {
              if (!existingPinned) {
                return pinnedStore.put(workflowHash, enrichedCompiled)
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

              const resolution = resolveFirstStep(workflow, pinned);
              if (resolution.isErr()) {
                const error: StartWorkflowError = resolution.error.reason === 'no_steps'
                  ? { kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(resolution.error.detail) }
                  : { kind: 'invariant_violation' as const, message: resolution.error.detail };
                return neErrorAsync(error);
              }

              const firstStep = resolution.value;
              return okAsync({
                workflow,
                firstStep,
                workflowHash,
                pinnedWorkflow,
                resolvedReferences: pinned.resolvedReferences ?? resolvedReferences,
              });
            });
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
 *
 * Emits v2 short tokens (~27 chars) and registers alias entries durably.
 */
export function mintStartTokens(args: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: import('../../../v2/durable-core/tokens/index.js').AttemptId;
  readonly workflowHashRef: import('../../../v2/durable-core/ids/index.js').WorkflowHashRef;
  readonly ports: TokenCodecPorts;
  readonly aliasStore: import('../../../v2/ports/token-alias-store.port.js').TokenAliasStorePortV2;
  readonly entropy: import('../../../v2/ports/random-entropy.port.js').RandomEntropyPortV2;
}): RA<{
  readonly continueToken: string;
  readonly checkpointToken: string;
}, StartWorkflowError> {
  const { sessionId, runId, nodeId, attemptId, workflowHashRef, ports, aliasStore, entropy } = args;

  const entryBase = {
    sessionId: String(sessionId),
    runId: String(runId),
    nodeId: String(nodeId),
    attemptId: String(attemptId),
    workflowHashRef: String(workflowHashRef),
  };

  return mintContinueAndCheckpointTokens({ entry: entryBase, ports, aliasStore, entropy })
    .mapErr((failure) => ({
      kind: 'token_signing_failed' as const,
      cause: failure as unknown as import('../../../v2/durable-core/tokens/index.js').TokenSignErrorV2,
    }));
}

export function executeStartWorkflow(
  input: import('../../v2/tools.js').V2StartWorkflowInput,
  ctx: V2ToolContext
): RA<StartWorkflowResult, StartWorkflowError> {
  const { gate, sessionStore, snapshotStore, pinnedStore, crypto, tokenCodecPorts, idFactory, validationPipelineDeps, tokenAliasStore, entropy } = ctx.v2;
  const shouldUseRequestReader =
    ctx.featureFlags != null && hasRequestWorkspaceSignal({
      workspacePath: input.workspacePath,
      resolvedRootUris: ctx.v2.resolvedRootUris,
    });

  // Eagerly resolve the request reader to capture stale paths before starting the workflow.
  const readerRA = shouldUseRequestReader
    ? RA.fromPromise(
        createWorkflowReaderForRequest({
          featureFlags: ctx.featureFlags,
          workspacePath: input.workspacePath,
          resolvedRootUris: ctx.v2.resolvedRootUris,
          rememberedRootsStore: ctx.v2.rememberedRootsStore,
        }),
        (err): StartWorkflowError => ({
          kind: 'precondition_failed',
          message: `Failed to initialize workflow reader: ${String(err)}`,
        })
      ).map(({ reader, stalePaths }) => ({
        workflowReader: {
          getWorkflowById: async (workflowId: string) => {
            const requestResult = await reader.getWorkflowById(workflowId);
            if (requestResult != null) return requestResult;
            return ctx.workflowService.getWorkflowById(workflowId);
          },
        },
        stalePaths,
      }))
    : okAsync({ workflowReader: ctx.workflowService, stalePaths: [] as readonly string[] });

  // 1. Load, validate (Phase 1a pipeline), and pin workflow
  return readerRA.andThen(({ workflowReader, stalePaths }) => loadAndPinWorkflow({
    workflowId: input.workflowId,
    workflowReader,
    crypto,
    pinnedStore,
    validationPipelineDeps,
    workspacePath: input.workspacePath,
    resolvedRootUris: ctx.v2.resolvedRootUris,
  })
    .andThen(({ workflow, firstStep, workflowHash, pinnedWorkflow, resolvedReferences }) => {
      // 2. Resolve workspace anchors for observation events (graceful: empty on failure).
      // Priority: explicit workspacePath input > MCP roots URI > server process CWD.
      const anchorsRA: RA<readonly ObservationEventData[], never> =
        resolveWorkspaceAnchors(ctx.v2, input.workspacePath)
          .map((anchors) => anchorsToObservations(anchors));

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
              pending: { kind: 'some' as const, step: { stepId: asExpandedStepIdV1(firstStep.id), loopPath: [] } },
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
              .map(() => ({ workflow, firstStep, workflowHash, pinnedWorkflow, resolvedReferences, sessionId, runId, nodeId }));
          });
      });
    })
    .andThen(({ pinnedWorkflow, firstStep, workflowHash, sessionId, runId, nodeId, resolvedReferences }) => {
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
        aliasStore: tokenAliasStore,
        entropy,
      }).andThen((tokens) => {
        // 7. Render pending step and build response
        const metaResult = renderPendingPrompt({
          workflow: pinnedWorkflow,
          stepId: firstStep.id,
          loopPath: [],
          truth: { events: [], manifest: [] }, // start has no prior events
          runId: asRunId(String(runId)),
          nodeId: asNodeId(String(nodeId)),
          rehydrateOnly: false,
        });

        if (metaResult.isErr()) {
          return neErrorAsync({
            kind: 'prompt_render_failed' as const,
            message: metaResult.error.message,
          });
        }

        const meta = metaResult.value;
        const pending = toPendingStep(meta);
        const preferences = defaultPreferences;
        const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: false, pending: meta });

        const contentEnvelope = buildStepContentEnvelope({
          meta,
          references: resolvedReferences,
        });

          const parsed = V2StartWorkflowOutputSchema.parse({
            continueToken: tokens.continueToken,
            checkpointToken: tokens.checkpointToken,
            isComplete: false,
            pending,
            preferences,
            nextIntent,
            nextCall: buildNextCall({ continueToken: tokens.continueToken, isComplete: false, pending }),
            ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
          });
          return okAsync({ response: parsed, contentEnvelope });
      });
    })
  );
}

function enrichPinnedSnapshotWithResolvedReferences(
  snapshot: Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>,
  references: readonly import('../../../types/workflow-definition.js').WorkflowReference[],
  workspacePath: string,
): RA<{
  readonly snapshot: Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>;
  readonly resolvedReferences: readonly ResolvedReference[];
}, StartWorkflowError> {
  if (references.length === 0) {
    return okAsync({ snapshot, resolvedReferences: [] });
  }

  return RA.fromPromise(
    resolveWorkflowReferences(references, workspacePath),
    () => ({ kind: 'reference_resolution_failed' as const }),
  ).map((result) => {
    for (const warning of result.warnings) {
      console.warn(`[workrail:reference-resolution] ${warning.message}`);
    }

    const pinnedResolvedReferences = [...result.resolved];

    return {
      snapshot: {
        ...snapshot,
        resolvedReferences: pinnedResolvedReferences,
      },
      resolvedReferences: result.resolved,
    };
  });
}
