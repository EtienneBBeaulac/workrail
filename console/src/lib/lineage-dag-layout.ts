import type { ConsoleDagEdge, ConsoleDagNode, ConsoleDagRun } from '../api/types';

export const LINEAGE_COLUMN_WIDTH = 268;
export const LINEAGE_ROW_HEIGHT = 112;
export const LINEAGE_PADDING = 56;
export const ACTIVE_NODE_WIDTH = 220;
export const SIDE_NODE_WIDTH = 172;
export const ACTIVE_NODE_HEIGHT = 124;
export const SIDE_NODE_HEIGHT = 104;

interface PositionedLineageNode {
  readonly node: ConsoleDagNode;
  readonly depth: number;
  readonly lane: number;
  readonly x: number;
  readonly y: number;
  readonly isActiveLineage: boolean;
  readonly isCurrent: boolean;
  readonly branchKind: 'active' | 'blocked' | 'alternate';
  readonly branchIndex: number | null;
}

interface LineageSummary {
  readonly currentNodeLabel: string;
  readonly lineageNodeCount: number;
  readonly sideNodeCount: number;
  readonly alternateBranchCount: number;
  readonly blockedAttemptCount: number;
}

export interface LineageDagModel {
  readonly nodes: readonly PositionedLineageNode[];
  readonly edges: readonly ConsoleDagEdge[];
  readonly graphWidth: number;
  readonly graphHeight: number;
  readonly currentNodeId: string | null;
  readonly startNodeId: string | null;
  readonly latestBranchNodeId: string | null;
  readonly compressedBeforeCount: number;
  readonly visibleLineageStartNodeId: string | null;
  readonly summary: LineageSummary;
}

