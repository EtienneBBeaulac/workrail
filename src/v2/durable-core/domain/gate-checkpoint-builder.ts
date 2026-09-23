import { err, ok, type Result } from 'neverthrow';
import type { ExecutionSnapshotFileV1, EnginePayloadV1, EngineStateV1 } from '../schemas/execution-snapshot/index.js';

export type GateCheckpointBuildError =
  | { readonly code: 'GATE_CHECKPOINT_UNSUPPORTED_STATE'; readonly message: string };

/**
 * The gate metadata type as defined in EnginePayloadV1Schema.
 *
 * WHY derived from EnginePayloadV1 (not a standalone interface): EnginePayloadV1Schema
 * owns the canonical definition. Deriving the type here ensures this stays in sync with
 * the schema -- any schema change produces a compile error at all read sites.
 *
 * This type will be superseded when the paused_awaiting_gate EngineStateV1 variant is
 * added in a follow-up PR and gate metadata moves into engineState proper.
 */
export type GateCheckpointPayload = NonNullable<EnginePayloadV1['gateCheckpoint']>;

/**
 * Build the execution snapshot for a gate_checkpoint node.
 *
 * WHY this mirrors blocked-node-builder.ts: the gate_checkpoint node uses the
 * same snapshot-as-metadata pattern as blocked_attempt. The snapshot is stored
 * on the node_created event and carries the gate metadata the coordinator needs
 * to dispatch the evaluator session.
 *
 * The engineState in the gate_checkpoint snapshot remains 'running' -- unlike
 * blocked_attempt which transitions to 'blocked'. This is intentional: in PR 1
 * the engine has no 'paused_awaiting_gate' state. The coordinator detects the
 * gate by finding a gate_checkpoint_recorded event in the session log (Slice 3+).
 * The full paused_awaiting_gate EngineStateV1 variant is deferred to a follow-up PR.
 *
 * Both direct submissions and corrected blocked work must visit the declared gate.
 * A corrected blocked state is normalized to running while retaining its pending step.
 */
export function buildGateCheckpointSnapshot(args: {
  readonly acceptedContext?: import('../canonical/json-types.js').JsonObject;
  readonly priorSnapshot: ExecutionSnapshotFileV1;
  readonly stepId: string;
  /** The kind of gate -- 'coordinator_eval' or 'human_approval'. Stored in snapshot for coordinator routing. */
  readonly gateKind: import('../constants.js').GateKind;
}): Result<ExecutionSnapshotFileV1, GateCheckpointBuildError> {
  const state = args.priorSnapshot.enginePayload.engineState as EngineStateV1;

  if (state.kind !== 'running' && state.kind !== 'blocked') {
    return err({
      code: 'GATE_CHECKPOINT_UNSUPPORTED_STATE',
      message: `Gate checkpoint nodes require running or corrected blocked state (got: ${state.kind})`,
    });
  }

  // The gate_checkpoint snapshot carries the gate metadata in an extension field.
  // The engineState remains 'running' so existing projections continue to work
  // without a new state variant. The gate is detectable from the event log.
  return ok({
    ...args.priorSnapshot,
    enginePayload: {
      ...args.priorSnapshot.enginePayload,
      engineState: {
        // Keep 'running' -- the paused_awaiting_gate state is deferred to a follow-up PR.
        kind: 'running' as const,
        completed: state.completed,
        loopStack: state.loopStack,
        pending: state.pending,
      },
      // Gate metadata -- part of the typed EnginePayloadV1Schema.
      // Survives snapshot serialization and round-trips correctly through the store.
      gateCheckpoint: {
        stepId: args.stepId,
        ...(args.acceptedContext !== undefined ? { acceptedContext: args.acceptedContext } : {}),
        gateKind: args.gateKind,
      },
    },
  });
}
