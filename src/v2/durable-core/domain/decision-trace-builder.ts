import type { Result } from 'neverthrow';
import { ok } from 'neverthrow';
import {
  MAX_DECISION_TRACE_ENTRIES,
  MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES,
  MAX_DECISION_TRACE_TOTAL_BYTES,
  TRUNCATION_MARKER,
} from '../constants.js';
import { utf8ByteLength } from '../schemas/lib/utf8-byte-length.js';
import type { LoopControlEvaluationResult } from './loop-control-evaluator.js';
import type { Condition } from '../../../utils/condition-evaluator.js';

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

export function traceSelectedNextStep(stepId: string, stepTitle?: string): DecisionTraceEntry {
  const label = stepTitle ? `${stepTitle} (${stepId})` : stepId;
  return {
    kind: 'selected_next_step',
    summary: `Next step: ${label}`,
    refs: [{ kind: 'step_id', stepId }],
  };
}

/**
 * Format a condition as a human-readable trace string for top-level step runConditions.
 *
 * Design invariants:
 * - PASS strings start with "PASS:" and MUST match /\btrue\b|\bpass/i (for isConditionPassed).
 * - SKIP strings start with "SKIP:" and MUST NOT match /\btrue\b|\bpass/i.
 * - SKIP strings deliberately omit runtime values to prevent false positives when
 *   a condition's expected value contains 'pass' or 'true'.
 * - Pure and deterministic: same inputs always produce the same output.
 */
export function formatConditionTrace(
  condition: Condition,
  context: Record<string, unknown>,
  passed: boolean,
): string {
  const prefix = passed ? 'PASS' : 'SKIP';

  // Handle logical operators first (compound conditions)
  if (condition.and !== undefined) {
    return passed ? 'PASS: and-condition met' : 'SKIP: and-condition not met';
  }
  if (condition.or !== undefined) {
    return passed ? 'PASS: or-condition met' : 'SKIP: or-condition not met';
  }
  if (condition.not !== undefined) {
    return passed ? 'PASS: not-condition met' : 'SKIP: not-condition not met';
  }

  // Single-variable conditions: determine which operator is present
  const varName = condition.var;
  if (!varName) {
    return `${prefix}: condition ${passed ? 'met' : 'not met'}`;
  }

  const op = getOperatorLabel(condition);

  if (passed) {
    // PASS: include actual context value for maximum user insight
    const contextValue = context[varName];
    const contextStr = contextValue === undefined ? '(unset)' : String(contextValue);
    const expectedStr = getExpectedValueLabel(condition);
    return expectedStr !== null
      ? `PASS: ${varName}=${contextStr} (${op}: ${expectedStr})`
      : `PASS: ${varName}=${contextStr} (${op})`;
  } else {
    // SKIP: omit all values to prevent isConditionPassed false positives
    return `SKIP: ${varName} (${op})`;
  }
}

/**
 * Returns a compact label for the operator used in a condition.
 * Falls back to 'condition' for unknown/empty structures.
 */
function getOperatorLabel(condition: Condition): string {
  if (condition.var === undefined) return 'condition';
  if ('equals' in condition) return 'equals';
  if ('not_equals' in condition) return 'not_equals';
  if (condition.gt !== undefined) return 'gt';
  if (condition.gte !== undefined) return 'gte';
  if (condition.lt !== undefined) return 'lt';
  if (condition.lte !== undefined) return 'lte';
  if (condition.contains !== undefined) return 'contains';
  if (condition.startsWith !== undefined) return 'startsWith';
  if (condition.endsWith !== undefined) return 'endsWith';
  if (condition.matches !== undefined) return 'matches';
  if (condition.in !== undefined) return 'in';
  return 'condition';
}

/**
 * Returns the expected value from the condition as a string for PASS summaries,
 * or null if there is no expected value (e.g., truthiness check).
 *
 * Used ONLY in PASS strings -- SKIP strings never include expected values.
 */
function getExpectedValueLabel(condition: Condition): string | null {
  if ('equals' in condition) return String(condition.equals);
  if ('not_equals' in condition) return String(condition.not_equals);
  if (condition.gt !== undefined) return String(condition.gt);
  if (condition.gte !== undefined) return String(condition.gte);
  if (condition.lt !== undefined) return String(condition.lt);
  if (condition.lte !== undefined) return String(condition.lte);
  if (condition.contains !== undefined) return condition.contains;
  if (condition.startsWith !== undefined) return condition.startsWith;
  if (condition.endsWith !== undefined) return condition.endsWith;
  if (condition.matches !== undefined) return condition.matches;
  if (condition.in !== undefined) return JSON.stringify(condition.in);
  return null;
}

/**
 * Trace a top-level step whose runCondition evaluated to false (step was skipped).
 *
 * The emitted entry is kind `evaluated_condition` with a step_id ref.
 * Summary uses `SKIP:` prefix and intentionally omits runtime values to prevent
 * isConditionPassed false positives from condition expected values like 'pass'/'true'.
 */
export function traceStepRunConditionSkipped(
  stepId: string,
  stepTitle: string | undefined,
  condition: Condition,
  context: Record<string, unknown>,
): DecisionTraceEntry {
  return {
    kind: 'evaluated_condition',
    summary: formatConditionTrace(condition, context, false),
    refs: [{ kind: 'step_id', stepId }],
  };
}

/**
 * Trace a top-level step whose runCondition evaluated to true (step was selected via condition).
 *
 * The emitted entry is kind `evaluated_condition` with a step_id ref.
 * Summary uses `PASS:` prefix and includes the actual context value for user insight.
 */
export function traceStepRunConditionPassed(
  stepId: string,
  stepTitle: string | undefined,
  condition: Condition,
  context: Record<string, unknown>,
): DecisionTraceEntry {
  return {
    kind: 'evaluated_condition',
    summary: formatConditionTrace(condition, context, true),
    refs: [{ kind: 'step_id', stepId }],
  };
}

/**
 * Trace an artifact match result during loop control evaluation.
 * Accepts the domain LoopControlEvaluationResult directly so the trace
 * derives its summary from structured data, not caller-assembled strings.
 */
export function traceArtifactMatchResult(
  loopId: string,
  iteration: number,
  result: LoopControlEvaluationResult,
): DecisionTraceEntry {
  const detail = (() => {
    switch (result.kind) {
      case 'found':    return `decision="${result.decision}"`;
      case 'not_found': return result.reason;
      case 'invalid':  return result.reason;
    }
  })();
  return {
    kind: 'evaluated_condition',
    summary: `Loop '${loopId}' iteration ${iteration}: artifact match=${result.kind} — ${detail}`,
    refs: [{ kind: 'loop_id', loopId }, { kind: 'iteration', value: iteration }],
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
