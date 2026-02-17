import { err, ok, type Result } from 'neverthrow';
import type { ValidationResult } from '../../../types/validation.js';
import type { DomainEventV1 } from '../schemas/session/index.js';
import { EVENT_KIND, MAX_VALIDATION_ISSUES_BYTES, MAX_VALIDATION_SUGGESTIONS_BYTES } from '../constants.js';

type EventToAppendV1 = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

export type ValidationEventError =
  | { readonly code: 'VALIDATION_EVENT_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'VALIDATION_EVENT_TEXT_TOO_LARGE'; readonly message: string };

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  const sorted = [...values].filter((v) => v.length > 0).sort((a, b) => a.localeCompare(b, 'en-US'));
  const out: string[] = [];
  for (const v of sorted) {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

const VALIDATION_TRUNCATION_ITEM = '[TRUNCATED]';

function truncateListToUtf8ByteBudget(args: {
  readonly values: readonly string[];
  readonly maxBytes: number;
  readonly includeTruncationMarker: boolean;
}): Result<readonly string[], ValidationEventError> {
  if (args.maxBytes <= 0) {
    return err({ code: 'VALIDATION_EVENT_INVARIANT_VIOLATION', message: 'maxBytes must be positive' });
  }

  const markerBytes = args.includeTruncationMarker ? utf8ByteLength(VALIDATION_TRUNCATION_ITEM) : 0;
  if (args.includeTruncationMarker && markerBytes > args.maxBytes) {
    return err({ code: 'VALIDATION_EVENT_TEXT_TOO_LARGE', message: 'validation truncation marker does not fit budget' });
  }

  const values = uniqueSorted(args.values);
  const out: string[] = [];
  let used = 0;

  // Reserve marker bytes if we end up truncating.
  // We only know truncation is needed once we see an item that doesn't fit.
  for (const v of values) {
    const bytes = utf8ByteLength(v);
    // If a single item is bigger than the budget, we fail-fast.
    if (bytes > args.maxBytes) {
      return err({
        code: 'VALIDATION_EVENT_TEXT_TOO_LARGE',
        message: 'validation item exceeds max bytes budget',
      });
    }

    const remainingBudget = args.maxBytes - used;
    const reserve = args.includeTruncationMarker ? markerBytes : 0;
    const canFitWithReserve = bytes <= remainingBudget - reserve;

    if (!canFitWithReserve) {
      if (args.includeTruncationMarker) {
        // Only append marker if we actually truncated.
        if (used + markerBytes <= args.maxBytes) out.push(VALIDATION_TRUNCATION_ITEM);
      }
      return ok(out);
    }

    out.push(v);
    used += bytes;
  }

  return ok(out);
}

export function buildValidationPerformedEvent(args: {
  readonly sessionId: string;
  readonly validationId: string;
  readonly attemptId: string;
  readonly contractRef: string;
  readonly result: ValidationResult;
  readonly scope: { readonly runId: string; readonly nodeId: string };
  readonly minted: { readonly eventId: string };
}): Result<EventToAppendV1, ValidationEventError> {
  if (!args.sessionId) return err({ code: 'VALIDATION_EVENT_INVARIANT_VIOLATION', message: 'sessionId is required' });
  if (!args.validationId) return err({ code: 'VALIDATION_EVENT_INVARIANT_VIOLATION', message: 'validationId is required' });
  if (!args.attemptId) return err({ code: 'VALIDATION_EVENT_INVARIANT_VIOLATION', message: 'attemptId is required' });
  if (!args.contractRef) return err({ code: 'VALIDATION_EVENT_INVARIANT_VIOLATION', message: 'contractRef is required' });
  if (!args.scope.runId || !args.scope.nodeId) {
    return err({ code: 'VALIDATION_EVENT_INVARIANT_VIOLATION', message: 'scope.runId and scope.nodeId are required' });
  }
  if (!args.minted.eventId) return err({ code: 'VALIDATION_EVENT_INVARIANT_VIOLATION', message: 'minted.eventId is required' });

  const issuesRes = truncateListToUtf8ByteBudget({
    values: args.result.issues ?? [],
    maxBytes: MAX_VALIDATION_ISSUES_BYTES,
    includeTruncationMarker: true,
  });
  if (issuesRes.isErr()) return err(issuesRes.error);

  const suggestionsRes = truncateListToUtf8ByteBudget({
    values: args.result.suggestions ?? [],
    maxBytes: MAX_VALIDATION_SUGGESTIONS_BYTES,
    includeTruncationMarker: true,
  });
  if (suggestionsRes.isErr()) return err(suggestionsRes.error);

  const dedupeKey = `validation_performed:${args.sessionId}:${args.attemptId}`;

  const event: EventToAppendV1 = {
    v: 1,
    eventId: args.minted.eventId,
    kind: EVENT_KIND.VALIDATION_PERFORMED,
    dedupeKey: dedupeKey as unknown as DomainEventV1['dedupeKey'],
    scope: { runId: args.scope.runId, nodeId: args.scope.nodeId },
    data: {
      validationId: args.validationId,
      attemptId: args.attemptId,
      contractRef: args.contractRef,
      result: {
        valid: args.result.valid,
        issues: issuesRes.value,
        suggestions: suggestionsRes.value,
      },
    },
  } as unknown as EventToAppendV1;

  return ok(event);
}
