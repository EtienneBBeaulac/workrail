import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import type { SessionIndex } from '../../../v2/durable-core/session-index.js';
import type { Workflow } from '../../../types/workflow.js';
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
 * Maximum number of consecutive blocked_attempt retries allowed on a single step
 * before the circuit breaker fires.
 *
 * When a session has N or more consecutive blocked_attempt nodes on the same step,
 * the engine refuses to accept another retry and returns a terminal PRECONDITION_FAILED
 * error with an actionable message including the required artifact format.
 *
 * Invariant: counted as the number of blocked_attempt nodes in the current node's
 * ancestor chain (inclusive of the current node). A chain of length >= MAX fires the breaker.
 */
const MAX_BLOCKED_ATTEMPT_RETRIES = 3;

/**
 * Count consecutive blocked_attempt nodes in the ancestor chain of a given node,
 * inclusive of the node itself.
 *
 * Pure function: reads from the locked index only, no I/O.
 *
 * Walk terminates when:
 * - parentNodeId is null (reached root)
 * - the parent node has nodeKind !== 'blocked_attempt'
 * - the parent node is not found in the index (defensive: treats as chain end)
 *
 * Returns the depth count (>= 1 when the current node is a blocked_attempt).
 */
function countBlockedAttemptChainDepth(nodeId: NodeId, lockedIndex: SessionIndex): number {
  let depth = 0;
  let currentId: string | null = String(nodeId);

  while (currentId !== null) {
    const nodeEvent = lockedIndex.nodeCreatedByNodeId.get(currentId);
    if (!nodeEvent || nodeEvent.data.nodeKind !== 'blocked_attempt') {
      break;
    }
    depth += 1;
    currentId = nodeEvent.data.parentNodeId ?? null;
  }

  return depth;
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
  readonly pinnedWorkflow: Workflow;
  readonly snapshotStore: import('../../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sessionStore: import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2 & import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly idFactory: { readonly mintNodeId: () => NodeId; readonly mintEventId: () => string };
  readonly gitSnapshot: import('../../../v2/ports/git-snapshot.port.js').GitSnapshotPortV2;
  readonly lockedIndex: SessionIndex;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { truth, sessionId, runId, nodeId, attemptId, workflowHash, dedupeKey, inputContext, inputOutput, lock, pinnedWorkflow, snapshotStore, sessionStore, sha256, idFactory, gitSnapshot } = args;

  // Enforce invariants: do not record advance attempts for unknown nodes.
  // Use the pre-built lockedIndex instead of rescanning truth.events.
  // lockedIndex (not preLockIndex) is correct here: this function runs inside
  // withHealthySessionLock, so lockedIndex reflects post-lock truth.
  // Note: hasNode check uses nodeId only (ULID uniqueness; see session-index.ts Invariant #4).
  const hasRun = args.lockedIndex.runStartedByRunId.has(String(runId));
  const nodeCreated = args.lockedIndex.nodeCreatedByNodeId.get(String(nodeId));
  const hasNode = nodeCreated !== undefined;
  if (!hasRun || !hasNode) {
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

      // Circuit breaker: refuse to accept another retry when the chain has already
      // hit the maximum consecutive blocked_attempt depth. This prevents daemon sessions
      // from looping forever on a step they cannot pass.
      const chainDepth = countBlockedAttemptChainDepth(nodeId, args.lockedIndex);
      if (chainDepth >= MAX_BLOCKED_ATTEMPT_RETRIES) {
        return neErrorAsync({
          kind: 'blocked_attempt_limit_exceeded' as const,
          message: `Assessment gate failed after ${MAX_BLOCKED_ATTEMPT_RETRIES} attempts. ` +
            `Submit a valid wr.assessment artifact. Required format:\n` +
            `\`\`\`json\n` +
            `{ "artifacts": [{ "kind": "wr.assessment", "assessmentId": "<id>", "dimensions": { "<dimensionId>": "high" } }] }\n` +
            `\`\`\``,
        } as InternalError);
      }

      return executeAdvanceCore({
        mode: { kind: 'retry', blockedNodeId: nodeId, blockedSnapshot: snap },
        truth, sessionId, runId, attemptId, workflowHash, dedupeKey,
        inputContext, inputOutput, lock, pinnedWorkflow,
        ports: { snapshotStore, sessionStore, sha256, idFactory, gitSnapshot },
        lockedIndex: args.lockedIndex,
      });
    }

    // Fresh advance
    return executeAdvanceCore({
      mode: { kind: 'fresh', sourceNodeId: nodeId, snapshot: snap },
      truth, sessionId, runId, attemptId, workflowHash, dedupeKey,
      inputContext, inputOutput, lock, pinnedWorkflow,
      ports: { snapshotStore, sessionStore, sha256, idFactory, gitSnapshot },
      lockedIndex: args.lockedIndex,
    });
  });
}
