/**
 * Gate checkpoint outcome builder.
 * Handles the path when an autonomous advance reaches a step with requireConfirmation.
 * Accepted work and context are retained atomically with the parked gate.
 */

import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
import { buildContextSetEvent } from '../v2-advance-events.js';
import type { JsonObject } from '../../../v2/durable-core/canonical/json-types.js';
import type { ValidatedAdvanceInputs } from './input-validation.js';
import type { SessionIndex } from '../../../v2/durable-core/session-index.js';
import type { ExecutionSnapshotFileV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../../v2/ports/snapshot-store.port.js';
import type { WithHealthySessionLock } from '../../../v2/durable-core/ids/with-healthy-session-lock.js';

import { buildGateCheckpointSnapshot } from '../../../v2/durable-core/domain/gate-checkpoint-builder.js';
import type { InternalError } from '../v2-error-mapping.js';
import { buildAndAppendPlan, buildNotesOutputs, buildArtifactOutputs } from './event-builders.js';
import type { AdvanceContext, AdvanceCorePorts } from './index.js';

export function buildGateCheckpointOutcome(args: {
  readonly validated: ValidatedAdvanceInputs;
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
    acceptedContext: args.validated.mergedContext as JsonObject,
    stepId: args.stepId,
    gateKind: args.gateKind,
  });
  if (gateSnapshotRes.isErr()) {
    return neErrorAsync({ kind: 'invariant_violation' as const, message: gateSnapshotRes.error.message });
  }

  const notes = buildNotesOutputs(Boolean(args.ctx.inputOutput?.notesMarkdown), attemptId, args.ctx.inputOutput);
  const artifacts = buildArtifactOutputs(args.ctx.inputOutput?.artifacts ?? [], attemptId, ports.sha256);
  if (artifacts.isErr()) return neErrorAsync(artifacts.error);

  const contextEvent = args.validated.inputContextObj ? buildContextSetEvent({ mergedContext: args.validated.mergedContext as JsonObject, sessionId, runId, idFactory }) : null;

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
      extraEventsToAppend: contextEvent ? [contextEvent] : [],
      snapshotRef: gateSnapshotRef,
      outputsToAppend: [...notes, ...artifacts.value],
      sessionStore,
      idFactory,
      lock,
    });
  });
}
