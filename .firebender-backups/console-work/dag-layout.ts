import type { ConsoleDagNode, ConsoleDagEdge } from '../api/types';

const NODE_WIDTH = 224;
const NODE_HEIGHT = 84;
const CHECKPOINT_SIZE = 64;
const HORIZONTAL_GAP = 48;
const ROOT_GAP = 96;
const VERTICAL_GAP = 72;

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

  const roots = nodes.filter((n) => !n.parentNodeId || !nodeById[n.parentNodeId]);
  const sortedRoots = [...roots].sort(compareNodes(nodeById));

  const depth: Record<string, number> = {};
  const queue: string[] = [];
  for (const root of sortedRoots) {
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

  for (const node of nodes) {
    if (!(node.nodeId in depth)) {
      depth[node.nodeId] = 0;
    }
  }

  const positions: Record<string, Position> = {};
  const subtreeWidthCache = new Map<string, number>();
  const childrenOfSorted: Record<string, string[]> = {};
  for (const [nodeId, children] of Object.entries(childrenOf)) {
    childrenOfSorted[nodeId] = [...children].sort(compareNodeIds(nodeById));
  }

  let cursorX = 0;
  for (const root of sortedRoots) {
    const width = measureSubtreeWidth(root.nodeId, childrenOfSorted, nodeById, subtreeWidthCache);
    placeSubtree(root.nodeId, cursorX, depth, childrenOfSorted, nodeById, subtreeWidthCache, positions);
    cursorX += width + ROOT_GAP;
  }

  const minX = Math.min(...Object.values(positions).map((position) => position.x));
  const maxX = Math.max(...Object.values(positions).map((position) => position.x));
  const midpoint = (minX + maxX) / 2;
  for (const position of Object.values(positions)) {
    position.x -= midpoint;
  }

  return positions;
}

function placeSubtree(
  nodeId: string,
  leftX: number,
  depthById: Readonly<Record<string, number>>,
  childrenOf: Readonly<Record<string, readonly string[]>>,
  nodeById: Readonly<Record<string, ConsoleDagNode>>,
  subtreeWidthCache: ReadonlyMap<string, number>,
  positions: Record<string, Position>,
): void {
  const width = subtreeWidthCache.get(nodeId) ?? getNodeWidth(nodeById[nodeId]);
  const children = childrenOf[nodeId] ?? [];
  const centerX = leftX + width / 2;
  const nodeWidth = getNodeWidth(nodeById[nodeId]);

  positions[nodeId] = {
    x: centerX - nodeWidth / 2,
    y: (depthById[nodeId] ?? 0) * (NODE_HEIGHT + VERTICAL_GAP),
  };

  let childLeftX = leftX;
  for (const childId of children) {
    const childWidth = subtreeWidthCache.get(childId) ?? getNodeWidth(nodeById[childId]);
    placeSubtree(childId, childLeftX, depthById, childrenOf, nodeById, subtreeWidthCache, positions);
    childLeftX += childWidth + HORIZONTAL_GAP;
  }
}

function measureSubtreeWidth(
  nodeId: string,
  childrenOf: Readonly<Record<string, readonly string[]>>,
  nodeById: Readonly<Record<string, ConsoleDagNode>>,
  subtreeWidthCache: Map<string, number>,
): number {
  const cached = subtreeWidthCache.get(nodeId);
  if (cached !== undefined) return cached;

  const children = childrenOf[nodeId] ?? [];
  const ownWidth = getNodeWidth(nodeById[nodeId]);
  if (children.length === 0) {
    subtreeWidthCache.set(nodeId, ownWidth);
    return ownWidth;
  }

  let totalChildrenWidth = 0;
  for (let i = 0; i < children.length; i++) {
    totalChildrenWidth += measureSubtreeWidth(children[i]!, childrenOf, nodeById, subtreeWidthCache);
    if (i < children.length - 1) {
      totalChildrenWidth += HORIZONTAL_GAP;
    }
  }

  const width = Math.max(ownWidth, totalChildrenWidth);
  subtreeWidthCache.set(nodeId, width);
  return width;
}

function getNodeWidth(node: ConsoleDagNode | undefined): number {
  if (!node) return NODE_WIDTH;
  return node.nodeKind === 'checkpoint' ? CHECKPOINT_SIZE : NODE_WIDTH;
}

function compareNodeIds(nodeById: Readonly<Record<string, ConsoleDagNode>>) {
  return (a: string, b: string): number => compareNodes(nodeById)(nodeById[a]!, nodeById[b]!);
}

function compareNodes(_nodeById: Readonly<Record<string, ConsoleDagNode>>) {
  return (a: ConsoleDagNode, b: ConsoleDagNode): number => {
    const nodeKindOrder = getNodeKindOrder(a.nodeKind) - getNodeKindOrder(b.nodeKind);
    if (nodeKindOrder !== 0) return nodeKindOrder;

    const indexOrder = a.createdAtEventIndex - b.createdAtEventIndex;
    if (indexOrder !== 0) return indexOrder;

    return a.nodeId.localeCompare(b.nodeId);
  };
}

function getNodeKindOrder(kind: ConsoleDagNode['nodeKind']): number {
  switch (kind) {
    case 'step':
      return 0;
    case 'checkpoint':
      return 1;
    case 'blocked_attempt':
      return 2;
  }
}
