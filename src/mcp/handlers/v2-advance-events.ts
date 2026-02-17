/**
 * Event builders for v2-advance-core.
 *
 * Extracted from buildSuccessOutcome to reduce LOC and improve modularity.
 * Each builder constructs a specific type of partial event (missing eventIndex + sessionId).
 */

import { ok, err, type Result } from 'neverthrow';
import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';
import type { SessionId, RunId, NodeId } from '../../v2/durable-core/ids/index.js';
import type { AttemptId } from '../../v2/durable-core/tokens/index.js';
import type { JsonObject, JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import type { ValidationResult } from '../../types/validation.js';
import type { RecommendationWarning } from '../../v2/durable-core/domain/recommendation-warnings.js';
import type { ReasonV1 } from '../../v2/durable-core/domain/reason-model.js';
import type { DecisionTraceEntry } from '../../v2/durable-core/domain/decision-trace-builder.js';
import type { InternalError } from './v2-error-mapping.js';
import type { AdvanceCorePorts } from './v2-advance-core.js';

import { reasonToGap } from '../../v2/durable-core/domain/reason-model.js';
import { buildValidationPerformedEvent } from '../../v2/durable-core/domain/validation-event-builder.js';
import { buildDecisionTraceEventData } from '../../v2/durable-core/domain/decision-trace-builder.js';
import { EVENT_KIND } from '../../v2/durable-core/constants.js';

// ── Types ─────────────────────────────────────────────────────────────

type PartialEvent = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

/** Type-safe constructor for partial events — avoids `as` casts at call sites. */
function partialEvent(fields: PartialEvent): PartialEvent {
  return fields;
}

export type AdvanceMode =
  | { readonly kind: 'fresh'; readonly sourceNodeId: NodeId; readonly snapshot: unknown }
  | { readonly kind: 'retry'; readonly blockedNodeId: NodeId; readonly blockedSnapshot: unknown };

export type OutputRequirementStatus =
  | { readonly kind: 'not_required' }
  | { readonly kind: 'satisfied'; readonly contractRef: string }
  | { readonly kind: 'missing'; readonly contractRef: string }
  | { readonly kind: 'invalid'; readonly contractRef: string };

// ── Gap events builder ────────────────────────────────────────────────

/**
 * Build gap events from effective reasons (for full_auto_never_stop mode).
 *
 * Gap events record blocking reasons that were suppressed by guardrails.
 * Each reason is converted to a gap and emitted as a gap_recorded event.
 */
export function buildGapEvents(args: {
  readonly gaps: readonly ReasonV1[];
  readonly sessionId: string;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly idFactory: AdvanceCorePorts['idFactory'];
}): readonly PartialEvent[] {
  const { gaps, sessionId, runId, nodeId, attemptId, idFactory } = args;
  const events: PartialEvent[] = [];

  for (const [idx, r] of gaps.entries()) {
    const g = reasonToGap(r);
    const gapId = `gap_${String(attemptId)}_${idx}`;
    events.push({
      v: 1 as const,
      eventId: idFactory.mintEventId(),
      kind: EVENT_KIND.GAP_RECORDED,
      dedupeKey: `gap_recorded:${sessionId}:${gapId}`,
      scope: { runId: String(runId), nodeId: String(nodeId) },
      data: {
        gapId,
        severity: g.severity,
        reason: g.reason,
        summary: g.summary,
        resolution: { kind: 'unresolved' as const },
      },
    });
  }

  return events;
}

// ── Recommendation warning events builder ─────────────────────────────

/**
 * Build gap events for recommendation exceedances.
 *
 * When effective preferences exceed workflow recommendations, record
 * warnings as gap_recorded events with severity='warning'.
 */
export function buildRecommendationWarningEvents(args: {
  readonly recommendations: readonly RecommendationWarning[];
  readonly sessionId: string;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly idFactory: AdvanceCorePorts['idFactory'];
}): readonly PartialEvent[] {
  const { recommendations, sessionId, runId, nodeId, idFactory } = args;
  const events: PartialEvent[] = [];

  for (const [idx, w] of recommendations.entries()) {
    const gapId = `rec_warn_${String(nodeId)}_${idx}`;
    events.push(
      partialEvent({
        v: 1 as const,
        eventId: idFactory.mintEventId(),
        kind: EVENT_KIND.GAP_RECORDED,
        dedupeKey: `gap_recorded:${sessionId}:${gapId}`,
        scope: { runId: String(runId), nodeId: String(nodeId) },
        data: {
          gapId,
          severity: 'warning',
          reason: w.kind,
          summary: w.summary,
          resolution: { kind: 'unresolved' as const },
        },
      })
    );
  }

  return events;
}

// ── Context set event builder ─────────────────────────────────────────

/**
 * Build context_set event when input context is provided.
 *
 * Records the merged context delta emitted by the agent.
 * Returns null if no input context was provided.
 */
export function buildContextSetEvent(args: {
  readonly mergedContext: JsonObject;
  readonly sessionId: string;
  readonly runId: RunId;
  readonly idFactory: AdvanceCorePorts['idFactory'];
}): PartialEvent | null {
  const { mergedContext, sessionId, runId, idFactory } = args;

  return partialEvent({
    v: 1 as const,
    eventId: idFactory.mintEventId(),
    kind: EVENT_KIND.CONTEXT_SET,
    // Intentionally unique per emission — context_set events should never deduplicate
    dedupeKey: `context_set:${sessionId}:${String(runId)}:${idFactory.mintEventId()}`,
    scope: { runId: String(runId) },
    data: {
      contextId: idFactory.mintEventId(),
      context: mergedContext as unknown as JsonValue,
      source: 'agent_delta' as const,
    },
  });
}

// ── Validation event builder (for success path) ───────────────────────

/**
 * Build validation_performed event for the success path.
 *
 * Mode-driven: retry always emits, fresh never emits on success.
 * Returns null if validation should not be emitted for this mode.
 */
export function buildSuccessValidationEvent(args: {
  readonly mode: AdvanceMode;
  readonly outputRequirement: OutputRequirementStatus;
  readonly validation: ValidationResult | undefined;
  readonly attemptId: AttemptId;
  readonly sessionId: string;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly idFactory: AdvanceCorePorts['idFactory'];
}): PartialEvent | null {
  const { mode, outputRequirement, validation, attemptId, sessionId, runId, nodeId, idFactory } = args;

  // Mode check: only emit validation on success for retry
  if (mode.kind !== 'retry') {
    return null;
  }

  const validationId = `validation_${String(attemptId)}`;
  const contractRefForEvent =
    outputRequirement.kind !== 'not_required' && outputRequirement.kind !== 'satisfied'
      ? outputRequirement.contractRef
      : 'none';

  const validationForEvent: ValidationResult =
    validation ??
    (outputRequirement.kind === 'missing'
      ? {
          valid: false,
          issues: [`Missing required output for contractRef=${contractRefForEvent}`],
          suggestions: [],
          warnings: undefined,
        }
      : { valid: true, issues: [], suggestions: [], warnings: undefined });

  const validationEventRes = buildValidationPerformedEvent({
    sessionId,
    validationId,
    attemptId: String(attemptId),
    contractRef: contractRefForEvent,
    scope: { runId: String(runId), nodeId: String(nodeId) },
    minted: { eventId: idFactory.mintEventId() },
    result: validationForEvent,
  });

  return validationEventRes.isOk() ? validationEventRes.value : null;
}

// ── Decision trace event builder ──────────────────────────────────────

/**
 * Build decision_trace_appended event from interpreter trace.
 *
 * Returns null if trace is empty.
 * Returns err if trace data building fails (should never happen).
 */
export function buildDecisionTraceEvent(args: {
  readonly decisions: readonly DecisionTraceEntry[];
  readonly sessionId: string;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly idFactory: AdvanceCorePorts['idFactory'];
}): Result<PartialEvent | null, InternalError> {
  const { decisions, sessionId, runId, nodeId, idFactory } = args;

  if (decisions.length === 0) {
    return ok(null);
  }

  const traceId = idFactory.mintEventId();
  const traceDataRes = buildDecisionTraceEventData(traceId, decisions);

  if (traceDataRes.isErr()) {
    return err({
      kind: 'invariant_violation' as const,
      message: `Failed to build decision trace data: ${traceDataRes.error}`,
    });
  }

  return ok(
    partialEvent({
      v: 1 as const,
      eventId: idFactory.mintEventId(),
      kind: EVENT_KIND.DECISION_TRACE_APPENDED,
      dedupeKey: `decision_trace_appended:${sessionId}:${traceId}`,
      scope: { runId: String(runId), nodeId: String(nodeId) },
      data: traceDataRes.value,
    })
  );
}
