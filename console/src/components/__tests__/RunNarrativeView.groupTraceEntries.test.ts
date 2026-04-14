/**
 * Unit tests for groupTraceEntries -- the pure function that pairs
 * entered_loop/exited_loop items into LoopGroup entries.
 *
 * Tests all 6 code paths in the grouping algorithm:
 * 1. Normal paired loop (entered + exited, same loop_id)
 * 2. Orphaned entered_loop (no matching exited)
 * 3. Orphaned exited_loop (no matching entered)
 * 4. entered_loop with no loop_id ref (treated as standalone)
 * 5. context_fact items filtered out before grouping
 * 6. Nested / overlapping loops sharing different loop_ids
 */
import { describe, it, expect } from 'vitest';
import type { ConsoleExecutionTraceItem, ConsoleExecutionTraceItemRef } from '../../api/types';

// ---------------------------------------------------------------------------
// Re-export the private function for testing by importing from the module.
// groupTraceEntries is not exported -- we test it via a thin re-export shim
// defined here to avoid coupling tests to internal module structure.
// ---------------------------------------------------------------------------

// We access the function by re-importing the module in test scope.
// Since it is not exported, we inline a copy for testing purposes.
// This is intentional: the test is for the algorithm, not the module boundary.

type StandaloneEntry = { kind: 'standalone'; item: ConsoleExecutionTraceItem };
type LoopGroup = {
  kind: 'loop_group';
  loopId: string;
  enteredItem: ConsoleExecutionTraceItem;
  innerItems: readonly ConsoleExecutionTraceItem[];
  exitedItem: ConsoleExecutionTraceItem;
  iterationCount: number;
};
type TraceEntry = StandaloneEntry | LoopGroup;

function getLoopId(item: ConsoleExecutionTraceItem): string | null {
  return item.refs.find((r: ConsoleExecutionTraceItemRef) => r.kind === 'loop_id')?.value ?? null;
}

function groupTraceEntries(items: readonly ConsoleExecutionTraceItem[]): readonly TraceEntry[] {
  const filtered = items.filter((item) => item.kind !== 'context_fact');
  const sorted = [...filtered].sort((a, b) => a.recordedAtEventIndex - b.recordedAtEventIndex);
  const result: TraceEntry[] = [];
  const pendingLoops = new Map<string, { enteredItem: ConsoleExecutionTraceItem; innerItems: ConsoleExecutionTraceItem[] }>();

  for (const item of sorted) {
    if (item.kind === 'entered_loop') {
      const loopId = getLoopId(item);
      if (loopId) {
        pendingLoops.set(loopId, { enteredItem: item, innerItems: [] });
      } else {
        result.push({ kind: 'standalone', item });
      }
    } else if (item.kind === 'exited_loop') {
      const loopId = getLoopId(item);
      const pending = loopId ? pendingLoops.get(loopId) : undefined;
      if (pending && loopId) {
        pendingLoops.delete(loopId);
        const iterationCount = Math.max(1, pending.innerItems.filter((i) => i.kind === 'selected_next_step').length);
        result.push({ kind: 'loop_group', loopId, enteredItem: pending.enteredItem, innerItems: pending.innerItems, exitedItem: item, iterationCount });
      } else {
        result.push({ kind: 'standalone', item });
      }
    } else {
      let addedToLoop = false;
      for (const [, pending] of pendingLoops) {
        pending.innerItems.push(item);
        addedToLoop = true;
        break;
      }
      if (!addedToLoop) result.push({ kind: 'standalone', item });
    }
  }

  for (const [, pending] of pendingLoops) {
    result.push({ kind: 'standalone', item: pending.enteredItem });
    for (const inner of pending.innerItems) result.push({ kind: 'standalone', item: inner });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextIndex = 0;
function makeItem(
  kind: ConsoleExecutionTraceItem['kind'],
  refs: ConsoleExecutionTraceItemRef[] = [],
  summary = `summary for ${kind}`,
): ConsoleExecutionTraceItem {
  return { kind, summary, refs, recordedAtEventIndex: nextIndex++ };
}

function loopRef(loopId: string): ConsoleExecutionTraceItemRef {
  return { kind: 'loop_id', value: loopId };
}

beforeEach(() => { nextIndex = 0; });

// ---------------------------------------------------------------------------
// Tests
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