export function buildLineageDagModel(run: ConsoleDagRun): LineageDagModel {
  if (run.nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      graphWidth: LINEAGE_PADDING * 2,
      graphHeight: LINEAGE_PADDING * 2,
      currentNodeId: null,
      startNodeId: null,
      latestBranchNodeId: null,
      compressedBeforeCount: 0,
      visibleLineageStartNodeId: null,
      summary: {
        currentNodeLabel: 'No active node',
        lineageNodeCount: 0,
        sideNodeCount: 0,
        alternateBranchCount: 0,
        blockedAttemptCount: 0,
      },
    };
  }

  const nodeById = new Map(run.nodes.map((node) => [node.nodeId, node] as const));
  const childrenByParent = new Map<string, ConsoleDagNode[]>();

  for (const node of run.nodes) {
    if (!node.parentNodeId) continue;
    const siblings = childrenByParent.get(node.parentNodeId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentNodeId, siblings);
  }

  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.createdAtEventIndex - right.createdAtEventIndex);
  }

  const currentNodeId = pickCurrentNodeId(run);
  const activeLineageIds = currentNodeId
    ? collectActiveLineageIds(currentNodeId, nodeById)
    : new Set<string>();
  const depthById = buildDepthMap(run.nodes, nodeById);
  const laneById = new Map<string, number>();
  const branchKindById = new Map<string, PositionedLineageNode['branchKind']>();
  const branchIndexById = new Map<string, number | null>();
  const alternateBranchRootIds = new Set<string>();
  const blockedBranchRootIds = new Set<string>();
  let sideLaneCounter = 0;
  let branchCounter = 0;
  const visibleLineageWindowSize = 8;

  const allocateSideLane = (): number => {
    sideLaneCounter += 1;
    const magnitude = Math.ceil(sideLaneCounter / 2);
    return sideLaneCounter % 2 === 1 ? -magnitude : magnitude;
  };

  const assignSideSubtree = (
    nodeId: string,
    lane: number,
    branchKind: PositionedLineageNode['branchKind'],
    branchIndex: number | null,
  ): void => {
    if (laneById.has(nodeId)) return;

    laneById.set(nodeId, lane);
    branchKindById.set(nodeId, branchKind);
    branchIndexById.set(nodeId, branchIndex);
    const children = childrenByParent.get(nodeId) ?? [];
    if (children.length === 0) return;

    const [trunkChild, ...branchChildren] = children;
    if (trunkChild) {
      assignSideSubtree(trunkChild.nodeId, lane, branchKind, branchIndex);
    }

    let branchOffset = 1;
    for (const child of branchChildren) {
      const nextLane = lane < 0 ? lane - branchOffset : lane + branchOffset;
      assignSideSubtree(child.nodeId, nextLane, branchKind, branchIndex);
      branchOffset += 1;
    }
  };

  const activeLineagePath = [...activeLineageIds].sort(
    (left, right) => (depthById.get(left) ?? 0) - (depthById.get(right) ?? 0),
  );
  const compressedBeforeCount = Math.max(0, activeLineagePath.length - visibleLineageWindowSize);
  const visibleLineageIds = new Set(activeLineagePath.slice(-visibleLineageWindowSize));
  const visibleLineageStartNodeId = activeLineagePath.slice(-visibleLineageWindowSize)[0] ?? activeLineagePath[0] ?? null;

  for (const nodeId of activeLineagePath) {
    laneById.set(nodeId, 0);
    branchKindById.set(nodeId, 'active');
    branchIndexById.set(nodeId, null);
    const children = childrenByParent.get(nodeId) ?? [];
    for (const child of children) {
      if (activeLineageIds.has(child.nodeId)) continue;
      branchCounter += 1;
      const branchKind = child.nodeKind === 'blocked_attempt' ? 'blocked' : 'alternate';
      if (branchKind === 'blocked') {
        blockedBranchRootIds.add(child.nodeId);
      } else {
        alternateBranchRootIds.add(child.nodeId);
      }
      assignSideSubtree(child.nodeId, allocateSideLane(), branchKind, branchCounter);
    }
  }

  const rootNodes = run.nodes
    .filter((node) => !node.parentNodeId || !nodeById.has(node.parentNodeId))
    .sort((left, right) => left.createdAtEventIndex - right.createdAtEventIndex);

  for (const root of rootNodes) {
    if (laneById.has(root.nodeId)) continue;
    if (!activeLineageIds.has(root.nodeId)) {
      branchCounter += 1;
      const branchKind = root.nodeKind === 'blocked_attempt' ? 'blocked' : 'alternate';
      if (branchKind === 'blocked') {
        blockedBranchRootIds.add(root.nodeId);
      } else {
        alternateBranchRootIds.add(root.nodeId);
      }
      assignSideSubtree(root.nodeId, allocateSideLane(), branchKind, branchCounter);
      continue;
    }

    laneById.set(root.nodeId, 0);
    branchKindById.set(root.nodeId, 'active');
    branchIndexById.set(root.nodeId, null);
  }

  for (const node of run.nodes) {
    if (!laneById.has(node.nodeId)) {
      branchCounter += 1;
      const branchKind = node.nodeKind === 'blocked_attempt' ? 'blocked' : 'alternate';
      if (branchKind === 'blocked') {
        blockedBranchRootIds.add(node.nodeId);
      } else {
        alternateBranchRootIds.add(node.nodeId);
      }
      assignSideSubtree(node.nodeId, allocateSideLane(), branchKind, branchCounter);
    }
  }

  const minLane = Math.min(...laneById.values());
  const maxLane = Math.max(...laneById.values());

  const visibleDepthById = buildVisibleDepthMap(
    run.nodes,
    depthById,
    nodeById,
    visibleLineageIds,
    compressedBeforeCount,
  );

  const maxVisibleDepth = Math.max(...run.nodes.map((node) => visibleDepthById.get(node.nodeId) ?? 0));

  const positionedNodes: PositionedLineageNode[] = run.nodes.map((node) => {
    const isActiveLineage = activeLineageIds.has(node.nodeId);
    const visibleDepth = visibleDepthById.get(node.nodeId) ?? 0;
    return {
      node,
      depth: visibleDepth,
      lane: laneById.get(node.nodeId) ?? 0,
      x: LINEAGE_PADDING + visibleDepth * LINEAGE_COLUMN_WIDTH,
      y: LINEAGE_PADDING + ((laneById.get(node.nodeId) ?? 0) - minLane) * LINEAGE_ROW_HEIGHT,
      isActiveLineage,
      isCurrent: node.nodeId === currentNodeId,
      branchKind: branchKindById.get(node.nodeId) ?? 'alternate',
      branchIndex: branchIndexById.get(node.nodeId) ?? null,
    };
  });

  const currentNode = currentNodeId ? nodeById.get(currentNodeId) ?? null : null;
  const latestBranchRootNode = [...alternateBranchRootIds, ...blockedBranchRootIds]
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is ConsoleDagNode => Boolean(node))
    .sort((left, right) => right.createdAtEventIndex - left.createdAtEventIndex)[0] ?? null;

  const summary: LineageSummary = {
    currentNodeLabel: currentNode?.stepLabel ?? (currentNode ? shortNodeId(currentNode.nodeId) : 'No active node'),
    lineageNodeCount: activeLineageIds.size,
    sideNodeCount: run.nodes.length - activeLineageIds.size,
    alternateBranchCount: alternateBranchRootIds.size,
    blockedAttemptCount: run.nodes.filter((node) => node.nodeKind === 'blocked_attempt').length,
  };

  return {
    nodes: positionedNodes,
    edges: run.edges,
    graphWidth: LINEAGE_PADDING * 2 + maxVisibleDepth * LINEAGE_COLUMN_WIDTH + ACTIVE_NODE_WIDTH,
    graphHeight: LINEAGE_PADDING * 2 + (maxLane - minLane) * LINEAGE_ROW_HEIGHT + ACTIVE_NODE_HEIGHT,
    currentNodeId,
    startNodeId: activeLineagePath[0] ?? rootNodes[0]?.nodeId ?? null,
    latestBranchNodeId: latestBranchRootNode?.nodeId ?? null,
    compressedBeforeCount,
    visibleLineageStartNodeId,
    summary,
  };
}

