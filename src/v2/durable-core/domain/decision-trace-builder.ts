import type { Result } from 'neverthrow';
import { ok } from 'neverthrow';
import {
  MAX_DECISION_TRACE_ENTRIES,
  MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES,
  MAX_DECISION_TRACE_TOTAL_BYTES,
  TRUNCATION_MARKER,
} from '../constants.js';
import { utf8ByteLength } from '../schemas/lib/utf8-byte-length.js';

/**
 * Decision trace entry kinds (closed set matching lock §1 decision_trace_appended).
 *
 * Why closed: exhaustive switch in consumers; refactor-safe.
 */
export type DecisionTraceEntryKind =
  | 'selected_next_step'
  | 'evaluated_condition'
  | 'entered_loop'
  | 'exited_loop'
  | 'detected_non_tip_advance';

/**
 * Decision trace ref (closed union matching lock §1).
 */
export type DecisionTraceRef =
  | { readonly kind: 'step_id'; readonly stepId: string }
  | { readonly kind: 'loop_id'; readonly loopId: string }
  | { readonly kind: 'condition_id'; readonly conditionId: string }
  | { readonly kind: 'iteration'; readonly value: number };

/**
 * Pure decision trace entry. No event IDs, no session context.
 * These are added at the boundary (handler) when building the event.
 *
 * Immutable value object.
 */
export interface DecisionTraceEntry {
  readonly kind: DecisionTraceEntryKind;
  readonly summary: string;
  readonly refs?: readonly DecisionTraceRef[];
}

// --- Trace entry constructors (pure, deterministic) ---

export function traceEnteredLoop(loopId: string, iteration: number): DecisionTraceEntry {
  return {
    kind: 'entered_loop',
    summary: `Entered loop '${loopId}' at iteration ${iteration}.`,
    refs: [{ kind: 'loop_id', loopId }, { kind: 'iteration', value: iteration }],
  };
}

export function traceEvaluatedCondition(
  loopId: string,
  iteration: number,
  result: boolean,
  source: 'artifact' | 'context' | 'legacy'
): DecisionTraceEntry {
  const decision = result ? 'continue' : 'exit';
  return {
    kind: 'evaluated_condition',
    summary: `Evaluated ${source} condition for loop '${loopId}' at iteration ${iteration}: ${decision}.`,
    refs: [{ kind: 'loop_id', loopId }, { kind: 'iteration', value: iteration }],
  };
}

export function traceExitedLoop(loopId: string, reason: string): DecisionTraceEntry {
  return {
    kind: 'exited_loop',
    summary: `Exited loop '${loopId}': ${reason}.`,
    refs: [{ kind: 'loop_id', loopId }],
  };
}

export function traceSelectedNextStep(stepId: string): DecisionTraceEntry {
  return {
    kind: 'selected_next_step',
    summary: `Selected next step '${stepId}'.`,
    refs: [{ kind: 'step_id', stepId }],
  };
}

// --- Budget enforcement (pure) ---

/**
 * Apply byte budgets to trace entries (lock: max 25 entries, 512 bytes/summary, 8192 total).
 *
 * Deterministic: truncates by bytes, appends canonical marker.
 * Returns a new array; never mutates input.
 */
export function applyTraceBudget(
  entries: readonly DecisionTraceEntry[]
): readonly DecisionTraceEntry[] {
  // Cap entry count
  const capped = entries.slice(0, MAX_DECISION_TRACE_ENTRIES);

  let totalBytes = 0;
  const result: DecisionTraceEntry[] = [];

  for (const entry of capped) {
    let summary = entry.summary;

    // Per-entry summary budget
    if (utf8ByteLength(summary) > MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES) {
      summary = truncateToUtf8Budget(summary, MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES);
    }

    const entryBytes = utf8ByteLength(summary);

    // Total budget check
    if (totalBytes + entryBytes > MAX_DECISION_TRACE_TOTAL_BYTES) {
      // Truncate this entry to fit remaining budget
      const remaining = MAX_DECISION_TRACE_TOTAL_BYTES - totalBytes;
      if (remaining > utf8ByteLength(TRUNCATION_MARKER) + 10) {
        summary = truncateToUtf8Budget(summary, remaining);
        result.push({ ...entry, summary });
      }
      break;
    }

    totalBytes += entryBytes;
    result.push(summary === entry.summary ? entry : { ...entry, summary });
  }

  return result;
}

function truncateToUtf8Budget(s: string, maxBytes: number): string {
  const markerBytes = utf8ByteLength(TRUNCATION_MARKER);
  const targetBytes = maxBytes - markerBytes;
  if (targetBytes <= 0) return TRUNCATION_MARKER;

  // Binary search for the longest prefix that fits
  const encoder = new TextEncoder();
  const encoded = encoder.encode(s);
  if (encoded.length <= maxBytes) return s;

  // Find a safe UTF-8 boundary
  let end = targetBytes;
  // Walk back to a valid UTF-8 character boundary
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
    end--;
  }

  const decoder = new TextDecoder();
  return decoder.decode(encoded.slice(0, end)) + TRUNCATION_MARKER;
}

/**
 * Build the event data payload for decision_trace_appended.
 * Pure function: no event IDs (those are added at the boundary).
 */
export function buildDecisionTraceEventData(
  traceId: string,
  entries: readonly DecisionTraceEntry[]
): Result<
  { readonly traceId: string; readonly entries: readonly { readonly kind: string; readonly summary: string; readonly refs?: readonly DecisionTraceRef[] }[] },
  never
> {
  const budgeted = applyTraceBudget(entries);
  return ok({
    traceId,
    entries: budgeted.map((e) => ({
      kind: e.kind,
      summary: e.summary,
      // Refs are passed through as-is — they already match DecisionTraceRefsV1Schema shape
      refs: e.refs && e.refs.length > 0 ? e.refs : undefined,
    })),
  });
}
