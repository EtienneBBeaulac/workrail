/**
 * Unit tests for the pure helper functions in session-detail-use-cases.ts.
 *
 * These tests cover the Layer 3a DAG annotation helpers:
 *   - findEdgeCauseItem: correlates an edge to its preceding trace item
 *   - getLoopBracketsFromGroups: extracts loop bracket descriptors from grouped entries
 */
import { describe, it, expect } from 'vitest';
import type { ConsoleDagEdge, ConsoleExecutionTraceItem } from '../api/types';
import {
  findEdgeCauseItem,
  getLoopBracketsFromGroups,
  groupTraceEntries,
} from './session-detail-use-cases';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(createdAtEventIndex: number): ConsoleDagEdge {
  return {
    edgeKind: 'acked_step',
    fromNodeId: 'node-a',
    toNodeId: 'node-b',
    createdAtEventIndex,
  };
}

function makeItem(
  kind: ConsoleExecutionTraceItem['kind'],
  recordedAtEventIndex: number,
  summary = `summary for ${kind} at ${recordedAtEventIndex}`,
  refs: ConsoleExecutionTraceItem['refs'] = [],
): ConsoleExecutionTraceItem {
  return { kind, recordedAtEventIndex, summary, refs };
}

// ---------------------------------------------------------------------------
// findEdgeCauseItem
// ---------------------------------------------------------------------------

describe('findEdgeCauseItem', () => {
  it('returns null when items is empty', () => {
    const edge = makeEdge(10);
    expect(findEdgeCauseItem(edge, [])).toBeNull();
  });

  it('returns null when all items are after the edge', () => {
    const edge = makeEdge(5);
    const items = [makeItem('selected_next_step', 6), makeItem('evaluated_condition', 7)];
    expect(findEdgeCauseItem(edge, items)).toBeNull();
  });

  it('returns null when items only have non-cause kinds (context_fact, entered_loop)', () => {
    const edge = makeEdge(10);
    const items = [makeItem('context_fact', 3), makeItem('entered_loop', 5)];
    expect(findEdgeCauseItem(edge, items)).toBeNull();
  });

  it('returns the immediately preceding selected_next_step item as advance', () => {
    const edge = makeEdge(10);
    const items = [makeItem('selected_next_step', 8)];
    const result = findEdgeCauseItem(edge, items);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('advance');
    expect(result!.summary).toBe('summary for selected_next_step at 8');
  });

  it('returns evaluated_condition as condition kind', () => {
    const edge = makeEdge(10);
    const items = [makeItem('evaluated_condition', 9)];
    const result = findEdgeCauseItem(edge, items);
    expect(result!.kind).toBe('condition');
  });

  it('returns detected_non_tip_advance as fork kind', () => {
    const edge = makeEdge(10);
    const items = [makeItem('detected_non_tip_advance', 7)];
    const result = findEdgeCauseItem(edge, items);
    expect(result!.kind).toBe('fork');
  });

  it('returns divergence as divergence kind', () => {
    const edge = makeEdge(10);
    const items = [makeItem('divergence', 6)];
    const result = findEdgeCauseItem(edge, items);
    expect(result!.kind).toBe('divergence');
  });

  it('picks the highest qualifying recordedAtEventIndex <= edge index', () => {
    const edge = makeEdge(10);
    const items = [
      makeItem('selected_next_step', 3, 'old advance'),
      makeItem('selected_next_step', 8, 'recent advance'),
      makeItem('selected_next_step', 11, 'future advance'),
    ];
    const result = findEdgeCauseItem(edge, items);
    expect(result!.summary).toBe('recent advance');
  });

  it('includes items at exactly edge.createdAtEventIndex', () => {
    const edge = makeEdge(10);
    const items = [makeItem('selected_next_step', 10, 'exact match')];
    const result = findEdgeCauseItem(edge, items);
    expect(result!.summary).toBe('exact match');
  });

  it('skips context_fact and entered_loop/exited_loop items even if they are closest', () => {
    const edge = makeEdge(10);
    const items = [
      makeItem('selected_next_step', 5, 'earlier advance'),
      makeItem('context_fact', 9, 'close but wrong kind'),
      makeItem('entered_loop', 8, 'loop entry'),
      makeItem('exited_loop', 9, 'loop exit'),
    ];
    const result = findEdgeCauseItem(edge, items);
    expect(result!.kind).toBe('advance');
    expect(result!.summary).toBe('earlier advance');
  });
});

// ---------------------------------------------------------------------------
// getLoopBracketsFromGroups
// ---------------------------------------------------------------------------

