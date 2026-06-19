import { ResultAsync as RA, okAsync, errAsync as neErrorAsync } from 'neverthrow';
import {
  asWorkflowId,
  asSessionId,
  asRunId,
  asNodeId,
  type SessionId,
  type RunId,
  type NodeId,
  type WorkflowHash,
  type SnapshotRef,
} from '../durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../durable-core/ids/workflow-hash-ref.js';
import type { Sha256PortV2 } from '../ports/sha256.port.js';
import type { TokenCodecPorts } from '../durable-core/tokens/token-codec-ports.js';
import { signEAT, parseEAT } from '../durable-core/tokens/index.js';
import { validateWorkflowPhase1a, type ValidationPipelineDepsPhase1a } from '../../application/services/workflow-validation-pipeline.js';
import { workflowHashForCompiledSnapshot } from '../durable-core/canonical/hashing.js';
import type { JsonValue } from '../durable-core/canonical/json-types.js';
import { anchorsToObservations, type ObservationEventData } from '../durable-core/domain/observation-builder.js';
import type { WorkflowDefinition } from '../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../types/workflow-definition.js';
import { getCachedWorkflow } from './workflow-object-cache.js';
import type { CompiledWorkflowSnapshotV1 } from '../durable-core/schemas/compiled-workflow/index.js';
import { renderPendingPrompt, type StepMetadata } from '../durable-core/domain/prompt-renderer.js';
import { resolveWorkspaceAnchors, resolveBindingBaseDir } from './workspace-resolution.js';
import { newAttemptId, mintContinueAndCheckpointTokens } from './v2-token-ops.js';
import { createWorkflowReaderForRequest, hasRequestWorkspaceSignal } from './request-workflow-reader.js';
import { resolveWorkflowReferences } from './reference-resolver.js';
import { withTimeout } from '../../utils/with-timeout.js';
import type { ResolvedReference } from './reference-types.js';
import { asExpandedStepIdV1 } from '../durable-core/schemas/execution-snapshot/step-instance-key.js';
import type { ExecutionSnapshotFileV1 } from '../durable-core/schemas/execution-snapshot/index.js';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';
import { resolveFirstStep } from '../durable-core/domain/start-construction.js';
import type { ResolveFrom } from '../../types/workflow-definition.js';
import type { IdFactoryV2 } from '../infra/local/id-factory/index.js';

const REFERENCE_RESOLUTION_TIMEOUT_MS = 5_000;

export const defaultPreferences = {
  autonomy: 'guided' as const,
  riskPolicy: 'conservative' as const,
};

