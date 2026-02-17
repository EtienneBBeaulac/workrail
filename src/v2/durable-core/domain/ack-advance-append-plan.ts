import type { DomainEventV1 } from '../schemas/session/index.js';
import type { JsonValue } from '../canonical/json-types.js';
import { normalizeOutputsForAppend, type OutputToAppend } from './outputs.js';
import { err, ok, type Result } from 'neverthrow';
import type { SnapshotRef, WorkflowHash } from '../ids/index.js';
import { EVENT_KIND, EDGE_KIND, ADVANCE_INTENT } from '../constants.js';

type AdvanceOutcomeV1 = Extract<DomainEventV1, { kind: 'advance_recorded' }>['data']['outcome'];

type EventToAppendV1 = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

/**
 * Build an advance_recorded event.
 */
function buildAdvanceRecordedEvent(args: {
  sessionId: string;
  runId: string;
  fromNodeId: string;
  attemptId: string;
  eventIndex: number;
  eventId: string;
  outcome: AdvanceOutcomeV1;
}): DomainEventV1 {
  const advanceDedupeKey = `advance_recorded:${args.sessionId}:${args.fromNodeId}:${args.attemptId}`;
  
  return {
    v: 1,
    eventId: args.eventId,
    eventIndex: args.eventIndex,
    sessionId: args.sessionId,
    kind: EVENT_KIND.ADVANCE_RECORDED,
    dedupeKey: advanceDedupeKey,
    scope: { runId: args.runId, nodeId: args.fromNodeId },
    data: {
      attemptId: args.attemptId,
      intent: ADVANCE_INTENT.ACK_PENDING,
      outcome: args.outcome,
    },
  } as DomainEventV1;
}

/**
 * Build a node_created event.
 */
function buildNodeCreatedEvent(args: {
  sessionId: string;
  runId: string;
  toNodeId: string;
  fromNodeId: string;
  toNodeKind: 'step' | 'blocked_attempt';
  workflowHash: WorkflowHash;
  snapshotRef: SnapshotRef;
  eventId: string;
  eventIndex: number;
}): DomainEventV1 {
  return {
    v: 1,
    eventId: args.eventId,
    eventIndex: args.eventIndex,
    sessionId: args.sessionId,
    kind: EVENT_KIND.NODE_CREATED,
    dedupeKey: `node_created:${args.sessionId}:${args.runId}:${args.toNodeId}`,
    scope: { runId: args.runId, nodeId: args.toNodeId },
    data: {
      nodeKind: args.toNodeKind,
      parentNodeId: args.fromNodeId,
      workflowHash: args.workflowHash,
      snapshotRef: args.snapshotRef,
    },
  } as DomainEventV1;
}

/**
 * Build an edge_created event.
 */
function buildEdgeCreatedEvent(args: {
  sessionId: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string;
  causeKind: 'intentional_fork' | 'non_tip_advance';
  causeEventId: string;
  eventId: string;
  eventIndex: number;
}): DomainEventV1 {
  return {
    v: 1,
    eventId: args.eventId,
    eventIndex: args.eventIndex,
    sessionId: args.sessionId,
    kind: EVENT_KIND.EDGE_CREATED,
    dedupeKey: `edge_created:${args.sessionId}:${args.runId}:${args.fromNodeId}->${args.toNodeId}:acked_step`,
    scope: { runId: args.runId },
    data: {
      edgeKind: EDGE_KIND.ACKED_STEP,
      fromNodeId: args.fromNodeId,
      toNodeId: args.toNodeId,
      cause: { kind: args.causeKind, eventId: args.causeEventId },
    },
  } as DomainEventV1;
}

/**
 * Build node_output_appended events for the given outputs.
 */
