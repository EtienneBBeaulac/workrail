/**
 * Gate checkpoint outcome builder.
 * Handles the path when an autonomous advance reaches a step with requireConfirmation.
 * Mirrors outcome-blocked.ts in structure but is much simpler: no validation events,
 * no assessment events, no artifact outputs -- just snapshot + plan append.
 */

import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
import type { SessionIndex } from '../../../v2/durable-core/session-index.js';
import type { ExecutionSnapshotFileV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../../v2/ports/snapshot-store.port.js';
import type { WithHealthySessionLock } from '../../../v2/durable-core/ids/with-healthy-session-lock.js';

import { buildGateCheckpointSnapshot } from '../../../v2/durable-core/domain/gate-checkpoint-builder.js';
import type { InternalError } from '../v2-error-mapping.js';
import { buildAndAppendPlan } from './event-builders.js';
import type { AdvanceContext, AdvanceCorePorts } from './index.js';

export function buildGateCheckpointOutcome(args: {
  readonly snap: ExecutionSnapshotFileV1;
  readonly ctx: AdvanceContext;
  readonly stepId: string;
  readonly lock: WithHealthySessionLock;
  readonly ports: AdvanceCorePorts;
  readonly lockedIndex: SessionIndex;
  /** The kind of gate -- determines how TriggerRouter routes the parked session. */
  readonly gateKind: import('../../../v2/durable-core/constants.js').GateKind;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { snap, lock, ports } = args;
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash } = args.ctx;
  const { snapshotStore, sessionStore, idFactory } = ports;

  const gateSnapshotRes = buildGateCheckpointSnapshot({
    priorSnapshot: snap,
    stepId: args.stepId,
    gateKind: args.gateKind,
  });
  if (gateSnapshotRes.isErr()) {
    return neErrorAsync({ kind: 'invariant_violation' as const, message: gateSnapshotRes.error.message });
  }

  return snapshotStore.putExecutionSnapshotV1(gateSnapshotRes.value).andThen((gateSnapshotRef) => {
    return buildAndAppendPlan({
      kind: 'advanced',
      toNodeKind: 'gate_checkpoint',
      truth,
      lockedIndex: args.lockedIndex,
      sessionId,
      runId,
      currentNodeId,
      attemptId,
      workflowHash,
      extraEventsToAppend: [],
      snapshotRef: gateSnapshotRef,
      outputsToAppend: [],
      sessionStore,
      idFactory,
      lock,
    });
  });
}