export interface StartWorkflowDeps {
  readonly gate: import('./execution-session-gate.js').ExecutionSessionGateV2;
  readonly sessionStore: import('../ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2 &
    import('../ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2;
  readonly snapshotStore: import('../ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly pinnedStore: import('../ports/pinned-workflow-store.port.js').PinnedWorkflowStorePortV2;
  readonly crypto: Sha256PortV2;
  readonly tokenCodecPorts: TokenCodecPorts;
  readonly idFactory: IdFactoryV2;
  readonly validationPipelineDeps: ValidationPipelineDepsPhase1a;
  readonly tokenAliasStore: import('../ports/token-alias-store.port.js').TokenAliasStorePortV2;
  readonly entropy: import('../ports/random-entropy.port.js').RandomEntropyPortV2;
  readonly resolvedRootUris?: readonly string[];
  readonly rememberedRootsStore?: import('../ports/remembered-roots-store.port.js').RememberedRootsStorePortV2;
  readonly managedSourceStore?: import('../ports/managed-source-store.port.js').ManagedSourceStorePortV2;
  readonly workspaceResolver?: import('../ports/workspace-anchor.port.js').WorkspaceContextResolverPortV2;
  readonly fallbackWorkflowReader: Pick<import('../../types/storage.js').IWorkflowReader, 'getWorkflowById'>;
  readonly featureFlags?: import('../../config/feature-flags.js').IFeatureFlagProvider;
}

export type StartWorkflowError =
  | { readonly kind: 'precondition_failed'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'invariant_violation'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'workflow_not_found'; readonly workflowId: import('../durable-core/ids/index.js').WorkflowId }
  | { readonly kind: 'workflow_has_no_steps'; readonly workflowId: import('../durable-core/ids/index.js').WorkflowId }
  | { readonly kind: 'workflow_compile_failed'; readonly message: string }
  | { readonly kind: 'keyring_load_failed'; readonly cause: import('../ports/keyring.port.js').KeyringError }
  | { readonly kind: 'hash_computation_failed'; readonly message: string }
  | { readonly kind: 'pinned_workflow_store_failed'; readonly cause: import('../ports/pinned-workflow-store.port.js').PinnedWorkflowStoreError }
  | { readonly kind: 'snapshot_creation_failed'; readonly cause: import('../ports/snapshot-store.port.js').SnapshotStoreError }
  | { readonly kind: 'session_append_failed'; readonly cause: import('./execution-session-gate.js').ExecutionSessionGateErrorV2 | import('../ports/session-event-log-store.port.js').SessionEventLogStoreError }
  | { readonly kind: 'token_signing_failed'; readonly cause: import('../durable-core/tokens/index.js').TokenSignErrorV2 }
  | { readonly kind: 'prompt_render_failed'; readonly message: string }
  | { readonly kind: 'reference_resolution_failed' };

export interface StartWorkflowUsecaseResult {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly continueToken: string;
  readonly checkpointToken: string;
  readonly resolvedReferences: readonly ResolvedReference[];
  readonly stalePaths: readonly string[];
  readonly managedStoreError?: string;
  readonly meta: StepMetadata;
}

export function loadAndPinWorkflow(args: {
  readonly workflowId: string;
  readonly workflowReader: Pick<import('../../types/storage.js').IWorkflowReader, 'getWorkflowById'>;
  readonly crypto: Sha256PortV2;
  readonly pinnedStore: import('../ports/pinned-workflow-store.port.js').PinnedWorkflowStorePortV2;
  readonly validationPipelineDeps: ValidationPipelineDepsPhase1a;
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
}): RA<{
  readonly workflow: import('../../types/workflow.js').Workflow;
  readonly workflowHash: WorkflowHash;
  readonly pinnedWorkflow: import('../../types/workflow.js').Workflow;
  readonly firstStep: { readonly id: string };
  readonly resolvedReferences: readonly ResolvedReference[];
}, StartWorkflowError> {
  const { workflowId, workflowReader, crypto, pinnedStore, validationPipelineDeps, workspacePath, resolvedRootUris } = args;

  return RA.fromPromise(workflowReader.getWorkflowById(workflowId), (e) => ({
    kind: 'precondition_failed' as const,
    message: e instanceof Error ? e.message : String(e),
  }))
    .andThen((workflow): RA<{ workflow: import('../../types/workflow.js').Workflow }, StartWorkflowError> => {
      if (!workflow) {
        return neErrorAsync({ kind: 'workflow_not_found' as const, workflowId: asWorkflowId(workflowId) });
      }
      if (workflow.definition.steps.length === 0) {
        return neErrorAsync({ kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(workflowId) });
      }
      return okAsync({ workflow });
    })
    .andThen(({ workflow }) => {
      const pipelineOutcome = validateWorkflowPhase1a(workflow, validationPipelineDeps);
      if (pipelineOutcome.kind !== 'phase1a_valid') {
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
              if (existingPinned) {
                return okAsync(existingPinned);
              }
              return pinnedStore.put(workflowHash, enrichedCompiled)
                .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
                .map(() => enrichedCompiled);
            })
            .andThen((pinned) => {
              if (!pinned || pinned.sourceKind !== 'v1_pinned' || !hasWorkflowDefinitionShape(pinned.definition)) {
                return neErrorAsync({
                  kind: 'invariant_violation' as const,
                  message: 'Failed to pin executable workflow snapshot (missing or invalid pinned workflow).',
                });
              }
              const pinnedWorkflow = getCachedWorkflow(workflowHash, pinned.definition as WorkflowDefinition);

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

export function buildInitialEvents(args: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly workflowId: string;
  readonly workflowHash: WorkflowHash;
  readonly workflowSourceKind: 'bundled' | 'user' | 'project' | 'remote' | 'plugin';
  readonly workflowSourceRef: string;
  readonly snapshotRef: SnapshotRef;
  readonly observations: readonly ObservationEventData[];
  readonly idFactory: { readonly mintEventId: () => string };
  readonly goal: string;
  readonly extraContext?: Readonly<Record<string, string>>;
  readonly parentSessionId?: string;
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
    goal,
    extraContext,
    parentSessionId,
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
      timestampMs: Date.now(),
      kind: EVENT_KIND.SESSION_CREATED,
      dedupeKey: `session_created:${sessionId}`,
      data: parentSessionId !== undefined ? { parentSessionId } : {},
    },
    {
      v: 1,
      eventId: evtRunStarted,
      eventIndex: 1,
      sessionId,
      timestampMs: Date.now(),
      kind: EVENT_KIND.RUN_STARTED,
      dedupeKey: `run_started:${sessionId}:${runId}`,
      scope: { runId },
      data: {
        workflowId,
        workflowHash,
        workflowSourceKind,
        workflowSourceRef,
        ...(extraContext?.['triggerSource'] === 'daemon' || extraContext?.['triggerSource'] === 'mcp'
          ? { triggerSource: extraContext['triggerSource'] as 'daemon' | 'mcp' }
          : {}),
      },
    },
    {
      v: 1,
      eventId: evtNodeCreated,
      eventIndex: 2,
      sessionId,
      timestampMs: Date.now(),
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
      timestampMs: Date.now(),
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

  {
    const contextEventId = idFactory.mintEventId();
    const contextId = idFactory.mintEventId();
    mutableEvents.push({
      v: 1,
      eventId: contextEventId,
      eventIndex: mutableEvents.length,
      sessionId,
      timestampMs: Date.now(),
      kind: EVENT_KIND.CONTEXT_SET,
      dedupeKey: `context_set:${sessionId}:${String(runId)}:initial`,
      scope: { runId: String(runId) },
      data: {
        contextId,
        context: { ...extraContext, goal } as Record<string, string>,
        source: 'initial' as const,
      },
    } as DomainEventV1);
  }

  for (const obs of observations) {
    const obsEventId = idFactory.mintEventId();
    mutableEvents.push({
      v: 1,
      eventId: obsEventId,
      eventIndex: mutableEvents.length,
      sessionId,
      timestampMs: Date.now(),
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

export function mintStartTokens(args: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: import('../durable-core/tokens/index.js').AttemptId;
  readonly workflowHashRef: import('../durable-core/ids/index.js').WorkflowHashRef;
  readonly ports: TokenCodecPorts;
  readonly aliasStore: import('../ports/token-alias-store.port.js').TokenAliasStorePortV2;
  readonly entropy: import('../ports/random-entropy.port.js').RandomEntropyPortV2;
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
      cause: failure as unknown as import('../durable-core/tokens/index.js').TokenSignErrorV2,
    }));
}

export function executeStartWorkflow(
  deps: StartWorkflowDeps,
  input: {
    readonly workflowId: string;
    readonly workspacePath: string;
    readonly goal: string;
    readonly modelTier?: 'lightweight' | 'mid' | 'heavy';
  },
  internalContext?: Readonly<Record<string, string>>,
): RA<StartWorkflowUsecaseResult, StartWorkflowError> {
  const { gate, sessionStore, snapshotStore, pinnedStore, crypto, tokenCodecPorts, idFactory, validationPipelineDeps, tokenAliasStore, entropy } = deps;

  let spawnDepth = 0;
  let parentSessionId: string | undefined = internalContext?.['parentSessionId'];

  const eatParseResult = parseEAT(internalContext?.['parent_eat_token'], tokenCodecPorts, parentSessionId);
  if (eatParseResult.ok) {
    // Token present, signature valid -- enforce depth
    const parentEatPayload = eatParseResult.value.payload;
    spawnDepth = (parentEatPayload.spawnDepth ?? 0) + 1;
    if (spawnDepth > 3) {
      return neErrorAsync({
        kind: 'precondition_failed' as const,
        message: `Spawn depth limit exceeded. Maximum allowable depth is 3, requested depth is ${spawnDepth}.`,
      });
    }
  } else {
    const eatError = eatParseResult.error;
    if (eatError.kind === 'missing') {
      // No parent token -- first-level call, spawnDepth stays 0
    } else if (eatError.kind === 'malformed') {
      // Token present but unparseable -- hard stop; never silently skip depth enforcement
      return neErrorAsync({
        kind: 'precondition_failed' as const,
        message: `Parent Environment Attestation Token is malformed: ${eatError.reason}`,
      });
    } else if (eatError.kind === 'signature_mismatch') {
      // Token parsed but signature invalid -- reject
      return neErrorAsync({
        kind: 'precondition_failed' as const,
        message: 'Parent Environment Attestation Token signature verification failed.',
      });
    } else {
      // Exhaustiveness guard -- eatError satisfies never here
      const _exhaustive: never = eatError;
      return neErrorAsync({
        kind: 'precondition_failed' as const,
        message: `Unhandled EAT parse error: ${JSON.stringify(_exhaustive)}`,
      });
    }
  }

  let harness: 'cursor' | 'claude_code' | 'daemon' | 'mcp' = 'mcp';
  const forceHarness = process.env['WORKRAIL_FORCE_HARNESS'];
  if (forceHarness === 'cursor' || forceHarness === 'claude_code' || forceHarness === 'daemon' || forceHarness === 'mcp') {
    harness = forceHarness;
  } else if (process.env['CLAUDE_CODE'] === 'true' || process.env['CLAUDE_CLI'] === 'true') {
    harness = 'claude_code';
  } else if (process.env['CURSOR_APP'] === 'true' || process.env['TERM_PROGRAM'] === 'vscode') {
    harness = 'cursor';
  } else if (internalContext?.['triggerSource'] === 'daemon' || process.env['WORKRAIL_IS_DAEMON'] === 'true') {
    harness = 'daemon';
  } else if (internalContext?.['triggerSource'] === 'mcp') {
    harness = 'mcp';
  }

  const shouldUseRequestReader =
    deps.featureFlags != null && hasRequestWorkspaceSignal({
      workspacePath: input.workspacePath,
      resolvedRootUris: deps.resolvedRootUris,
    });

  const readerRA = shouldUseRequestReader
    ? RA.fromPromise(
        createWorkflowReaderForRequest({
          featureFlags: deps.featureFlags!,
          workspacePath: input.workspacePath,
          resolvedRootUris: deps.resolvedRootUris,
          rememberedRootsStore: deps.rememberedRootsStore,
          managedSourceStore: deps.managedSourceStore,
        }),
        (err): StartWorkflowError => ({
          kind: 'precondition_failed',
          message: `Failed to initialize workflow reader: ${String(err)}`,
        })
      ).map(({ reader, stalePaths, managedStoreError }) => ({
        workflowReader: {
          getWorkflowById: async (workflowId: string) => {
            const requestResult = await reader.getWorkflowById(workflowId);
            if (requestResult != null) return requestResult;
            return deps.fallbackWorkflowReader.getWorkflowById(workflowId);
          },
        },
        stalePaths,
        managedStoreError,
      }))
    : okAsync({ workflowReader: deps.fallbackWorkflowReader, stalePaths: [] as readonly string[], managedStoreError: undefined as string | undefined });

  const anchorsRA: RA<readonly ObservationEventData[], StartWorkflowError> =
    resolveWorkspaceAnchors({ workspaceResolver: deps.workspaceResolver, resolvedRootUris: deps.resolvedRootUris }, input.workspacePath)
      .map((anchors) => anchorsToObservations(anchors))
      .mapErr((x: never): StartWorkflowError => x);

  return readerRA.andThen(({ workflowReader, stalePaths, managedStoreError }) => {
    const pinnedRA = loadAndPinWorkflow({
      workflowId: input.workflowId,
      workflowReader,
      crypto,
      pinnedStore,
      validationPipelineDeps,
      workspacePath: input.workspacePath,
      resolvedRootUris: deps.resolvedRootUris,
    });

    return RA.combine([pinnedRA, anchorsRA] as const)
      .andThen(([{ workflow, firstStep, workflowHash, pinnedWorkflow, resolvedReferences }, observations]) => {
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

            let activeModel = 'claude-3-5-sonnet';
            const forceModel = process.env['WORKRAIL_FORCE_MODEL'] || process.env['WORKRAIL_ACTIVE_MODEL'] || process.env['WORKRAIL_MODEL'];
            if (forceModel) {
              activeModel = forceModel;
            } else if (internalContext?.['model']) {
              activeModel = internalContext['model'];
            } else {
              let resolvedModelTier: 'lightweight' | 'mid' | 'heavy' | undefined = undefined;
              if (input.modelTier) {
                resolvedModelTier = input.modelTier;
              } else if (internalContext?.['modelTier']) {
                resolvedModelTier = internalContext['modelTier'] as 'lightweight' | 'mid' | 'heavy';
              } else {
                const firstStepObj = pinnedWorkflow?.definition.steps.find((s) => s.id === firstStep.id);
                if (firstStepObj && 'modelTier' in firstStepObj && firstStepObj.modelTier) {
                  resolvedModelTier = firstStepObj.modelTier as 'lightweight' | 'mid' | 'heavy';
                } else if (pinnedWorkflow?.definition.modelTier) {
                  resolvedModelTier = pinnedWorkflow.definition.modelTier;
                }
              }

              if (resolvedModelTier) {
                const usesBedrock = !!process.env['AWS_PROFILE'] || !!process.env['AWS_ACCESS_KEY_ID'];
                if (usesBedrock) {
                  if (resolvedModelTier === 'lightweight') {
                    activeModel = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
                  } else if (resolvedModelTier === 'mid') {
                    activeModel = 'us.anthropic.claude-sonnet-4-6';
                  } else if (resolvedModelTier === 'heavy') {
                    activeModel = 'us.anthropic.claude-3-opus-20240229-v1:0';
                  }
                } else {
                  if (resolvedModelTier === 'lightweight') {
                    activeModel = 'claude-3-5-haiku-latest';
                  } else if (resolvedModelTier === 'mid') {
                    activeModel = 'claude-sonnet-4-6';
                  } else if (resolvedModelTier === 'heavy') {
                    activeModel = 'claude-3-opus-latest';
                  }
                }
              }
            }

            const childEatPayload = {
              harness,
              activeModel,
              parentSessionId: parentSessionId ?? '',
              spawnDepth,
              sessionId: String(sessionId),
            };
            const childEatSignResult = signEAT(childEatPayload, tokenCodecPorts);
            const childEat = childEatSignResult.ok
              ? { payload: childEatPayload, signature: childEatSignResult.value }
              : null;
            if (!childEatSignResult.ok) {
              console.warn(`[workrail:eat] Failed to sign child EAT (session ${String(sessionId)}): ${childEatSignResult.error.reason}. Session will work but children won't have a parent EAT.`);
            }

            const enrichedContext: Record<string, string> = {
              ...internalContext,
              metrics_harness: harness,
              metrics_active_model: activeModel,
            };
            if (childEat) {
              enrichedContext['eat_token'] = JSON.stringify(childEat);
            }

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
              goal: input.goal,
              extraContext: enrichedContext,
              parentSessionId,
            });

            const emptyTruth = { manifest: [], events: [] } as const;
            return gate.withHealthySessionLock(sessionId, (lock) =>
              sessionStore.append(lock, {
                events,
                snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: events[2]!.eventId }],
              }, emptyTruth)
            )
              .mapErr((cause) => ({ kind: 'session_append_failed' as const, cause }))
              .map(() => ({ workflow, firstStep, workflowHash, pinnedWorkflow, resolvedReferences, sessionId, runId, nodeId, stalePaths, managedStoreError }));
          });
      });
  })
  .andThen(({ pinnedWorkflow, firstStep, workflowHash, sessionId, runId, nodeId, resolvedReferences, stalePaths, managedStoreError }) => {
    const wfRefRes = deriveWorkflowHashRef(workflowHash);
    if (wfRefRes.isErr()) {
      return neErrorAsync({
        kind: 'precondition_failed' as const,
        message: wfRefRes.error.message,
        suggestion: 'Ensure the pinned workflowHash is a valid sha256 digest.',
      });
    }

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
      const metaResult = renderPendingPrompt({
        workflow: pinnedWorkflow,
        stepId: firstStep.id,
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: asRunId(String(runId)),
        nodeId: asNodeId(String(nodeId)),
        rehydrateOnly: false,
        cleanResponseFormat: deps.featureFlags?.isEnabled('cleanResponseFormat') ?? false,
      });

      if (metaResult.isErr()) {
        return neErrorAsync({
          kind: 'prompt_render_failed' as const,
          message: metaResult.error.message,
        });
      }

      const meta = metaResult.value;

      return okAsync({
        sessionId,
        runId,
        nodeId,
        continueToken: tokens.continueToken,
        checkpointToken: tokens.checkpointToken,
        resolvedReferences,
        stalePaths,
        managedStoreError,
        meta,
      });
    });
  });
}