function buildOutputEvents(args: {
  outputs: readonly OutputToAppend[];
  outputEventIds: readonly string[];
  sessionId: string;
  runId: string;
  fromNodeId: string;
  startEventIndex: number;
}): Result<DomainEventV1[], { code: 'INVARIANT_VIOLATION'; message: string }> {
  const normalizedOutputs = normalizeOutputsForAppend(args.outputs);
  
  if (args.outputEventIds.length !== normalizedOutputs.length) {
    return err({
      code: 'INVARIANT_VIOLATION',
      message: 'outputEventIds length mismatch (caller must supply exactly one eventId per output event)',
    });
  }

  const outputEvents: DomainEventV1[] = normalizedOutputs.map((o, idx): DomainEventV1 => {
    const base = {
      v: 1 as const,
      eventId: args.outputEventIds[idx]!,
      eventIndex: args.startEventIndex + idx,
      sessionId: args.sessionId,
      kind: EVENT_KIND.NODE_OUTPUT_APPENDED,
      dedupeKey: `node_output_appended:${args.sessionId}:${o.outputId}`,
      scope: { runId: args.runId, nodeId: args.fromNodeId },
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

  return ok(outputEvents);
}

/**
 * Process extra events to append, assigning sessionId and eventIndex.
 */
function processExtraEvents(
  extraEventsToAppend: readonly EventToAppendV1[] | undefined,
  sessionId: string,
  startEventIndex: number
): Result<DomainEventV1[], { code: 'INVARIANT_VIOLATION'; message: string }> {
  const extra: DomainEventV1[] = [];
  
  if (extraEventsToAppend && extraEventsToAppend.length > 0) {
    for (let i = 0; i < extraEventsToAppend.length; i++) {
      const raw = extraEventsToAppend[i]! as unknown as Record<string, unknown>;
      if ('eventIndex' in raw) {
        return err({ 
          code: 'INVARIANT_VIOLATION', 
          message: 'extraEventsToAppend must not include eventIndex (assigned by append plan builder)' 
        });
      }
      if ('sessionId' in raw) {
        return err({ 
          code: 'INVARIANT_VIOLATION', 
          message: 'extraEventsToAppend must not include sessionId (assigned by append plan builder)' 
        });
      }

      extra.push({
        ...(extraEventsToAppend[i]! as unknown as DomainEventV1),
        sessionId,
        eventIndex: startEventIndex + i,
      });
    }
  }
  
  return ok(extra);
}

export type AckAdvanceAppendPlanArgs = {
  readonly sessionId: string;
  readonly runId: string;
  readonly fromNodeId: string;
  readonly workflowHash: WorkflowHash;
  readonly attemptId: string;
  readonly nextEventIndex: number;
  readonly extraEventsToAppend?: readonly EventToAppendV1[];
} & (
  | {
      readonly outcome: { kind: 'blocked'; blockers: import('./reason-model.js').BlockerReportV1 };
      readonly minted: {
        readonly advanceRecordedEventId: string;
      };
    }
  | {
      readonly outcome: { kind: 'advanced'; toNodeId: string };
      readonly toNodeKind: 'step' | 'blocked_attempt';
      readonly toNodeId: string;
      readonly snapshotRef: SnapshotRef;
      readonly causeKind: 'intentional_fork' | 'non_tip_advance';
      readonly minted: {
        readonly advanceRecordedEventId: string;
        readonly nodeCreatedEventId: string;
        readonly edgeCreatedEventId: string;
        readonly outputEventIds: readonly string[];
      };
      readonly outputsToAppend?: readonly OutputToAppend[];
    }
);

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
export function buildAckAdvanceAppendPlanV1(args: AckAdvanceAppendPlanArgs): Result<
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
    extraEventsToAppend,
    outcome,
  } = args;

  // Build advance_recorded event
  const advanceRecorded = buildAdvanceRecordedEvent({
    sessionId,
    runId,
    fromNodeId,
    attemptId,
    eventIndex: nextEventIndex,
    eventId: minted.advanceRecordedEventId,
    outcome,
  });

  // Attach extra events immediately after advance_recorded (deterministic)
  const extraResult = processExtraEvents(extraEventsToAppend, sessionId, nextEventIndex + 1);
  if (extraResult.isErr()) {
    return err(extraResult.error);
  }
  const extra = extraResult.value;

  const nextIndexAfterExtra = nextEventIndex + 1 + extra.length;

  if (outcome.kind === 'blocked') {
    // @deprecated (ADR 008): Use blocked_attempt nodes instead.
    // Backward-compat path retained for 2-release buffer; remove after v0.10.0.
    return ok({
      events: [advanceRecorded, ...extra],
      snapshotPins: [],
    });
  }

  // Advanced outcome - narrow by checking outcome.kind and ensuring args type
  if (outcome.kind !== 'advanced') {
    // Exhaustiveness check - should never reach here
    const _exhaustive: never = outcome;
    return err({ code: 'INVARIANT_VIOLATION', message: `Unknown outcome kind` });
  }

  // Narrow args to the advanced variant by checking the presence of required fields
  if (!('toNodeId' in args) || !('snapshotRef' in args) || !('causeKind' in args) || !('toNodeKind' in args) || !('minted' in args) || !('nodeCreatedEventId' in args.minted)) {
    return err({ code: 'INVARIANT_VIOLATION', message: 'Advanced outcome requires toNodeId, snapshotRef, causeKind, toNodeKind, and minted event IDs' });
  }

  // Extract fields from the advanced variant (TypeScript needs help with narrowing)
  const advancedArgs = args as Extract<typeof args, { outcome: { kind: 'advanced' } }>;
  const toNodeId = advancedArgs.toNodeId;
  const snapshotRef = advancedArgs.snapshotRef;
  const causeKind = advancedArgs.causeKind;
  const toNodeKind = advancedArgs.toNodeKind;
  const outputsToAppend = advancedArgs.outputsToAppend;
  const advancedMinted = advancedArgs.minted;

  if (toNodeKind !== 'step' && toNodeKind !== 'blocked_attempt') {
    return err({ code: 'INVARIANT_VIOLATION', message: 'toNodeKind must be step|blocked_attempt' });
  }

  const nodeCreatedEventIndex = nextIndexAfterExtra;
  const edgeCreatedEventIndex = nextIndexAfterExtra + 1;

  // Build node_created and edge_created events
  const nodeCreated = buildNodeCreatedEvent({
    sessionId,
    runId,
    toNodeId,
    fromNodeId,
    toNodeKind,
    workflowHash,
    snapshotRef,
    eventId: advancedMinted.nodeCreatedEventId,
    eventIndex: nodeCreatedEventIndex,
  });

  const edgeCreated = buildEdgeCreatedEvent({
    sessionId,
    runId,
    fromNodeId,
    toNodeId,
    causeKind,
    causeEventId: minted.advanceRecordedEventId,
    eventId: advancedMinted.edgeCreatedEventId,
    eventIndex: edgeCreatedEventIndex,
  });

  // Build output events
  const outputEventsResult = buildOutputEvents({
    outputs: outputsToAppend ?? [],
    outputEventIds: advancedMinted.outputEventIds,
    sessionId,
    runId,
    fromNodeId,
    startEventIndex: nextIndexAfterExtra + 2,
  });
  if (outputEventsResult.isErr()) {
    return err(outputEventsResult.error);
  }

  const events: readonly DomainEventV1[] = [
    advanceRecorded,
    ...extra,
    nodeCreated,
    edgeCreated,
    ...outputEventsResult.value,
  ];

  return ok({
    events,
    snapshotPins: [
      {
        snapshotRef,
        eventIndex: nodeCreatedEventIndex,
        createdByEventId: advancedMinted.nodeCreatedEventId,
      },
    ],
  });
}
