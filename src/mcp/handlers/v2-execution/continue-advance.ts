import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
import { getCachedWorkflow } from './workflow-object-cache.js';
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
import { asSortedEventLog } from '../../../v2/durable-core/sorted-event-log.js';
import { buildSessionIndex } from '../../../v2/durable-core/session-index.js';

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
  readonly aliasStore: import('../../../v2/ports/token-alias-store.port.js').TokenAliasStorePortV2;
  readonly entropy: import('../../../v2/ports/random-entropy.port.js').RandomEntropyPortV2;
  readonly cleanResponseFormat?: boolean;
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const { input, sessionId, runId, nodeId, attemptId, workflowHashRef, truth, gate, sessionStore, snapshotStore, pinnedStore, tokenCodecPorts, idFactory, sha256, aliasStore, entropy, cleanResponseFormat } = args;

  const dedupeKey = `advance_recorded:${sessionId}:${nodeId}:${attemptId}`;

  // Build a single-pass index over the pre-lock truth to eliminate three redundant
  // .find() scans below. The index is named preLockIndex to make the TOCTOU boundary
  // visible: pre-lock facts (runStarted, nodeCreated) are immutable and safe to read
  // from here. The advance_recorded dedup check (existingLocked) MUST use the
  // lockedIndex built inside withHealthySessionLock -- never preLockIndex.
  const preLockSortedResult = asSortedEventLog(truth.events);
  if (preLockSortedResult.isErr()) {
    return neErrorAsync({
      kind: 'invariant_violation' as const,
      message: `Session events are not sorted: ${preLockSortedResult.error.message}`,
    });
  }
  const preLockIndex = buildSessionIndex(preLockSortedResult.value);

  const runStarted = preLockIndex.runStartedByRunId.get(String(runId));
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
      suggestion: 'Use the continueToken returned by WorkRail for this run.',
    });
  }

  // NodeIds are 128-bit cryptographically random IDs -- unique within the session
  // by negligible collision probability. The original .find() checked both nodeId
  // AND runId; the index omits the runId predicate since random-ID uniqueness makes
  // it redundant (see Invariant #4 in implementation plan).
  const nodeCreated = preLockIndex.nodeCreatedByNodeId.get(String(nodeId));
  if (!nodeCreated) {
    return neErrorAsync({
      kind: 'token_unknown_node' as const,
      message: 'No durable node state was found for this token (missing node_created).',
      suggestion: 'Use tokens returned by WorkRail for an existing node.',
    });
  }
  // Validate node hash against workflowHashRef.
  // When the node hash equals the run hash (the common case), reuse the already-computed
  // refRes to avoid a second deriveWorkflowHashRef call. Only call it again on mismatch,
  // which is a fast error path rather than the hot path.
  if (nodeCreated.data.workflowHash !== workflowHash) {
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
        suggestion: 'Use the continueToken returned by WorkRail for this node.',
      });
    }
  }

  // Pre-lock early-exit: if we already recorded this advance, skip straight to replay.
  // Uses preLockIndex -- safe because the replay path (line below) re-reads truth for rendering.
  // The TOCTOU-sensitive dedup check (existingLocked) happens inside withHealthySessionLock
  // using lockedIndex built from truthLocked. See TOCTOU note in session-index.ts.
  const existing = preLockIndex.advanceRecordedByDedupeKey.get(dedupeKey);

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

      const pinnedWorkflow = getCachedWorkflow(workflowHash, compiled.definition as WorkflowDefinition);

      if (existing) {
        return replayFromRecordedAdvance({
          recordedEvent: existing,
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
          cleanResponseFormat,
        });
      }

      // Acquire the lock only for the first-advance path. Re-check for existing facts under the lock to avoid
      // a race where another writer records advance_recorded after our initial read but before we acquire the lock.
      return gate
        .withHealthySessionLock(sessionId, (lock) =>
          sessionStore.load(sessionId).andThen((truthLocked) => {
            // IMPORTANT: Build lockedIndex from truthLocked (post-lock), NOT from the
            // pre-lock truth or from preLockIndex. The advance_recorded dedup check below
            // MUST use this index. Using preLockIndex here would be a TOCTOU race: a
            // concurrent writer could record the same advance between the pre-lock read
            // and lock acquisition, and we would miss the dedup check.
            // truthLocked comes from a separate sessionStore.load() inside the lock --
            // must validate independently, cannot reuse preLockSortedResult.
            const lockedSortedResult = asSortedEventLog(truthLocked.events);
            if (lockedSortedResult.isErr()) {
              return neErrorAsync({
                kind: 'invariant_violation' as const,
                message: `Locked session events are not sorted: ${lockedSortedResult.error.message}`,
              });
            }
            const lockedIndex = buildSessionIndex(lockedSortedResult.value);

            const existingLocked = lockedIndex.advanceRecordedByDedupeKey.get(dedupeKey);
            if (existingLocked) return okAsync({ kind: 'replay' as const, truth: truthLocked, recordedEvent: existingLocked, precomputedIndex: lockedIndex });

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
              lockedIndex,
            }).andThen(() =>
              sessionStore
                .load(sessionId)
                .andThen((truthAfter) => {
                  // Build an index over truth2 so the recordedEvent lookup and the
                  // subsequent renderPendingPrompt scans can use the index.
                  const afterSortedResult = asSortedEventLog(truthAfter.events);
                  if (afterSortedResult.isErr()) {
                    return neErrorAsync({
                      kind: 'invariant_violation' as const,
                      message: `Post-advance session events are not sorted: ${afterSortedResult.error.message}`,
                    });
                  }
                  const index2 = buildSessionIndex(afterSortedResult.value);
                  const recordedEvent = index2.advanceRecordedByDedupeKey.get(dedupeKey) ?? null;
                  return okAsync({ kind: 'replay' as const, truth: truthAfter, recordedEvent, precomputedIndex: index2 });
                })
            );
          })
        )
        .mapErr((cause) => {
          if (isInternalError(cause)) {
            // Missing context is a recoverable agent-facing error, not an internal failure.
            // Surface it as precondition_failed so the agent gets an actionable message.
            if (cause.kind === 'advance_next_missing_context') {
              return {
                kind: 'precondition_failed' as const,
                message: cause.message,
                suggestion: 'Set the required context variable in the `context` field of your continue_workflow output. The variable must be a JSON array.',
              };
            }
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
          // recordedEvent is pre-populated from index2 on the fresh-advance path.
          // On the replay path (res.recordedEvent from existingLocked), it's also set.
          const recordedEvent = res.recordedEvent;

          if (!recordedEvent) {
            return neErrorAsync({
              kind: 'invariant_violation' as const,
              message: 'Missing recorded advance outcome after successful append.',
            });
          }

          return replayFromRecordedAdvance({
            recordedEvent,
            truth: truth2,
            precomputedIndex: res.precomputedIndex,
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
            cleanResponseFormat,
          });
        });
    });
}