function mapWorkflowSourceKind(
  kind: 'bundled' | 'user' | 'project' | 'custom' | 'git' | 'remote' | 'plugin',
): 'bundled' | 'user' | 'project' | 'remote' | 'plugin' {
  if (kind === 'custom') return 'project';
  if (kind === 'git') return 'remote';
  return kind;
}

function enrichPinnedSnapshotWithResolvedReferences(
  snapshot: Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>,
  references: readonly import('../../types/workflow-definition.js').WorkflowReference[],
  workspacePath: string,
): RA<{
  readonly snapshot: Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>;
  readonly resolvedReferences: readonly ResolvedReference[];
}, StartWorkflowError> {
  if (references.length === 0) {
    return okAsync({ snapshot, resolvedReferences: [] });
  }

  const allUnresolved: readonly ResolvedReference[] = references.map((ref) => ({
    id: ref.id,
    title: ref.title,
    source: ref.source,
    purpose: ref.purpose,
    authoritative: ref.authoritative,
    resolveFrom: (ref.resolveFrom ?? 'workspace') as ResolveFrom,
    status: 'unresolved' as const,
  }));

  const resolutionPromise = withTimeout(
    resolveWorkflowReferences(references, workspacePath),
    REFERENCE_RESOLUTION_TIMEOUT_MS,
    'reference_resolution',
  ).catch((): null => null);

  return RA.fromPromise(
    resolutionPromise,
    () => ({ kind: 'reference_resolution_failed' as const }),
  ).map((result) => {
    if (result === null) {
      console.warn('[workrail:reference-resolution] timed out; all references marked unresolved');
      return {
        snapshot: { ...snapshot, resolvedReferences: [...allUnresolved] },
        resolvedReferences: allUnresolved,
      };
    }

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
