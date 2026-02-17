import type { DomainEventV1 } from '../schemas/session/index.js';
import type { JsonValue } from '../canonical/json-types.js';
import { normalizeOutputsForAppend, type OutputToAppend } from './outputs.js';
import { err, ok, type Result } from 'neverthrow';
import type { SnapshotRef, WorkflowHash } from '../ids/index.js';

type AdvanceOutcomeV1 = Extract<DomainEventV1, { kind: 'advance_recorded' }>['data']['outcome'];

type EventToAppendV1 = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

/**
 * Build the append plan for an ack-based advance.
 *
 * Produces:
 * - advance_recorded
 * - optional extra events (e.g. gap_recorded)
 * - if advanced: node_created + edge_created + optional node_output_appended events
 *
 * This is PURE: callers must supply minted IDs and indices.
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

  // If omitted, defaults to advanced (back-compat with existing handler).
  readonly outcome?: AdvanceOutcomeV1;

  // Optional: additional durable facts to append atomically with the advance.
  // Caller provides full envelopes except sessionId/eventIndex (assigned here).
  readonly extraEventsToAppend?: readonly EventToAppendV1[];

  // Advanced-only inputs (required when outcome.kind === 'advanced' OR outcome omitted)
  readonly toNodeId?: string;
  readonly toNodeKind?: 'step' | 'blocked_attempt';
  readonly snapshotRef?: SnapshotRef;
  readonly causeKind?: 'intentional_fork' | 'non_tip_advance';
  readonly minted: {
    readonly advanceRecordedEventId: string;
    readonly nodeCreatedEventId?: string;
    readonly edgeCreatedEventId?: string;
    readonly outputEventIds?: readonly string[];
  };
  readonly outputsToAppend?: readonly OutputToAppend[];
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
    minted,
    outputsToAppend,
    extraEventsToAppend,
  } = args;

  const outcome: AdvanceOutcomeV1 =
    args.outcome ??
    (args.toNodeId
      ? ({ kind: 'advanced', toNodeId: args.toNodeId } as const)
      : // If no explicit outcome is provided, we require advanced inputs.
        // This is fail-fast to avoid silently producing a partial append plan.
        (() => {
          throw new Error('INVARIANT: buildAckAdvanceAppendPlanV1 requires toNodeId when outcome is omitted');
        })());

  // Locked dedupe key recipe: advance_recorded:<sessionId>:<nodeId>:<attemptId>
  const advanceDedupeKey = `advance_recorded:${sessionId}:${fromNodeId}:${attemptId}`;

  const advanceRecorded: DomainEventV1 = {
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
      outcome,
    },
  } as DomainEventV1;

  // Attach extra events immediately after advance_recorded (deterministic).
  const extra: DomainEventV1[] = [];
  if (extraEventsToAppend && extraEventsToAppend.length > 0) {
    for (let i = 0; i < extraEventsToAppend.length; i++) {
      const raw = extraEventsToAppend[i]! as unknown as Record<string, unknown>;
      if ('eventIndex' in raw) {
        return err({ code: 'INVARIANT_VIOLATION', message: 'extraEventsToAppend must not include eventIndex (assigned by append plan builder)' });
      }
      if ('sessionId' in raw) {
        return err({ code: 'INVARIANT_VIOLATION', message: 'extraEventsToAppend must not include sessionId (assigned by append plan builder)' });
      }

      extra.push({
        ...(extraEventsToAppend[i]! as unknown as DomainEventV1),
        sessionId,
        eventIndex: nextEventIndex + 1 + i,
      });
    }
  }

  const nextIndexAfterExtra = nextEventIndex + 1 + extra.length;

  if (outcome.kind === 'blocked') {
    // @deprecated This code path is deprecated (ADR 008). Use blocked_attempt nodes instead.
    // This path remains for backward compatibility during 2-release buffer period.
    // Will be removed after v0.10.0.
    
    // Runtime warning when deprecated path is used
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        '[DEPRECATED] Creating advance_recorded with blocked outcome. ' +
        'Use blocked_attempt nodes instead (see ADR 008). ' +
        'This path will be removed in 2 releases. ' +
        'Set USE_BLOCKED_NODES=true to use the new model.'
      );
    }
    
    if (outputsToAppend && outputsToAppend.length > 0) {
      return err({
        code: 'INVARIANT_VIOLATION',
        message: 'blocked outcome cannot include outputsToAppend (no node advancement occurs)',
      });
    }

    return ok({
      events: [advanceRecorded, ...extra],
      snapshotPins: [],
    });
  }

  // Advanced outcome requires the advanced-only inputs.
  if (!args.toNodeId || !args.snapshotRef || !args.causeKind) {
    return err({
      code: 'INVARIANT_VIOLATION',
      message: 'advanced outcome requires toNodeId + snapshotRef + causeKind',
    });
  }
  if (!minted.nodeCreatedEventId || !minted.edgeCreatedEventId || !minted.outputEventIds) {
    return err({
      code: 'INVARIANT_VIOLATION',
      message: 'advanced outcome requires minted.nodeCreatedEventId + minted.edgeCreatedEventId + minted.outputEventIds',
    });
  }

  const toNodeId = args.toNodeId;
  const snapshotRef = args.snapshotRef;
  const causeKind = args.causeKind;
  const toNodeKind = args.toNodeKind ?? 'step';

  const nodeCreatedEventIndex = nextIndexAfterExtra;
  const edgeCreatedEventIndex = nextIndexAfterExtra + 1;

  if (toNodeKind !== 'step' && toNodeKind !== 'blocked_attempt') {
    return err({ code: 'INVARIANT_VIOLATION', message: 'toNodeKind must be step|blocked_attempt' });
  }

  const advancedEvents: readonly DomainEventV1[] = [
    {
      v: 1,
      eventId: minted.nodeCreatedEventId,
      eventIndex: nodeCreatedEventIndex,
      sessionId,
      kind: 'node_created',
      dedupeKey: `node_created:${sessionId}:${runId}:${toNodeId}`,
      scope: { runId, nodeId: toNodeId },
      data: {
        nodeKind: toNodeKind,
        parentNodeId: fromNodeId,
        workflowHash,
        snapshotRef,
      },
    } as DomainEventV1,
    {
      v: 1,
      eventId: minted.edgeCreatedEventId,
      eventIndex: edgeCreatedEventIndex,
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

  const normalizedOutputs = normalizeOutputsForAppend(outputsToAppend ?? []);
  const outputEventIds = minted.outputEventIds ?? [];
  if (outputEventIds.length !== normalizedOutputs.length) {
    return err({
      code: 'INVARIANT_VIOLATION',
      message: 'outputEventIds length mismatch (caller must supply exactly one eventId per output event)',
    });
  }

  const outputEvents: readonly DomainEventV1[] = normalizedOutputs.map((o, idx): DomainEventV1 => {
    const base = {
      v: 1 as const,
      eventId: outputEventIds[idx]!,
      eventIndex: nextIndexAfterExtra + 2 + idx,
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

  const events: readonly DomainEventV1[] = [advanceRecorded, ...extra, ...advancedEvents, ...outputEvents];

  return ok({
    events,
    snapshotPins: [
      {
        snapshotRef,
        eventIndex: nodeCreatedEventIndex,
        createdByEventId: minted.nodeCreatedEventId,
      },
    ],
  });
}