describe('getLoopBracketsFromGroups', () => {
  it('returns empty array when entries contains no loop groups', () => {
    const items = [makeItem('selected_next_step', 1), makeItem('evaluated_condition', 2)];
    const entries = groupTraceEntries(items);
    expect(getLoopBracketsFromGroups(entries)).toHaveLength(0);
  });

  it('returns one bracket for a single loop group', () => {
    const items = [
      makeItem('entered_loop', 1, 'enter loop', [{ kind: 'loop_id', value: 'loop-1' }, { kind: 'node_id', value: 'node-a' }]),
      makeItem('selected_next_step', 2, 'inner step', [{ kind: 'node_id', value: 'node-b' }]),
      makeItem('exited_loop', 3, 'exit loop', [{ kind: 'loop_id', value: 'loop-1' }, { kind: 'node_id', value: 'node-c' }]),
    ];
    const entries = groupTraceEntries(items);
    const brackets = getLoopBracketsFromGroups(entries);

    expect(brackets).toHaveLength(1);
    expect(brackets[0]!.loopId).toBe('loop-1');
    // iterationCount = count of selected_next_step inner items = 1
    expect(brackets[0]!.iterationCount).toBe(1);
  });

  it('collects node_id refs from entered, exited, and inner items', () => {
    const items = [
      makeItem('entered_loop', 1, 'enter', [{ kind: 'loop_id', value: 'loop-1' }, { kind: 'node_id', value: 'node-a' }]),
      makeItem('selected_next_step', 2, 'inner 1', [{ kind: 'node_id', value: 'node-b' }]),
      makeItem('selected_next_step', 3, 'inner 2', [{ kind: 'node_id', value: 'node-c' }]),
      makeItem('exited_loop', 4, 'exit', [{ kind: 'loop_id', value: 'loop-1' }, { kind: 'node_id', value: 'node-d' }]),
    ];
    const entries = groupTraceEntries(items);
    const brackets = getLoopBracketsFromGroups(entries);

    expect(brackets).toHaveLength(1);
    const nodeIds = brackets[0]!.nodeIds;
    expect(nodeIds).toContain('node-a');
    expect(nodeIds).toContain('node-b');
    expect(nodeIds).toContain('node-c');
    expect(nodeIds).toContain('node-d');
    expect(nodeIds).toHaveLength(4);
  });

  it('deduplicates node_id refs that appear in multiple inner items', () => {
    const items = [
      makeItem('entered_loop', 1, 'enter', [{ kind: 'loop_id', value: 'loop-1' }, { kind: 'node_id', value: 'node-a' }]),
      makeItem('selected_next_step', 2, 'inner 1', [{ kind: 'node_id', value: 'node-a' }]),
      makeItem('exited_loop', 3, 'exit', [{ kind: 'loop_id', value: 'loop-1' }]),
    ];
    const entries = groupTraceEntries(items);
    const brackets = getLoopBracketsFromGroups(entries);

    // node-a appears in entered_loop AND inner selected_next_step -- must be deduped
    const nodeIds = brackets[0]!.nodeIds;
    expect(nodeIds.filter((id) => id === 'node-a')).toHaveLength(1);
  });

  it('records correct iterationCount from inner selected_next_step items', () => {
    const items = [
      makeItem('entered_loop', 1, 'enter', [{ kind: 'loop_id', value: 'loop-1' }]),
      makeItem('selected_next_step', 2, 'iter 1', []),
      makeItem('selected_next_step', 3, 'iter 2', []),
      makeItem('selected_next_step', 4, 'iter 3', []),
      makeItem('exited_loop', 5, 'exit', [{ kind: 'loop_id', value: 'loop-1' }]),
    ];
    const entries = groupTraceEntries(items);
    const brackets = getLoopBracketsFromGroups(entries);

    expect(brackets[0]!.iterationCount).toBe(3);
  });

  it('returns brackets for all loop groups in entries', () => {
    const items = [
      makeItem('entered_loop', 1, 'enter loop1', [{ kind: 'loop_id', value: 'loop-1' }]),
      makeItem('selected_next_step', 2, 'inner', []),
      makeItem('exited_loop', 3, 'exit loop1', [{ kind: 'loop_id', value: 'loop-1' }]),
      makeItem('entered_loop', 4, 'enter loop2', [{ kind: 'loop_id', value: 'loop-2' }]),
      makeItem('selected_next_step', 5, 'inner', []),
      makeItem('exited_loop', 6, 'exit loop2', [{ kind: 'loop_id', value: 'loop-2' }]),
    ];
    const entries = groupTraceEntries(items);
    const brackets = getLoopBracketsFromGroups(entries);

    expect(brackets).toHaveLength(2);
    const loopIds = brackets.map((b) => b.loopId);
    expect(loopIds).toContain('loop-1');
    expect(loopIds).toContain('loop-2');
  });

  it('ignores standalone entries', () => {
    const items = [
      makeItem('selected_next_step', 1, 'standalone'),
      makeItem('evaluated_condition', 2, 'standalone condition'),
    ];
    const entries = groupTraceEntries(items);
    const brackets = getLoopBracketsFromGroups(entries);
    expect(brackets).toHaveLength(0);
  });
});
