/**
 * Decision trace builder tests.
 *
 * Tests for:
 * - Pure trace entry constructors (deterministic, immutable)
 * - Budget enforcement (max entries, per-entry bytes, total bytes)
 * - Event data builder (trace → event payload)
 *
 * Lock: §1 decision_trace_appended (max 25 entries, 512 bytes/summary, 8192 total)
 */
import { describe, it, expect } from 'vitest';
import {
  traceEnteredLoop,
  traceEvaluatedCondition,
  traceExitedLoop,
  traceSelectedNextStep,
  applyTraceBudget,
  buildDecisionTraceEventData,
  type DecisionTraceEntry,
} from '../../../src/v2/durable-core/domain/decision-trace-builder.js';
import {
  MAX_DECISION_TRACE_ENTRIES,
  MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES,
  MAX_DECISION_TRACE_TOTAL_BYTES,
  TRUNCATION_MARKER,
} from '../../../src/v2/durable-core/constants.js';

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

describe('trace entry constructors', () => {
  it('traceEnteredLoop produces correct entry', () => {
    const entry = traceEnteredLoop('plan-loop', 0);
    expect(entry.kind).toBe('entered_loop');
    expect(entry.summary).toContain('plan-loop');
    expect(entry.summary).toContain('iteration 0');
    expect(entry.refs).toEqual([
      { kind: 'loop_id', loopId: 'plan-loop' },
      { kind: 'iteration', value: 0 },
    ]);
  });

  it('traceEvaluatedCondition includes source and decision', () => {
    const entry = traceEvaluatedCondition('plan-loop', 2, true, 'artifact');
    expect(entry.kind).toBe('evaluated_condition');
    expect(entry.summary).toContain('artifact');
    expect(entry.summary).toContain('continue');
    expect(entry.refs).toEqual([
      { kind: 'loop_id', loopId: 'plan-loop' },
      { kind: 'iteration', value: 2 },
    ]);
  });

  it('traceEvaluatedCondition shows exit for false result', () => {
    const entry = traceEvaluatedCondition('plan-loop', 3, false, 'context');
    expect(entry.summary).toContain('exit');
  });

  it('traceExitedLoop includes reason', () => {
    const entry = traceExitedLoop('plan-loop', 'Condition no longer met after 3 iteration(s)');
    expect(entry.kind).toBe('exited_loop');
    expect(entry.summary).toContain('plan-loop');
    expect(entry.summary).toContain('Condition no longer met');
    expect(entry.refs).toEqual([{ kind: 'loop_id', loopId: 'plan-loop' }]);
  });

  it('traceSelectedNextStep includes stepId', () => {
    const entry = traceSelectedNextStep('investigate');
    expect(entry.kind).toBe('selected_next_step');
    expect(entry.summary).toContain('investigate');
    expect(entry.refs).toEqual([{ kind: 'step_id', stepId: 'investigate' }]);
  });
});

describe('applyTraceBudget', () => {
  it('returns empty for empty input', () => {
    expect(applyTraceBudget([])).toEqual([]);
  });

  it('passes through entries within budget', () => {
    const entries: DecisionTraceEntry[] = [
      traceEnteredLoop('loop-1', 0),
      traceEvaluatedCondition('loop-1', 0, true, 'artifact'),
      traceSelectedNextStep('step-1'),
    ];
    const result = applyTraceBudget(entries);
    expect(result).toHaveLength(3);
    expect(result[0]!.kind).toBe('entered_loop');
    expect(result[1]!.kind).toBe('evaluated_condition');
    expect(result[2]!.kind).toBe('selected_next_step');
  });

  it('caps at MAX_DECISION_TRACE_ENTRIES', () => {
    const entries: DecisionTraceEntry[] = Array.from(
      { length: MAX_DECISION_TRACE_ENTRIES + 10 },
      (_, i) => traceSelectedNextStep(`step-${i}`)
    );
    const result = applyTraceBudget(entries);
    expect(result.length).toBeLessThanOrEqual(MAX_DECISION_TRACE_ENTRIES);
  });

  it('truncates individual summaries exceeding per-entry budget', () => {
    const longSummary = 'x'.repeat(MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES + 100);
    const entries: DecisionTraceEntry[] = [{ kind: 'selected_next_step', summary: longSummary }];
    const result = applyTraceBudget(entries);
    expect(result).toHaveLength(1);
    expect(utf8Bytes(result[0]!.summary)).toBeLessThanOrEqual(MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES);
    expect(result[0]!.summary).toContain(TRUNCATION_MARKER);
  });

  it('enforces total byte budget across entries', () => {
    // Create entries that individually fit but collectively exceed total budget
    const perEntrySummary = 'a'.repeat(400); // ~400 bytes each
    const count = Math.ceil(MAX_DECISION_TRACE_TOTAL_BYTES / 400) + 5;
    const entries: DecisionTraceEntry[] = Array.from(
      { length: count },
      () => ({ kind: 'selected_next_step' as const, summary: perEntrySummary })
    );
    const result = applyTraceBudget(entries);
    const totalBytes = result.reduce((sum, e) => sum + utf8Bytes(e.summary), 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_DECISION_TRACE_TOTAL_BYTES);
  });

  it('preserves refs through truncation', () => {
    const longSummary = 'x'.repeat(MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES + 100);
    const refs = [{ kind: 'step_id' as const, stepId: 'my-step' }];
    const entries: DecisionTraceEntry[] = [{ kind: 'selected_next_step', summary: longSummary, refs }];
    const result = applyTraceBudget(entries);
    expect(result[0]!.refs).toEqual(refs);
  });
});

describe('buildDecisionTraceEventData', () => {
  it('builds event data from trace entries', () => {
    const entries: DecisionTraceEntry[] = [
      traceEnteredLoop('plan-loop', 0),
      traceEvaluatedCondition('plan-loop', 0, true, 'artifact'),
      traceSelectedNextStep('investigate'),
    ];

    const result = buildDecisionTraceEventData('trace_001', entries);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.traceId).toBe('trace_001');
      expect(result.value.entries).toHaveLength(3);
      expect(result.value.entries[0]!.kind).toBe('entered_loop');
      expect(result.value.entries[2]!.kind).toBe('selected_next_step');
    }
  });

  it('applies budget before building', () => {
    const entries: DecisionTraceEntry[] = Array.from(
      { length: MAX_DECISION_TRACE_ENTRIES + 10 },
      (_, i) => traceSelectedNextStep(`step-${i}`)
    );
    const result = buildDecisionTraceEventData('trace_002', entries);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.entries.length).toBeLessThanOrEqual(MAX_DECISION_TRACE_ENTRIES);
    }
  });

  it('passes refs through as array matching schema shape', () => {
    const entries: DecisionTraceEntry[] = [traceEnteredLoop('my-loop', 2)];
    const result = buildDecisionTraceEventData('trace_003', entries);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const refs = result.value.entries[0]!.refs;
      expect(refs).toEqual([
        { kind: 'loop_id', loopId: 'my-loop' },
        { kind: 'iteration', value: 2 },
      ]);
    }
  });

  it('omits refs when empty', () => {
    const entries: DecisionTraceEntry[] = [{ kind: 'selected_next_step', summary: 'Test' }];
    const result = buildDecisionTraceEventData('trace_004', entries);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.entries[0]!.refs).toBeUndefined();
    }
  });
});
