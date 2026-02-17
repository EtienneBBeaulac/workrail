import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import { createWorkflow } from '../../../types/workflow.js';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import {
  type AttemptId,
} from '../../../v2/durable-core/tokens/index.js';
import {
  type SessionId,
  type RunId,
  type NodeId,
  type WorkflowHash,
} from '../../../v2/durable-core/ids/index.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { WithHealthySessionLock } from '../../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../../v2/ports/snapshot-store.port.js';
import type { Sha256PortV2 } from '../../../v2/ports/sha256.port.js';
import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
import type { JsonValue } from '../../../v2/durable-core/canonical/json-types.js';
import { type InternalError } from '../v2-error-mapping.js';
import { executeAdvanceCore } from '../v2-advance-core.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';

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
export function advanceAndRecord(args: {
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
  readonly snapshotStore: import('../../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sessionStore: import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2 & import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2;
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
