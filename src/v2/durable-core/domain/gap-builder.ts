import type { DomainEventV1 } from '../schemas/session/index.js';
import type { ReasonV1 } from './reason-model.js';
import { reasonToGap } from './reason-model.js';

export type GapEvidenceRefV1 =
  | { readonly kind: 'event'; readonly eventId: string }
  | { readonly kind: 'output'; readonly outputId: string };

/**
 * Build gap_recorded event from a blocking reason.
 * 
 * Used in never-stop autonomy mode (full_auto_never_stop) to record gaps
 * instead of blocking. Converts semantic blocking reasons into durable
 * gap_recorded events with severity, summary, and resolution status.
 * 
 * Lock: §11.2 Gap severity mapping, §12 Gap resolution lifecycle
 * 
 * The gap metadata (severity, reason, summary) is derived from the blocking
 * reason via reasonToGap. Evidence refs link the gap to specific events or
 * outputs that triggered it.
 * 
 * @param args.eventId - Unique event ID for this gap_recorded event
 * @param args.gapId - Unique gap identifier (e.g., "gap_attempt123_0")
 * @param args.reason - Blocking reason from detectBlockingReasonsV1
 * @param args.evidenceRefs - Optional refs to triggering events/outputs
 * @returns gap_recorded event ready for append to event log
 */
export function buildGapRecordedEventV1(args: {
  readonly eventId: string;
  readonly eventIndex: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly gapId: string;
  readonly reason: ReasonV1;
  readonly evidenceRefs?: readonly GapEvidenceRefV1[];
}): DomainEventV1 {
  const { severity, reason, summary } = reasonToGap(args.reason);

  return {
    v: 1,
    eventId: args.eventId,
    eventIndex: args.eventIndex,
    sessionId: args.sessionId,
    kind: 'gap_recorded',
    dedupeKey: `gap_recorded:${args.sessionId}:${args.gapId}`,
    scope: { runId: args.runId, nodeId: args.nodeId },
    data: {
      gapId: args.gapId,
      severity,
      reason,
      summary,
      resolution: { kind: 'unresolved' },
      evidenceRefs: args.evidenceRefs,
    },
  } as DomainEventV1;
}