function pickCurrentNodeId(run: ConsoleDagRun): string | null {
  if (run.preferredTipNodeId) return run.preferredTipNodeId;

  const preferredTip = run.nodes.find((node) => node.isPreferredTip);
  if (preferredTip) return preferredTip.nodeId;

  const latestTip = run.nodes
    .filter((node) => node.isTip)
    .sort((left, right) => right.createdAtEventIndex - left.createdAtEventIndex)[0];
  if (latestTip) return latestTip.nodeId;

  return [...run.nodes].sort((left, right) => right.createdAtEventIndex - left.createdAtEventIndex)[0]?.nodeId ?? null;
}

function collectActiveLineageIds(
  currentNodeId: string,
  nodeById: ReadonlyMap<string, ConsoleDagNode>,
): Set<string> {
  const lineage = new Set<string>();
  let cursor: string | null = currentNodeId;

  while (cursor) {
    lineage.add(cursor);
    const parentId: string | null = nodeById.get(cursor)?.parentNodeId ?? null;
    cursor = parentId && nodeById.has(parentId) ? parentId : null;
  }

  return lineage;
}

function buildDepthMap(
  nodes: readonly ConsoleDagNode[],
  nodeById: ReadonlyMap<string, ConsoleDagNode>,
): Map<string, number> {
  const depthById = new Map<string, number>();
  // Guard against cycles: tracks nodes whose depth resolution is currently in progress.
  // If a node appears here on re-entry, a cycle exists and we break it by returning 0.
  const inProgress = new Set<string>();

  const resolveDepth = (nodeId: string): number => {
    const existingDepth = depthById.get(nodeId);
    if (existingDepth !== undefined) return existingDepth;

    // Cycle detected -- break by assigning depth 0 to the re-entered node.
    if (inProgress.has(nodeId)) {
      depthById.set(nodeId, 0);
      return 0;
    }

    inProgress.add(nodeId);

    const node = nodeById.get(nodeId);
    const parentId: string | null = node?.parentNodeId ?? null;
    if (!parentId || !nodeById.has(parentId)) {
      depthById.set(nodeId, 0);
      inProgress.delete(nodeId);
      return 0;
    }

    const depth = resolveDepth(parentId) + 1;
    depthById.set(nodeId, depth);
    inProgress.delete(nodeId);
    return depth;
  };

  for (const node of nodes) {
    resolveDepth(node.nodeId);
  }

  return depthById;
}

export function shortNodeId(nodeId: string): string {
  return nodeId.slice(-8);
}

function buildVisibleDepthMap(
  nodes: readonly ConsoleDagNode[],
  depthById: ReadonlyMap<string, number>,
  nodeById: ReadonlyMap<string, ConsoleDagNode>,
  visibleLineageIds: ReadonlySet<string>,
  compressedBeforeCount: number,
): Map<string, number> {
  const visibleDepthById = new Map<string, number>();

  // Active lineage nodes get compression offset applied.
  for (const nodeId of visibleLineageIds) {
    const rawDepth = depthById.get(nodeId) ?? 0;
    visibleDepthById.set(nodeId, compressedBeforeCount === 0 ? rawDepth : rawDepth - compressedBeforeCount + 1);
  }

  // Side branch nodes: anchor to first active-lineage ancestor's visible depth,
  // then add the hop distance from that ancestor. This ensures side branches stay
  // aligned with the active lineage column they branch off from even when compressed.
  const resolveSideDepth = (nodeId: string): number => {
    const cached = visibleDepthById.get(nodeId);
    if (cached !== undefined) return cached;

    const node = nodeById.get(nodeId);
    const parentId: string | null = node?.parentNodeId ?? null;

    if (!parentId || !nodeById.has(parentId)) {
      // Root node with no active ancestor -- fall back to raw depth.
      const depth = depthById.get(nodeId) ?? 0;
      visibleDepthById.set(nodeId, depth);
      return depth;
    }

    const parentVisibleDepth = resolveSideDepth(parentId);
    const depth = parentVisibleDepth + 1;
    visibleDepthById.set(nodeId, depth);
    return depth;
  };

  for (const node of nodes) {
    if (!visibleDepthById.has(node.nodeId)) {
      resolveSideDepth(node.nodeId);
    }
  }

  return visibleDepthById;
}
