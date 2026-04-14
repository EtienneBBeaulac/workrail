/**
 * Unit tests for session-detail-use-cases.ts pure functions.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 *
 * Covers:
 *   - groupTraceEntries: loop grouping algorithm (all 8 code paths)
 *   - getNodeRoutingItems: node-scoped trace item categorization
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  groupTraceEntries,
  getNodeRoutingItems,
  type StandaloneEntry,
  type LoopGroup,
} from '../../console/src/views/session-detail-use-cases';
import type {
  ConsoleExecutionTraceItem,
  ConsoleExecutionTraceRef,
  ConsoleExecutionTraceSummary,
} from '../../console/src/api/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextIndex = 0;

beforeEach(() => { nextIndex = 0; });

function makeItem(
  kind: ConsoleExecutionTraceItem['kind'],
  refs: ConsoleExecutionTraceRef[] = [],
  summary = `summary for ${kind}`,
): ConsoleExecutionTraceItem {
  return { kind, summary, refs, recordedAtEventIndex: nextIndex++ };
}

function loopRef(loopId: string): ConsoleExecutionTraceRef {
  return { kind: 'loop_id', value: loopId };
}

function nodeRef(nodeId: string): ConsoleExecutionTraceRef {
  return { kind: 'node_id', value: nodeId };
}

function makeSummary(items: ConsoleExecutionTraceItem[]): ConsoleExecutionTraceSummary {
  return { items, contextFacts: [] };
}

// ---------------------------------------------------------------------------
// groupTraceEntries tests
// ---------------------------------------------------------------------------

describe('groupTraceEntries', () => {
  it('produces a LoopGroup for a matched entered_loop/exited_loop pair', () => {
    const enter = makeItem('entered_loop', [loopRef('loop-1')]);
    const exit = makeItem('exited_loop', [loopRef('loop-1')]);
    const result = groupTraceEntries([enter, exit]);

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('loop_group');
    const group = result[0] as LoopGroup;
    expect(group.loopId).toBe('loop-1');
    expect(group.enteredItem).toBe(enter);
    expect(group.exitedItem).toBe(exit);
    expect(group.innerItems).toHaveLength(0);
    expect(group.iterationCount).toBe(1); // min(1, 0 selected_next_step) = 1
  });

  it('counts iterations from selected_next_step items inside the loop', () => {
    const enter = makeItem('entered_loop', [loopRef('loop-1')]);
    const step1 = makeItem('selected_next_step');
    const step2 = makeItem('selected_next_step');
    const step3 = makeItem('selected_next_step');
    const exit = makeItem('exited_loop', [loopRef('loop-1')]);
    const result = groupTraceEntries([enter, step1, step2, step3, exit]);

    const group = result[0] as LoopGroup;
    expect(group.iterationCount).toBe(3);
    expect(group.innerItems).toHaveLength(3);
  });

  it('emits orphaned entered_loop as standalone (no matching exited)', () => {
    const enter = makeItem('entered_loop', [loopRef('loop-orphan')]);
    const step = makeItem('selected_next_step');
    const result = groupTraceEntries([enter, step]);

    // Both enter and the inner step should be standalone
    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe('standalone');
    expect((result[0] as StandaloneEntry).item).toBe(enter);
    expect(result[1]!.kind).toBe('standalone');
    expect((result[1] as StandaloneEntry).item).toBe(step);
  });

  it('emits orphaned exited_loop as standalone (no matching entered)', () => {
    const exit = makeItem('exited_loop', [loopRef('loop-orphan')]);
    const result = groupTraceEntries([exit]);

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('standalone');
    expect((result[0] as StandaloneEntry).item).toBe(exit);
  });

  it('emits entered_loop with no loop_id ref as standalone', () => {
    const enter = makeItem('entered_loop', []); // no loop_id ref
    const result = groupTraceEntries([enter]);

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('standalone');
  });

  it('filters out context_fact items', () => {
    const fact = makeItem('context_fact');
    const step = makeItem('selected_next_step');
    const result = groupTraceEntries([fact, step]);

    expect(result).toHaveLength(1);
    expect((result[0] as StandaloneEntry).item).toBe(step);
  });

  it('handles non-loop standalone items correctly', () => {
    const step = makeItem('selected_next_step');
    const cond = makeItem('evaluated_condition');
    const div = makeItem('divergence');
    const result = groupTraceEntries([step, cond, div]);

    expect(result).toHaveLength(3);
    expect(result.every((e) => e.kind === 'standalone')).toBe(true);
  });

  it('sorts by recordedAtEventIndex regardless of input order', () => {
    const a = { ...makeItem('selected_next_step'), recordedAtEventIndex: 10 };
    const b = { ...makeItem('evaluated_condition'), recordedAtEventIndex: 2 };
    const c = { ...makeItem('divergence'), recordedAtEventIndex: 7 };
    const result = groupTraceEntries([a, b, c]);

    expect((result[0] as StandaloneEntry).item.recordedAtEventIndex).toBe(2);
    expect((result[1] as StandaloneEntry).item.recordedAtEventIndex).toBe(7);
    expect((result[2] as StandaloneEntry).item.recordedAtEventIndex).toBe(10);
  });

  it('handles two independent loops correctly', () => {
    const enter1 = makeItem('entered_loop', [loopRef('loop-a')]);
    const exit1 = makeItem('exited_loop', [loopRef('loop-a')]);
    const enter2 = makeItem('entered_loop', [loopRef('loop-b')]);
    const exit2 = makeItem('exited_loop', [loopRef('loop-b')]);
    const result = groupTraceEntries([enter1, exit1, enter2, exit2]);

    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe('loop_group');
    expect((result[0] as LoopGroup).loopId).toBe('loop-a');
    expect(result[1]!.kind).toBe('loop_group');
    expect((result[1] as LoopGroup).loopId).toBe('loop-b');
  });
});

// ---------------------------------------------------------------------------
// getNodeRoutingItems tests
// ---------------------------------------------------------------------------

describe('getNodeRoutingItems', () => {
  it('returns empty arrays when summary has no items', () => {
    const result = getNodeRoutingItems(makeSummary([]), 'node-1');
    expect(result.whySelected).toHaveLength(0);
    expect(result.conditions).toHaveLength(0);
    expect(result.loops).toHaveLength(0);
    expect(result.divergences).toHaveLength(0);
    expect(result.forks).toHaveLength(0);
  });

  it('returns empty arrays when no items reference the given nodeId', () => {
    const item = makeItem('selected_next_step', [nodeRef('node-other')]);
    const result = getNodeRoutingItems(makeSummary([item]), 'node-1');
    expect(result.whySelected).toHaveLength(0);
  });

  it('categorizes selected_next_step into whySelected', () => {
    const item = makeItem('selected_next_step', [nodeRef('node-1')]);
    const result = getNodeRoutingItems(makeSummary([item]), 'node-1');
    expect(result.whySelected).toHaveLength(1);
    expect(result.whySelected[0]).toBe(item);
  });

  it('categorizes evaluated_condition into conditions', () => {
    const item = makeItem('evaluated_condition', [nodeRef('node-1')]);
    const result = getNodeRoutingItems(makeSummary([item]), 'node-1');
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]).toBe(item);
  });

  it('categorizes entered_loop and exited_loop into loops', () => {
    const enter = makeItem('entered_loop', [nodeRef('node-1')]);
    const exit = makeItem('exited_loop', [nodeRef('node-1')]);
    const result = getNodeRoutingItems(makeSummary([enter, exit]), 'node-1');
    expect(result.loops).toHaveLength(2);
  });

  it('categorizes divergence into divergences', () => {
    const item = makeItem('divergence', [nodeRef('node-1')]);
    const result = getNodeRoutingItems(makeSummary([item]), 'node-1');
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toBe(item);
  });

  it('categorizes detected_non_tip_advance into forks', () => {
    const item = makeItem('detected_non_tip_advance', [nodeRef('node-1')]);
    const result = getNodeRoutingItems(makeSummary([item]), 'node-1');
    expect(result.forks).toHaveLength(1);
    expect(result.forks[0]).toBe(item);
  });

  it('does not include items referencing a different node', () => {
    const item = makeItem('selected_next_step', [nodeRef('node-2')]);
    const result = getNodeRoutingItems(makeSummary([item]), 'node-1');
    expect(result.whySelected).toHaveLength(0);
  });

  it('includes items that reference the node among multiple refs', () => {
    const item = makeItem('selected_next_step', [
      { kind: 'step_id', value: 'step-abc' },
      nodeRef('node-1'),
    ]);
    const result = getNodeRoutingItems(makeSummary([item]), 'node-1');
    expect(result.whySelected).toHaveLength(1);
  });
});
