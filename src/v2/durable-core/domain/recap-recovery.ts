import type { Result } from 'neverthrow';
import { ok } from 'neverthrow';
import type { RunDagRunV2, RunDagNodeV2 } from '../../../v2/projections/run-dag.js';
import type { NodeOutputsProjectionV2 } from '../../../v2/projections/node-outputs.js';
import type { NodeId } from '../ids/index.js';
import { PAYLOAD_KIND } from '../constants.js';

export type RecapRecoveryError = {
  readonly code: 'RECAP_RECOVERY_FAILED';
  readonly message: string;
};

/**
 * Collect recap outputs from ancestry chain (current node back to root).
 * 
 * Lock: Most-recent-first ordering for deterministic budgeting.
 */
export function collectAncestryRecap(args: {
  readonly nodeId: NodeId;
  readonly dag: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
  readonly includeCurrentNode: boolean;
}): Result<readonly string[], RecapRecoveryError> {
  // Build ancestry chain iteratively to avoid O(N²) Set allocations.
  // Each level of the recursive version did `new Set([...visited, cur])` which
  // copies the entire visited set -- O(N) work per level for an O(N²) total.
  // The iterative version mutates a single Set; the chain order is identical:
  // [startNode, parent, grandparent, ...] tip-to-root.
  const buildChain = (start: string | null): readonly string[] => {
    const result: string[] = [];
    const visited = new Set<string>();
    let cur: string | null = start;
    while (cur !== null && !visited.has(cur)) {
      visited.add(cur);
      result.push(cur);
      cur = args.dag.nodesById[cur]?.parentNodeId ?? null;
    }
    return result;
  };

  const startNode = args.includeCurrentNode
    ? String(args.nodeId)
    : args.dag.nodesById[String(args.nodeId)]?.parentNodeId ?? null;

  const chain = buildChain(startNode);

  // Extract recaps functionally
  const recaps = chain.flatMap((nodeId: string) => {
    const nodeOutputs = args.outputs.nodesById[nodeId];
    if (!nodeOutputs) return [];
    return nodeOutputs.currentByChannel.recap
      .filter(r => r.payload.payloadKind === PAYLOAD_KIND.NOTES)
      .map(r => {
        if (r.payload.payloadKind === PAYLOAD_KIND.NOTES) {
          return r.payload.notesMarkdown;
        }
        return ''; // Type guard fallback
      })
      .filter(s => s.length > 0);
  });

  // Reverse for most-recent-first ordering (lock requirement line 15)
  return ok([...recaps].reverse());
}

/**
 * Collect recap outputs from downstream (current node to preferred tip).
 * 
 * Lock: Chronological ordering (forward along preferred branch).
 */
export function collectDownstreamRecap(args: {
  readonly fromNodeId: NodeId;
  readonly toNodeId: NodeId; // preferredTipNodeId
  readonly dag: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
}): Result<readonly string[], RecapRecoveryError> {
  // Build path from tip backward to fromNode iteratively.
  // Same O(N²) Set allocation hazard as buildChain -- fixed with a single
  // mutable Set. Output order is identical: [toNodeId, ..., child_of_fromNodeId].
  const buildPathBackward = (start: string): readonly string[] => {
    const result: string[] = [];
    const visited = new Set<string>();
    const fromId = String(args.fromNodeId);
    let cur: string | null = start;
    while (cur !== null && cur !== fromId && !visited.has(cur)) {
      visited.add(cur);
      result.push(cur);
      cur = args.dag.nodesById[cur]?.parentNodeId ?? null;
    }
    return result;
  };

  const pathBackward = buildPathBackward(String(args.toNodeId));

  // Extract recaps in chronological order (reverse the backward path)
  const recaps = [...pathBackward].reverse().flatMap((nodeId: string) => {
    const nodeOutputs = args.outputs.nodesById[nodeId];
    if (!nodeOutputs) return [];
    return nodeOutputs.currentByChannel.recap
      .filter(r => r.payload.payloadKind === PAYLOAD_KIND.NOTES)
      .map(r => {
        if (r.payload.payloadKind === PAYLOAD_KIND.NOTES) {
          return r.payload.notesMarkdown;
        }
        return ''; // Type guard fallback
      })
      .filter(s => s.length > 0);
  });

  return ok(recaps);
}

/**
 * Build child summary for non-tip nodes.
 */
export function buildChildSummary(args: {
  readonly nodeId: NodeId;
  readonly dag: RunDagRunV2;
}): string {
  const children = args.dag.edges.filter((e) => e.fromNodeId === args.nodeId);
  const count = children.length;

  if (count === 0) return '';
  if (count === 1) {
    return `This node has 1 child. Preferred branch tip: ${args.dag.preferredTipNodeId ?? 'unknown'}`;
  }

  return `This node has ${count} children. Preferred branch tip: ${args.dag.preferredTipNodeId ?? 'unknown'}`;
}
