/**
 * Pure use-case functions and types for the Session Detail view.
 *
 * No React, no side effects. All functions are deterministic.
 */
import type { ConsoleDagEdge, ConsoleExecutionTraceItem, ConsoleExecutionTraceSummary } from '../api/types';

// ---------------------------------------------------------------------------
// Condition evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic: determines whether an evaluated_condition trace item represents
 * a condition that passed (true) or was skipped/false.
 *
 * The engine summary strings currently use natural language -- this will be
 * replaced by a structured `passed: boolean` field when the backend adds it.
 */
export function isConditionPassed(item: ConsoleExecutionTraceItem): boolean {
  return /\btrue\b|\bpass/i.test(item.summary);
}

// ---------------------------------------------------------------------------
// Execution trace grouping types
// ---------------------------------------------------------------------------

export type StandaloneEntry = {
  readonly kind: 'standalone';
  readonly item: ConsoleExecutionTraceItem;
};

export type LoopGroup = {
  readonly kind: 'loop_group';
  readonly loopId: string;
  readonly enteredItem: ConsoleExecutionTraceItem;
  readonly innerItems: readonly ConsoleExecutionTraceItem[];
  readonly exitedItem: ConsoleExecutionTraceItem;
  readonly iterationCount: number;
};

export type TraceEntry = StandaloneEntry | LoopGroup;

// ---------------------------------------------------------------------------
// Loop grouping logic
//
// INVARIANT: entered_loop and exited_loop items are matched by loop_id ref value.
// An orphaned entered_loop (no matching exited_loop) is rendered as a standalone
// [ LOOP ] entry rather than dropped silently.
//
// Algorithm:
// 1. Linear scan over items sorted by recordedAtEventIndex.
// 2. When an entered_loop is seen, start accumulating a pending group keyed by loop_id.
// 3. When an exited_loop is seen with a matching loop_id, close the group.
// 4. All other items are rendered as standalone entries.
// 5. Any pending (unclosed) groups at end-of-list become standalone entries.
// ---------------------------------------------------------------------------

function getLoopId(item: ConsoleExecutionTraceItem): string | null {
  return item.refs.find((r) => r.kind === 'loop_id')?.value ?? null;
}

/**
 * Groups entered_loop/exited_loop pairs by loop_id.
 * context_fact items are excluded (shown via contextFacts chips instead).
 */
