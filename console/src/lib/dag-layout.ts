import type { ConsoleDagNode, ConsoleDagEdge } from '../api/types';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const HORIZONTAL_GAP = 40;
const VERTICAL_GAP = 40;

interface Position {
  x: number;
  y: number;
}

/**
 * Simple top-down DAG layout.
 *
 * Algorithm:
 * 1. Find root nodes (no parentNodeId)
 * 2. Assign depth (distance from root) via BFS
 * 3. Assign horizontal position within each depth level
 *
 * Returns a map from nodeId to {x, y} position.
 */
export function layoutDag(
  nodes: readonly ConsoleDagNode[],
  _edges: readonly ConsoleDagEdge[],
): Record<string, Position> {
  if (nodes.length === 0) return {};

  // Build parent -> children lookup
  const childrenOf: Record<string, string[]> = {};
  const nodeById: Record<string, ConsoleDagNode> = {};
  for (const node of nodes) {
    nodeById[node.nodeId] = node;
    if (!childrenOf[node.nodeId]) childrenOf[node.nodeId] = [];
  }
  for (const node of nodes) {
    if (node.parentNodeId && childrenOf[node.parentNodeId]) {
      childrenOf[node.parentNodeId]!.push(node.nodeId);
    }
  }

  // Find roots (nodes with no parent or parent not in this run)
  const roots = nodes.filter((n) => !n.parentNodeId || !nodeById[n.parentNodeId]);

  // BFS to assign depths
  const depth: Record<string, number> = {};
  const queue: string[] = [];
  for (const root of roots) {
    depth[root.nodeId] = 0;
    queue.push(root.nodeId);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const children = childrenOf[nodeId] ?? [];
    for (const childId of children) {
      if (!(childId in depth)) {
        depth[childId] = depth[nodeId]! + 1;
        queue.push(childId);
      }
    }
  }

  // Handle orphans (nodes not reached by BFS)
  for (const node of nodes) {
    if (!(node.nodeId in depth)) {
      depth[node.nodeId] = 0;
    }
  }

  // Group by depth level
  const levels: Record<number, string[]> = {};
  let maxDepth = 0;
  for (const [nodeId, d] of Object.entries(depth)) {
    if (!levels[d]) levels[d] = [];
    levels[d]!.push(nodeId);
    if (d > maxDepth) maxDepth = d;
  }

  // Sort within each level by createdAtEventIndex for determinism
  for (const d of Object.keys(levels)) {
    levels[Number(d)]!.sort((a, b) => {
      const na = nodeById[a];
      const nb = nodeById[b];
      return (na?.createdAtEventIndex ?? 0) - (nb?.createdAtEventIndex ?? 0);
    });
  }

  // Assign positions
  const positions: Record<string, Position> = {};
  for (let d = 0; d <= maxDepth; d++) {
    const nodesAtLevel = levels[d] ?? [];
    const totalWidth = nodesAtLevel.length * NODE_WIDTH + (nodesAtLevel.length - 1) * HORIZONTAL_GAP;
    const startX = -totalWidth / 2;

    for (let i = 0; i < nodesAtLevel.length; i++) {
      positions[nodesAtLevel[i]!] = {
        x: startX + i * (NODE_WIDTH + HORIZONTAL_GAP),
        y: d * (NODE_HEIGHT + VERTICAL_GAP),
      };
    }
  }

  return positions;
}
