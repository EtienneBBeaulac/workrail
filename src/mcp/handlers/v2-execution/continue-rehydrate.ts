import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import type { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
import { toPendingStep } from '../../output-schemas.js';
import { detectBindingDrift, type BindingDriftWarning } from '../../../v2/durable-core/domain/binding-drift.js';
// Use the uncached loader for drift detection — we want the current on-disk state,
// not a value that may have been frozen at process startup. The cached
// getProjectBindings is intentionally NOT used here.
import { loadProjectBindings } from '../../../application/services/compiler/binding-registry.js';
import { resolveBindingBaseDir } from '../v2-workspace-resolution.js';
import { deriveIsComplete, derivePendingStep } from '../../../v2/durable-core/projections/snapshot-state.js';
import { getCachedWorkflow } from './workflow-object-cache.js';
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
import type { WorkflowDefinition } from '../../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../../types/workflow-definition.js';
import {
  derivePreferencesOrDefault,
  type ContinueWorkflowError,
} from '../v2-execution-helpers.js';
import { renderPendingPrompt } from '../../../v2/durable-core/domain/prompt-renderer.js';
import * as z from 'zod';
import { newAttemptId, mintContinueAndCheckpointTokens } from '../v2-token-ops.js';
import { deriveNextIntent } from '../v2-state-conversion.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { buildNextCall } from './index.js';
import { buildStepContentEnvelope, type StepContentEnvelope, type ResolvedReference } from '../../step-content-envelope.js';
import { assertOutput, assertContinueTokenPresence } from '../../assert-output.js';

/** Result wrapper for rehydrate — envelope is present only when a pending step exists. */
export interface RehydrateResult {
  readonly response: z.infer<typeof V2ContinueWorkflowOutputSchema>;
  readonly contentEnvelope?: StepContentEnvelope;
}

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
  readonly aliasStore: import('../../../v2/ports/token-alias-store.port.js').TokenAliasStorePortV2;
  readonly entropy: import('../../../v2/ports/random-entropy.port.js').RandomEntropyPortV2;
  /** MCP roots resolved by the server — used as fallback for binding base dir. */
  readonly resolvedRootUris?: readonly string[];
}): RA<RehydrateResult, ContinueWorkflowError> {
  const { input, sessionId, runId, nodeId, workflowHashRef, truth, tokenCodecPorts, pinnedStore, snapshotStore, idFactory, aliasStore, entropy, resolvedRootUris } = args;

  const runStarted = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'run_started' }> => e.kind === EVENT_KIND.RUN_STARTED && e.scope.runId === String(runId)
  );
  const workflowId = runStarted?.data.workflowId;
  if (!runStarted || typeof workflowId !== 'string' || workflowId.trim() === '') {
    return neErrorAsync({
      kind: 'token_unknown_node' as const,
      message: 'No durable run state was found for this continueToken (missing run_started).',
      suggestion: 'Use start_workflow to mint a new run, or use a continueToken returned by WorkRail for an existing run.',
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
    return neErrorAsync({ kind: 'precondition_failed' as const, message: 'workflowHash mismatch for this run.', suggestion: 'Use the continueToken returned by WorkRail for this run.' });
  }

  const nodeCreated = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === EVENT_KIND.NODE_CREATED && e.scope.nodeId === String(nodeId) && e.scope.runId === String(runId)
  );
  if (!nodeCreated) {
    return neErrorAsync({
      kind: 'token_unknown_node' as const,
      message: 'No durable node state was found for this continueToken (missing node_created).',
      suggestion: 'Use a continueToken returned by WorkRail for an existing node.',
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
    return neErrorAsync({ kind: 'precondition_failed' as const, message: 'workflowHash mismatch for this node.', suggestion: 'Use the continueToken returned by WorkRail for this node.' });
  }

  // Load execution snapshot first, then the pinned workflow snapshot.
  // Pinned is loaded on all paths: drift detection runs regardless of pending state.
  return snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef)
    .mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
    .andThen((snapshot) => {
      if (!snapshot) {
        return neErrorAsync({
          kind: 'token_unknown_node' as const,
          message: 'No execution snapshot was found for this node.',
          suggestion: 'Use a continueToken returned by WorkRail for an existing node.',
        });
      }

      const engineState = snapshot.enginePayload.engineState;
      const pending = derivePendingStep(engineState);
      const isComplete = deriveIsComplete(engineState);

      // Load the pinned workflow snapshot for all rehydrate paths.
      // Required for: binding drift detection (both complete and pending paths)
      // and prompt rendering (pending path only).
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

          // Detect binding drift on every rehydrate — whether or not there is a
          // pending step. This ensures the user sees drift warnings even when
          // resuming a completed or between-node session.
          //
          // resolveBindingBaseDir applies the same priority ladder as workspace
          // anchor resolution: explicit workspacePath > MCP root URI > server CWD.
          const bindingBaseDir = resolveBindingBaseDir(
            input.workspacePath,
            resolvedRootUris ?? [],
          );
          const driftWarnings = detectBindingDriftForSnapshot(pinned, workflowId, bindingBaseDir);

          if (!pending) {
            const preferences = derivePreferencesOrDefault({ truth, runId, nodeId });
            const nextIntent = deriveNextIntent({ rehydrateOnly: true, isComplete, pending: null });

            const parsed = assertOutput(
              {
                kind: 'ok',
                isComplete,
                pending: null,
                preferences,
                nextIntent,
                nextCall: null,
                ...(driftWarnings.length > 0 ? { warnings: [...driftWarnings] } : {}),
              } as z.infer<typeof V2ContinueWorkflowOutputSchema>,
              assertContinueTokenPresence,
            );
            return okAsync({ response: parsed });
          }

          const attemptId = newAttemptId(idFactory);

          const entryBase = {
            sessionId: String(sessionId),
            runId: String(runId),
            nodeId: String(nodeId),
            attemptId: String(attemptId),
            workflowHashRef: String(workflowHashRef),
          };

          return mintContinueAndCheckpointTokens({ entry: entryBase, ports: tokenCodecPorts, aliasStore, entropy })
            .mapErr((failure) => ({ kind: 'token_signing_failed' as const, cause: failure as never }))
            .andThen(({ continueToken: continueTokenValue, checkpointToken: checkpointTokenValue }) => {
              const wf = getCachedWorkflow(workflowHash, pinned.definition as WorkflowDefinition);

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
                });
              }

              const meta = metaRes.value;
              const preferences = derivePreferencesOrDefault({ truth, runId, nodeId });
              const nextIntent = deriveNextIntent({ rehydrateOnly: true, isComplete, pending: meta });

              const contentEnvelope = buildStepContentEnvelope({
                meta,
                references: pinned.resolvedReferences ?? buildPinnedReferencesFallback((pinned.definition as WorkflowDefinition).references ?? []),
              });

              const parsed = assertOutput(
                {
                  kind: 'ok',
                  continueToken: continueTokenValue,
                  checkpointToken: checkpointTokenValue,
                  isComplete,
                  pending: toPendingStep(meta),
                  preferences,
                  nextIntent,
                  nextCall: buildNextCall({ continueToken: continueTokenValue, isComplete, pending: meta }),
                  ...(driftWarnings.length > 0 ? { warnings: [...driftWarnings] } : {}),
                } as z.infer<typeof V2ContinueWorkflowOutputSchema>,
                assertContinueTokenPresence,
              );
              return okAsync({ response: parsed, contentEnvelope });
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build fallback pinned references from declarations for older snapshots.
 *
 * Newer snapshots persist the start-time resolved state directly.
 * This fallback exists only for snapshots produced before that field existed.
 */
function buildPinnedReferencesFallback(
  refs: readonly import('../../../types/workflow-definition.js').WorkflowReference[],
): readonly ResolvedReference[] {
  return refs.map((ref) => ({
    id: ref.id,
    title: ref.title,
    source: ref.source,
    purpose: ref.purpose,
    authoritative: ref.authoritative,
    resolveFrom: (ref.resolveFrom ?? 'workspace') as 'workspace' | 'package',
    status: 'pinned' as const,
  }));
}

/**
 * Detect binding drift for a pinned snapshot.
 *
 * Reads current project bindings from .workrail/bindings.json and compares
 * against the manifest frozen into the snapshot at session start.
 * Returns an empty array when no drift is detected or when the snapshot
 * predates the resolvedBindings field (backward compatibility).
 */
function detectBindingDriftForSnapshot(
  pinned: import('../../../v2/durable-core/schemas/compiled-workflow/index.js').CompiledWorkflowSnapshotV1 & { sourceKind: 'v1_pinned' },
  workflowId: string,
  baseDir: string,
): readonly BindingDriftWarning[] {
  // Use pinnedOverrides (project-sourced slots only) for drift detection.
  // This correctly handles override-removal: if a slot was in pinnedOverrides
  // but has no current override, the session compiled with an explicit override
  // that is now gone — that IS drift.
  //
  // Slots absent from pinnedOverrides were compiled from extensionPoint defaults;
  // if they have no current override, that's still the default — not drift.
  //
  // Fall back to resolvedBindings only if pinnedOverrides is absent (older
  // snapshots produced before this field existed), accepting reduced accuracy
  // for those sessions.
  const pinnedOverrides = pinned.pinnedOverrides ?? pinned.resolvedBindings;
  if (!pinnedOverrides || Object.keys(pinnedOverrides).length === 0) return [];

  // loadProjectBindings always reads from disk — no cache — so we get the
  // state of .workrail/bindings.json as it is right now, not as it was when
  // the process started. This is intentional: drift detection must reflect
  // real current state, not a stale cached snapshot.
  //
  // baseDir anchors the lookup to the correct workspace: the caller derives
  // this from input.workspacePath → MCP roots URI → server CWD, matching
  // the same priority ladder used at start_workflow time.
  const currentBindings = loadProjectBindings(workflowId, baseDir);
  return detectBindingDrift(pinnedOverrides, currentBindings);
}
