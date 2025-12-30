import type { DomainEventV1 } from '../schemas/session/index.js';
import type { JsonValue } from '../canonical/json-types.js';
import { normalizeOutputsForAppend, type OutputToAppend } from './outputs.js';
import { err, ok, type Result } from 'neverthrow';
import type { SnapshotRef, WorkflowHash } from '../ids/index.js';
import { asSnapshotRef, asWorkflowHash, asSha256Digest } from '../ids/index.js';

/**
 * Build the append plan for an ack-based advance that produces:
 * - advance_recorded
 * - node_created (new node)
 * - edge_created (from parent → new node)
 * - optional node_output_appended events (normalized for deterministic ordering)
 *
 * This is PURE: callers must supply minted IDs (eventId/toNodeId) and indices.
 *
 * Locks:
 * - v2-core-design-locks.md §1.2: advance_recorded, replay semantics, dedupeKey recipes
 * - output-ordering-deterministic: recap first, then artifacts by (sha256, contentType)
 * - append-plan-atomic: all events in one append
 */
export function buildAckAdvanceAppendPlanV1(args: {
  readonly sessionId: string;
  readonly runId: string;
  readonly fromNodeId: string;
  readonly workflowHash: WorkflowHash;
  readonly attemptId: string;
  readonly nextEventIndex: number;
  readonly toNodeId: string;
  readonly snapshotRef: SnapshotRef;
  readonly causeKind: 'intentional_fork' | 'non_tip_advance';
  readonly minted: {
    readonly advanceRecordedEventId: string;
    readonly nodeCreatedEventId: string;
    readonly edgeCreatedEventId: string;
    readonly outputEventIds: readonly string[];
  };
  readonly outputsToAppend: readonly OutputToAppend[];
}): Result<
  {
    readonly events: readonly DomainEventV1[];
    readonly snapshotPins: readonly { snapshotRef: SnapshotRef; eventIndex: number; createdByEventId: string }[];
  },
  { readonly code: 'INVARIANT_VIOLATION'; readonly message: string }
> {
  const {
    sessionId,
    runId,
    fromNodeId,
    workflowHash,
    attemptId,
    nextEventIndex,
    toNodeId,
    snapshotRef,
    causeKind,
    minted,
    outputsToAppend,
  } = args;

  // Locked dedupe key recipe: advance_recorded:<sessionId>:<nodeId>:<attemptId>
  const advanceDedupeKey = `advance_recorded:${sessionId}:${fromNodeId}:${attemptId}`;

  const baseEvents: readonly DomainEventV1[] = [
    {
      v: 1,
      eventId: minted.advanceRecordedEventId,
      eventIndex: nextEventIndex,
      sessionId,
      kind: 'advance_recorded',
      dedupeKey: advanceDedupeKey,
      scope: { runId, nodeId: fromNodeId },
      data: {
        attemptId,
        intent: 'ack_pending',
        outcome: { kind: 'advanced', toNodeId },
      },
    } as DomainEventV1,
    {
      v: 1,
      eventId: minted.nodeCreatedEventId,
      eventIndex: nextEventIndex + 1,
      sessionId,
      kind: 'node_created',
      dedupeKey: `node_created:${sessionId}:${runId}:${toNodeId}`,
      scope: { runId, nodeId: toNodeId },
      data: {
        nodeKind: 'step',
        parentNodeId: fromNodeId,
        workflowHash,
        snapshotRef,
      },
    } as DomainEventV1,
    {
      v: 1,
      eventId: minted.edgeCreatedEventId,
      eventIndex: nextEventIndex + 2,
      sessionId,
      kind: 'edge_created',
      dedupeKey: `edge_created:${sessionId}:${runId}:${fromNodeId}->${toNodeId}:acked_step`,
      scope: { runId },
      data: {
        edgeKind: 'acked_step',
        fromNodeId,
        toNodeId,
        cause: { kind: causeKind, eventId: minted.advanceRecordedEventId },
      },
    } as DomainEventV1,
  ];

  const normalizedOutputs = normalizeOutputsForAppend(outputsToAppend);
  if (minted.outputEventIds.length !== normalizedOutputs.length) {
    return err({
      code: 'INVARIANT_VIOLATION',
      message: 'outputEventIds length mismatch (caller must supply exactly one eventId per output event)',
    });
  }

  const outputEvents: readonly DomainEventV1[] = normalizedOutputs.map((o, idx): DomainEventV1 => {
    const base = {
      v: 1 as const,
      eventId: minted.outputEventIds[idx]!,
      eventIndex: nextEventIndex + 3 + idx,
      sessionId,
      kind: 'node_output_appended' as const,
      dedupeKey: `node_output_appended:${sessionId}:${o.outputId}`,
      scope: { runId, nodeId: fromNodeId },
      data: {
        outputId: o.outputId,
        outputChannel: o.outputChannel,
        payload: o.payload as unknown as JsonValue,
      } as Record<string, unknown>,
    };

    // Critical: never persist `undefined` (JCS cannot serialize it). Omit optional keys.
    return o.supersedesOutputId
      ? ({
          ...base,
          data: { ...base.data, supersedesOutputId: o.supersedesOutputId },
        } as unknown as DomainEventV1)
      : (base as unknown as DomainEventV1);
  });

  const events: readonly DomainEventV1[] = [...baseEvents, ...outputEvents];

  return ok({
    events,
    snapshotPins: [
      {
        snapshotRef,
        eventIndex: nextEventIndex + 1,
        createdByEventId: minted.nodeCreatedEventId,
      },
    ],
  });
}