export function groupTraceEntries(items: readonly ConsoleExecutionTraceItem[]): readonly TraceEntry[] {
  // Filter out context_fact items -- they are shown as chips, not list entries.
  const filtered = items.filter((item) => item.kind !== 'context_fact');
  const sorted = [...filtered].sort((a, b) => a.recordedAtEventIndex - b.recordedAtEventIndex);

  const result: TraceEntry[] = [];
  // Map of loopId -> { enteredItem, innerItems } for open (unclosed) loops.
  // loopStack tracks the insertion order so inner items always go to the
  // most-recently-opened (innermost) loop rather than the oldest open loop.
  const pendingLoops = new Map<string, { enteredItem: ConsoleExecutionTraceItem; innerItems: ConsoleExecutionTraceItem[] }>();
  const loopStack: string[] = []; // loopIds in open order, most recent at end

  for (const item of sorted) {
    if (item.kind === 'entered_loop') {
      const loopId = getLoopId(item);
      if (loopId) {
        pendingLoops.set(loopId, { enteredItem: item, innerItems: [] });
        loopStack.push(loopId);
      } else {
        // No loop_id ref -- treat as standalone
        result.push({ kind: 'standalone', item });
      }
    } else if (item.kind === 'exited_loop') {
      const loopId = getLoopId(item);
      const pending = loopId ? pendingLoops.get(loopId) : undefined;
      if (pending && loopId) {
        pendingLoops.delete(loopId);
        const stackIdx = loopStack.lastIndexOf(loopId);
        if (stackIdx !== -1) loopStack.splice(stackIdx, 1);
        // Count iterations: number of selected_next_step items inside the loop
        const iterationCount = Math.max(
          1,
          pending.innerItems.filter((i) => i.kind === 'selected_next_step').length,
        );
        result.push({
          kind: 'loop_group',
          loopId,
          enteredItem: pending.enteredItem,
          innerItems: pending.innerItems,
          exitedItem: item,
          iterationCount,
        });
      } else {
        // Orphaned exited_loop -- treat as standalone
        result.push({ kind: 'standalone', item });
      }
    } else {
      // Non-loop item: add to the innermost open loop (last in stack), or standalone
      const innermostLoopId = loopStack.at(-1);
      const activePending = innermostLoopId ? pendingLoops.get(innermostLoopId) : undefined;
      if (activePending) {
        activePending.innerItems.push(item);
      } else {
        result.push({ kind: 'standalone', item });
      }
    }
  }

  // Flush any unclosed (orphaned) loops as standalone entries
  for (const [, pending] of pendingLoops) {
    result.push({ kind: 'standalone', item: pending.enteredItem });
    for (const inner of pending.innerItems) {
      result.push({ kind: 'standalone', item: inner });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Edge cause correlation
// ---------------------------------------------------------------------------

/**
 * The kind of execution event that preceded (caused) an edge transition.
 *
 * Maps to trace item kinds, normalized to a smaller vocabulary for rendering:
 * - 'condition'  <- evaluated_condition
 * - 'fork'       <- detected_non_tip_advance
 * - 'divergence' <- divergence
 * - 'advance'    <- selected_next_step (normal step advance)
 */
export type EdgeCauseKind = 'condition' | 'fork' | 'divergence' | 'advance';

export interface EdgeCause {
  readonly kind: EdgeCauseKind;
  readonly summary: string;
}

/** Returns the EdgeCauseKind for a trace item kind, or null if the item kind
 *  is not one that causes an edge (e.g., context_fact, entered_loop). */
function edgeCauseKindFromItem(item: ConsoleExecutionTraceItem): EdgeCauseKind | null {
  switch (item.kind) {
    case 'evaluated_condition': return 'condition';
    case 'detected_non_tip_advance': return 'fork';
    case 'divergence': return 'divergence';
    case 'selected_next_step': return 'advance';
    default: return null;
  }
}

/**
 * Finds the trace item that most likely caused (preceded) this edge.
 *
 * Algorithm: linear scan over all items, find the one whose recordedAtEventIndex
 * is the largest value still <= the edge's createdAtEventIndex and whose kind
 * maps to an EdgeCauseKind.
 *
 * Returns null when no qualifying item exists (e.g., no trace for this edge yet,
 * or the edge was created before any relevant trace items).
 *
 * NOTE: Edge midpoints for cause diamonds are geometric approximations (midpoint
 * of the two node centers). Smoothstep curves don't pass through this exact point,
 * but the visual approximation is sufficient for a 10px annotation.
 */
export function findEdgeCauseItem(
  edge: ConsoleDagEdge,
  items: readonly ConsoleExecutionTraceItem[],
): EdgeCause | null {
  let best: EdgeCause | null = null;
  let bestIndex = -1;

  for (const item of items) {
    const kind = edgeCauseKindFromItem(item);
    if (kind === null) continue;
    if (item.recordedAtEventIndex > edge.createdAtEventIndex) continue;
    if (item.recordedAtEventIndex > bestIndex) {
      bestIndex = item.recordedAtEventIndex;
      best = { kind, summary: item.summary };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Loop bracket extraction
// ---------------------------------------------------------------------------

/**
 * Represents a single loop bracket to render in the DAG gutter.
 *
 * nodeIds: all DAG node IDs referenced by the entered_loop or exited_loop
 * items in this group (via node_id refs). Used to determine the Y range
 * for the bracket line.
 */
export interface LoopBracket {
  readonly loopId: string;
  readonly iterationCount: number;
  readonly nodeIds: readonly string[];
}

/**
 * Extracts LoopBracket descriptors from a list of grouped trace entries.
 *
 * Only `loop_group` entries (paired entered_loop/exited_loop) produce brackets.
 * Standalone entries are ignored.
 *
 * NOTE: Suppression for iterationCount === 1 is intentionally left to the
 * render layer (RunLineageDag.tsx) so this function remains generic and testable
 * without render-layer assumptions.
 */
export function getLoopBracketsFromGroups(
  entries: readonly TraceEntry[],
): readonly LoopBracket[] {
  const brackets: LoopBracket[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'loop_group') continue;

    // Collect all node_id refs from the entered_loop item
    const enteredNodeIds = entry.enteredItem.refs
      .filter((r) => r.kind === 'node_id')
      .map((r) => r.value);

    // Collect all node_id refs from the exited_loop item
    const exitedNodeIds = entry.exitedItem.refs
      .filter((r) => r.kind === 'node_id')
      .map((r) => r.value);

    // Collect node_id refs from all inner items too, to span the full loop range
    const innerNodeIds = entry.innerItems.flatMap((item) =>
      item.refs.filter((r) => r.kind === 'node_id').map((r) => r.value),
    );

    // Deduplicate -- a node may be referenced by multiple inner items
    const allNodeIds = [...new Set([...enteredNodeIds, ...exitedNodeIds, ...innerNodeIds])];

    brackets.push({
      loopId: entry.loopId,
      iterationCount: entry.iterationCount,
      nodeIds: allNodeIds,
    });
  }

  return brackets;
}

// ---------------------------------------------------------------------------
// Node routing items
// ---------------------------------------------------------------------------

export interface NodeRoutingItems {
  readonly whySelected: readonly ConsoleExecutionTraceItem[];
  readonly conditions: readonly ConsoleExecutionTraceItem[];
  readonly loops: readonly ConsoleExecutionTraceItem[];
  readonly divergences: readonly ConsoleExecutionTraceItem[];
  readonly forks: readonly ConsoleExecutionTraceItem[];
}

/**
 * Extracts and categorizes execution trace items relevant to a specific node.
 *
 * Items are included when they reference the given nodeId via a node_id ref.
 * Results are split by item kind to drive the RoutingSection UI.
 */
export function getNodeRoutingItems(
  summary: ConsoleExecutionTraceSummary,
  nodeId: string,
): NodeRoutingItems {
  const nodeItems = summary.items.filter(
    (item) => item.refs.some((r) => r.kind === 'node_id' && r.value === nodeId),
  );

  return {
    whySelected: nodeItems.filter((i) => i.kind === 'selected_next_step'),
    conditions: nodeItems.filter((i) => i.kind === 'evaluated_condition'),
    loops: nodeItems.filter((i) => i.kind === 'entered_loop' || i.kind === 'exited_loop'),
    divergences: nodeItems.filter((i) => i.kind === 'divergence'),
    // detected_non_tip_advance always has a node_id ref (run-execution-trace.ts prepends one)
    forks: nodeItems.filter((i) => i.kind === 'detected_non_tip_advance'),
  };
}
