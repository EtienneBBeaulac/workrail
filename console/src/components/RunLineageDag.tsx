import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MonoLabel } from './MonoLabel';
import { camelToSpacedUpper } from '../utils/format';
import {
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ConsoleDagNode, ConsoleDagRun } from '../api/types';
import {
  ACTIVE_NODE_HEIGHT,
  ACTIVE_NODE_WIDTH,
  buildLineageDagModel,
  positionGhostNodes,
  LINEAGE_SCROLL_OVERHANG,
  shortNodeId,
  SIDE_NODE_HEIGHT,
  SIDE_NODE_WIDTH,
} from '../lib/lineage-dag-layout';
import {
  findEdgeCauseItem,
  getLoopBracketsFromGroups,
  getNodeRoutingItems,
  groupTraceEntries,
  type EdgeCauseKind,
} from '../views/session-detail-use-cases';
import type { ConsoleExecutionTraceItem } from '../api/types';

interface Props {
  run: ConsoleDagRun;
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
}

type FlowNodeData = {
  readonly label: ReactNode;
};

export function RunLineageDag({ run, selectedNodeId = null, onNodeClick }: Props) {
  // Ref on the outermost DAG wrapper div. Used to scroll the page to bring the
  // DAG into view before scrolling the DAG canvas to a specific node (two-step
  // scroll). Without this, clicking a rail dot when the page is scrolled down
  // to the detail panel causes a canvas scroll that the user never sees.
  const dagRootRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether the initial auto-scroll to the current node has already fired.
  // Without this guard, every react-query refetch that rebuilds `model.nodes`
  // would re-trigger the scroll (because focusNodeInViewport depends on nodeById
  // which is rebuilt on every nodes change).
  //
  // Tradeoff: once set, advancing live sessions won't auto-scroll to the new
  // current node. This is intentional -- prevents snapping away from a node the
  // user is actively inspecting.
  const hasAutoScrolledRef = useRef(false);

  // Single shared tooltip rendered in the scroll container wrapper, outside the
  // ReactFlow canvas, to avoid overflow:hidden clipping.
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  // Delay timer stored in a ref to avoid causing extra renders on set/clear.
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear any pending tooltip timer on unmount to prevent setState-after-unmount warnings.
  useEffect(() => () => { if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current); }, []);

  const model = useMemo(() => buildLineageDagModel(run), [run]);
  const nodeById = useMemo(
    () => new Map(model.nodes.map((positionedNode) => [positionedNode.node.nodeId, positionedNode] as const)),
    [model.nodes],
  );
  const isLiveRun = run.status === 'in_progress';

  const focusNodeInViewport = useCallback(
    (nodeId: string | null, behavior: ScrollBehavior = 'smooth') => {
      if (!nodeId) return;

      const container = scrollContainerRef.current;
      const targetNode = nodeById.get(nodeId);
      if (!container || !targetNode) return;

      // Step 1: bring the DAG component into the viewport if the page has been
      // scrolled down to the detail panel. Without this, the canvas scroll happens
      // offscreen and the user sees no feedback.
      dagRootRef.current?.scrollIntoView({ behavior, block: 'nearest' });

      // Step 2: scroll the DAG canvas to center the target node.
      const targetWidth = targetNode.isActiveLineage ? ACTIVE_NODE_WIDTH : SIDE_NODE_WIDTH;
      const targetHeight = targetNode.isActiveLineage ? ACTIVE_NODE_HEIGHT : SIDE_NODE_HEIGHT;

      container.scrollTo({
        left: Math.max(0, targetNode.x - container.clientWidth / 2 + targetWidth / 2),
        top: Math.max(0, targetNode.y - container.clientHeight / 2 + targetHeight / 2),
        behavior,
      });
    },
    [nodeById],
  );

  useEffect(() => {
    if (hasAutoScrolledRef.current) return;
    if (!model.currentNodeId) return;
    hasAutoScrolledRef.current = true;
    focusNodeInViewport(model.currentNodeId, 'auto');
    // Intentionally omit focusNodeInViewport and model.currentNodeId from deps
    // so this fires only once on mount, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Overlay data: blocked_attempt cause items (sub-feature C)
  //
  // Maps nodeId -> cause items for blocked_attempt nodes that have trace data.
  // null means trace not available (executionTraceSummary is null).
  // An empty array means trace is available but this node has no cause items.
  //
  // NOTE: causeItems are passed to NodeLabel which uses them to decide whether
  // to render the CAUSE footer band. The node height in flowNodes is also
  // adjusted based on whether cause items exist.
  // ---------------------------------------------------------------------------

  const blockedCauseMap = useMemo(() => {
    if (!run.executionTraceSummary) return null;
    const summary = run.executionTraceSummary;
    const result = new Map<string, readonly ConsoleExecutionTraceItem[]>();

    for (const node of run.nodes) {
      if (node.nodeKind !== 'blocked_attempt') continue;
      const routing = getNodeRoutingItems(summary, node.nodeId);
      // Combine all relevant cause item categories
      const causeItems = [
        ...routing.divergences,
        ...routing.forks,
        ...routing.conditions,
        ...routing.whySelected,
      ];
      result.set(node.nodeId, causeItems);
    }

    return result;
  }, [run.executionTraceSummary, run.nodes]);

  // Height extension for blocked_attempt nodes with cause items (sub-feature C).
  // Must budget for the expanded state (72px) not just collapsed (32px),
  // because ReactFlow clips to the node height. Use 72 + 8px gap.
  const CAUSE_FOOTER_HEIGHT_EXTENSION = 80;

  const { nodes, edges } = useMemo(() => {
    const currentIncomingEdgeId = model.currentNodeId
      ? model.edges.find((edge) => edge.toNodeId === model.currentNodeId)?.fromNodeId ?? null
      : null;

    const flowNodes: Node<FlowNodeData>[] = model.nodes.map((positionedNode) => {
      const { node, isActiveLineage, isCurrent } = positionedNode;
      const isSelected = node.nodeId === selectedNodeId;
      const width = isActiveLineage ? ACTIVE_NODE_WIDTH : SIDE_NODE_WIDTH;
      const borderColor = getNodeBorderColor(node, isActiveLineage, isCurrent, isSelected);
      const background = getNodeBackgroundColor(node, isActiveLineage);
      const displayLabel = getDisplayLabel(node, positionedNode.branchKind, positionedNode.branchIndex, run.status);

      // Cause items for this node (undefined = trace not available)
      const causeItems = blockedCauseMap?.get(node.nodeId);
      const hasCauseFooter = node.nodeKind === 'blocked_attempt' && causeItems !== undefined && causeItems.length > 0;
      const baseHeight = isActiveLineage ? ACTIVE_NODE_HEIGHT : SIDE_NODE_HEIGHT;
      const height = hasCauseFooter ? baseHeight + CAUSE_FOOTER_HEIGHT_EXTENSION : baseHeight;

      return {
        id: node.nodeId,
        position: { x: positionedNode.x, y: positionedNode.y },
        data: {
          label: (
            <NodeLabel
              node={node}
              isActiveLineage={isActiveLineage}
              isCurrent={isCurrent}
              isSelected={isSelected}
              isLiveRun={isLiveRun}
              branchKind={positionedNode.branchKind}
              branchIndex={positionedNode.branchIndex}
              displayLabel={displayLabel}
              stepNumber={isActiveLineage ? positionedNode.depth + 1 : null}
              totalSteps={isActiveLineage ? model.summary.lineageNodeCount : null}
              causeItems={causeItems}
            />
          ),
        },
        style: {
          width,
          height,
          padding: 0,
          borderRadius: 0,
          border: `1px solid ${borderColor}`,
          background,
          color: 'var(--text-primary)',
          boxShadow: isSelected
            ? '0 0 0 1px rgba(244, 179, 65, 0.7), 0 0 18px rgba(244, 179, 65, 0.16)'
            : isCurrent
            ? '0 0 0 1px rgba(0, 240, 255, 0.65), 0 0 24px rgba(0, 240, 255, 0.18)'
            : isActiveLineage
              ? '0 0 16px rgba(0, 240, 255, 0.1)'
              : 'none',
          opacity: isActiveLineage ? 1 : 0.72,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'stretch',
        },
      };
    });

    const flowEdges: Edge[] = model.edges.map((edge, index) => {
      const sourceNode = nodeById.get(edge.fromNodeId);
      const targetNode = nodeById.get(edge.toNodeId);
      const onActiveLineage = Boolean(sourceNode?.isActiveLineage && targetNode?.isActiveLineage);
      const isCurrentConnector =
        isLiveRun &&
        Boolean(model.currentNodeId) &&
        edge.toNodeId === model.currentNodeId &&
        edge.fromNodeId === currentIncomingEdgeId;

      return {
        id: `lineage-edge-${index}`,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        type: 'smoothstep',
        animated: isCurrentConnector,
        className: isCurrentConnector ? 'workrail-current-lineage-edge' : undefined,
        style: {
          stroke: isCurrentConnector
            ? 'var(--accent-strong)'
            : onActiveLineage
            ? edge.edgeKind === 'checkpoint'
              ? 'var(--success)'
              : 'var(--accent-strong)'
            : 'rgba(123, 141, 167, 0.45)',
          strokeWidth: isCurrentConnector ? 2.6 : onActiveLineage ? 2.2 : 1.5,
          opacity: onActiveLineage ? 1 : 0.72,
        },
      };
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [blockedCauseMap, isLiveRun, model.currentNodeId, model.edges, model.nodes, nodeById, selectedNodeId]);

  // ---------------------------------------------------------------------------
  // Overlay data: edge cause diamonds (sub-feature A)
  //
  // Computed in a separate useMemo from flowNodes/flowEdges so that changes to
  // executionTraceSummary don't trigger a full ReactFlow node rebuild.
  // ---------------------------------------------------------------------------

  const edgeCauses = useMemo(() => {
    if (!run.executionTraceSummary) return null;
    const items = run.executionTraceSummary.items;

    return model.edges
      .map((edge) => {
        const sourceNode = nodeById.get(edge.fromNodeId);
        const targetNode = nodeById.get(edge.toNodeId);
        if (!sourceNode || !targetNode) return null;
        if (!sourceNode.isActiveLineage || !targetNode.isActiveLineage) return null;

        const cause = findEdgeCauseItem(edge, items);
        if (!cause) return null;

        // Both nodes are guaranteed active-lineage by the guard above.
        const sourceWidth = ACTIVE_NODE_WIDTH;
        const sourceHeight = ACTIVE_NODE_HEIGHT;
        const targetWidth = ACTIVE_NODE_WIDTH;
        const targetHeight = ACTIVE_NODE_HEIGHT;

        // Geometric midpoint between the two node centers (approximate -- smoothstep curves
        // don't pass through this exact point, but it's close enough for a 10px annotation).
        const x = (sourceNode.x + sourceWidth / 2 + targetNode.x + targetWidth / 2) / 2;
        const y = (sourceNode.y + sourceHeight / 2 + targetNode.y + targetHeight / 2) / 2;

        return {
          edgeKey: `${edge.fromNodeId}->${edge.toNodeId}`,
          x,
          y,
          cause,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
  }, [model.edges, nodeById, run.executionTraceSummary]);

  // ---------------------------------------------------------------------------
  // Overlay data: loop brackets (sub-feature B)
  //
  // Derives positioned loop brackets from the execution trace.
  // Each bracket has a top Y and bottom Y derived from the Y positions of all
  // DAG nodes referenced by the loop's trace items.
  // Brackets with iterationCount === 1 are suppressed (single-iteration loops
  // don't need a bracket).
  // ---------------------------------------------------------------------------

  const loopBrackets = useMemo(() => {
    if (!run.executionTraceSummary) return null;
    const entries = groupTraceEntries(run.executionTraceSummary.items);
    const rawBrackets = getLoopBracketsFromGroups(entries);

    return rawBrackets
      .filter((bracket) => bracket.iterationCount > 1)
      .map((bracket) => {
        // Find Y positions of all referenced nodes. Skip brackets where any
        // node is not in the positioned set (graceful degradation).
        const positionedNodes = bracket.nodeIds
          .map((id) => nodeById.get(id))
          .filter((n): n is NonNullable<typeof n> => n !== undefined);

        if (positionedNodes.length === 0) return null;

        const ys = positionedNodes.map((n) => n.y);
        const topY = Math.min(...ys);
        // Use the highest-Y node's type for the correct height constant.
        const bottomNode = positionedNodes.reduce((a, b) => a.y > b.y ? a : b);
        const bottomY = Math.max(...ys) + (bottomNode!.isActiveLineage ? ACTIVE_NODE_HEIGHT : SIDE_NODE_HEIGHT);

        // X position: left gutter, just inside the scroll overhang area
        // LINEAGE_SCROLL_OVERHANG (600) + LINEAGE_PADDING (56) is where the first node starts.
        // We place the bracket at x=LINEAGE_SCROLL_OVERHANG - 36 so it's visible in the gutter.
        const gutterX = LINEAGE_SCROLL_OVERHANG - 36;

        return {
          key: bracket.loopId,
          iterationCount: bracket.iterationCount,
          topY,
          bottomY,
          gutterX,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);
  }, [model.nodes, nodeById, run.executionTraceSummary]);

  // ---------------------------------------------------------------------------
  // Overlay data: ghost nodes for skipped steps (sub-feature D)
  // FM2 mitigation: run.skippedSteps ?? [] handles old backend without the field.
  // ---------------------------------------------------------------------------

  const ghostNodeLayout = useMemo(() => {
    if (!run.executionTraceSummary) return null;
    const skippedSteps = run.skippedSteps ?? [];
    if (skippedSteps.length === 0) return null;
    return positionGhostNodes(skippedSteps, model);
  }, [model, run.executionTraceSummary, run.skippedSteps]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      onNodeClick?.(node.id);
    },
    [onNodeClick],
  );

  const handleNodeMouseEnter: NodeMouseHandler = useCallback((event, node) => {
    // Only show tooltip when the label is long enough to be truncated.
    const label = nodeById.get(node.id)?.node.stepLabel ?? null;
    if (!label || label.length <= 35) return;

    const containerRect = scrollContainerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    // Position relative to the scroll container so the tooltip stays within bounds.
    const x = event.clientX - containerRect.left + 12;
    const y = event.clientY - containerRect.top + 16;
    // Clamp x so the tooltip (maxWidth 260px + 12px margin) doesn't clip the right edge.
    const clampedX = Math.min(x, (scrollContainerRef.current?.clientWidth ?? 9999) - 272);

    if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => {
      setHoveredLabel(label);
      setTooltipPos({ x: clampedX, y });
    }, 300);
  }, [nodeById]);

  const handleNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setHoveredLabel(null);
    setTooltipPos(null);
  }, []);

  // Diamond hover: reuse the same hoveredLabel/tooltipPos state as node label tooltips.
  // The transparent hover-target div calls these handlers (not the diamond visual itself).
  const handleDiamondMouseEnter = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, summary: string) => {
      const containerRect = scrollContainerRef.current?.getBoundingClientRect();
      if (!containerRect) return;

      const x = event.clientX - containerRect.left + 12;
      const y = event.clientY - containerRect.top + 16;
      const clampedX = Math.min(x, (scrollContainerRef.current?.clientWidth ?? 9999) - 272);

      if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = setTimeout(() => {
        setHoveredLabel(summary);
        setTooltipPos({ x: clampedX, y });
      }, 300);
    },
    [],
  );

  const handleDiamondMouseLeave = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setHoveredLabel(null);
    setTooltipPos(null);
  }, []);

  return (
    <div ref={dagRootRef} className="h-full flex flex-col bg-[var(--bg-primary)]">
      <div className="border-b border-[var(--border)] px-4 py-3 console-blueprint-grid">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <SummaryChip label="Current" value={model.summary.currentNodeLabel} emphasis />
            <SummaryChip label="Status" value={formatRunStatus(run.status)} />
            <SummaryChip label="Active lineage" value={`${model.summary.lineageNodeCount} nodes`} />
            <SummaryChip label="Alternate branches" value={`${model.summary.alternateBranchCount}`} />
            <SummaryChip label="Historical nodes" value={`${model.summary.sideNodeCount}`} />
            <SummaryChip label="Blocked attempts" value={`${model.summary.blockedAttemptCount}`} />
            <SummaryChip
              label="Critical gaps"
              value={run.hasUnresolvedCriticalGaps ? 'Present' : 'None'}
            />
          </div>
          <div className="flex items-center gap-2">
            <JumpButton onClick={() => focusNodeInViewport(model.startNodeId)}>Start</JumpButton>
            <JumpButton onClick={() => focusNodeInViewport(model.currentNodeId)}>Current</JumpButton>
            <JumpButton onClick={() => focusNodeInViewport(model.latestBranchNodeId)}>Latest branch</JumpButton>
          </div>
        </div>
        <OverviewRail model={model} selectedNodeId={selectedNodeId} runStatus={run.status} onNavigateToNode={focusNodeInViewport} />
        {run.executionTraceSummary !== null && run.executionTraceSummary.contextFacts.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {run.executionTraceSummary.contextFacts.map((fact) => (
              <div
                key={fact.key}
                className="inline-flex items-center gap-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em]"
                style={{
                  color: 'var(--text-muted)',
                  backgroundColor: 'rgba(123, 141, 167, 0.08)',
                  border: '1px solid rgba(123, 141, 167, 0.20)',
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>{camelToSpacedUpper(fact.key)}</span>
                <span style={{ color: 'var(--text-muted)' }}>//</span>
                <span style={{ color: 'var(--text-primary)' }}>{fact.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        className="relative flex-1 overflow-auto lineage-scroll-surface"
      >
        <div
          style={{
            width: Math.max(model.graphWidth, ghostNodeLayout?.requiredWidth ?? 0, 960),
            // Add CAUSE footer extension if any blocked_attempt nodes have cause items,
            // otherwise the footer is clipped on bottommost nodes.
            // Add CAUSE footer extension if any blocked_attempt nodes have cause items,
            // otherwise the footer is clipped on bottommost nodes.
            height: Math.max(model.graphHeight + (blockedCauseMap && blockedCauseMap.size > 0 ? 40 : 0), 360),
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView={false}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            colorMode="dark"
            onNodeClick={handleNodeClick}
            onNodeMouseEnter={handleNodeMouseEnter}
            onNodeMouseLeave={handleNodeMouseLeave}
            style={{ background: 'transparent' }}
          />

          {/* Sub-feature A: Edge cause diamonds */}
          {edgeCauses && edgeCauses.map((diamond) => (
            <EdgeCauseDiamond
              key={diamond.edgeKey}
              x={diamond.x}
              y={diamond.y}
              cause={diamond.cause}
              onMouseEnter={handleDiamondMouseEnter}
              onMouseLeave={handleDiamondMouseLeave}
            />
          ))}

          {/* Sub-feature B: Loop bracket SVG overlays */}
          {loopBrackets && loopBrackets.map((bracket) => (
            <LoopBracketOverlay
              key={bracket.key}
              topY={bracket.topY}
              bottomY={bracket.bottomY}
              gutterX={bracket.gutterX}
              iterationCount={bracket.iterationCount}
            />
          ))}

          {/* Sub-feature D: Ghost nodes for skipped steps */}
          {ghostNodeLayout && ghostNodeLayout.nodes.map((ghostNode) => (
            <GhostNodeOverlay
              key={ghostNode.stepId}
              x={ghostNode.x}
              y={ghostNode.y}
              stepLabel={ghostNode.stepLabel ?? ghostNode.stepId}
              onMouseEnter={handleDiamondMouseEnter}
              onMouseLeave={handleDiamondMouseLeave}
            />
          ))}
        </div>
        {hoveredLabel && tooltipPos && (
          <div
            style={{
              position: 'absolute',
              left: tooltipPos.x,
              top: tooltipPos.y,
              pointerEvents: 'none',
              zIndex: 50,
              maxWidth: 260,
              background: 'rgba(10, 12, 20, 0.96)',
              border: '1px solid rgba(123, 141, 167, 0.35)',
              padding: '6px 10px',
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--text-primary)',
              wordWrap: 'break-word',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}
          >
            {hoveredLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function NodeLabel({
  node,
  isActiveLineage,
  isCurrent,
  isSelected,
  isLiveRun,
  branchKind,
  branchIndex,
  displayLabel,
  stepNumber,
  totalSteps,
  causeItems,
}: {
  node: ConsoleDagNode;
  isActiveLineage: boolean;
  isCurrent: boolean;
  isSelected: boolean;
  isLiveRun: boolean;
  branchKind: 'active' | 'blocked' | 'alternate';
  branchIndex: number | null;
  displayLabel: string;
  stepNumber: number | null;
  totalSteps: number | null;
  /**
   * Cause items for this node from the execution trace.
   * undefined = executionTraceSummary not available (legacy session).
   * empty array = trace available but no cause items for this node.
   * Non-empty = render CAUSE footer band.
   */
  causeItems?: readonly ConsoleExecutionTraceItem[];
}) {
  const stripeColor = getRichnessStripeColor(node);
  // Footer is only shown for blocked_attempt nodes with actual cause items
  const showCauseFooter = node.nodeKind === 'blocked_attempt' && causeItems !== undefined && causeItems.length > 0;
  // Transient UI state: whether the CAUSE footer is expanded (local only, not feature state)
  const [causeExpanded, setCauseExpanded] = useState(false);

  return (
    <div
      className={`relative flex h-full w-full flex-col text-left overflow-hidden ${
        isCurrent && isLiveRun ? 'workrail-current-lineage-node' : ''
      } ${isSelected ? 'workrail-selected-lineage-node' : ''}`}
    >
      {stripeColor && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: stripeColor,
            pointerEvents: 'none',
          }}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <MonoLabel color={getBranchLabelColor(branchKind, isActiveLineage)}>
            {formatBranchLabel(node.nodeKind, branchKind, branchIndex)}
          </MonoLabel>
          <div className="flex shrink-0 items-center gap-1">
            {isSelected && (
              <MonoLabel color="var(--warning)">Selected</MonoLabel>
            )}
            {isCurrent && (
              <MonoLabel color={isLiveRun ? 'var(--accent-strong)' : 'var(--text-secondary)'}>Current</MonoLabel>
            )}
          </div>
        </div>

        <div
          className={isActiveLineage ? 'text-sm font-medium leading-snug' : 'text-[13px] leading-snug'}
          style={{
            color: 'var(--text-primary)',
            display: '-webkit-box',
            WebkitLineClamp: isActiveLineage ? 4 : 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {displayLabel}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.18)] px-3 py-2">
        <MonoLabel color="var(--text-secondary)" className="min-w-0 truncate text-[11px]">
          {stepNumber !== null && totalSteps !== null
            ? `${stepNumber} / ${totalSteps}`
            : `evt ${node.createdAtEventIndex}`}
        </MonoLabel>
        {node.isTip ? (
          <MonoLabel
            className="shrink-0"
            color={node.isPreferredTip ? 'var(--warning)' : 'var(--text-muted)'}
          >
            {node.isPreferredTip ? 'Preferred tip' : 'Tip'}
          </MonoLabel>
        ) : (
          <MonoLabel className="shrink-0" color="transparent">spacer</MonoLabel>
        )}
      </div>

      {/* Sub-feature C: CAUSE footer band for blocked_attempt nodes */}
      {showCauseFooter && (
        <div
          style={{
            borderTop: '1px solid rgba(239, 68, 68, 0.25)',
            background: 'rgba(80, 24, 31, 0.80)',
            overflow: 'hidden',
            transition: 'height 120ms ease',
            height: causeExpanded ? 72 : 32,
            flexShrink: 0,
          }}
        >
          <div className="flex items-center px-3" style={{ height: 32 }}>
            <button
              type="button"
              aria-expanded={causeExpanded}
              onClick={(e) => { e.stopPropagation(); setCauseExpanded((v) => !v); }}
              className="font-mono text-[9px] uppercase tracking-[0.22em] px-2 py-0.5 transition-colors"
              style={{
                color: causeExpanded ? 'var(--text-muted)' : 'var(--accent)',
                border: `1px solid ${causeExpanded ? 'rgba(123,141,167,0.25)' : 'rgba(244,196,48,0.40)'}`,
                background: causeExpanded ? 'rgba(123,141,167,0.06)' : 'rgba(244,196,48,0.08)',
              }}
            >
              {causeExpanded ? '[ CLOSE ]' : '[ CAUSE ]'}
            </button>
          </div>
          {causeExpanded && causeItems && causeItems[0] && (
            <div
              className="px-3 pb-2 font-mono text-[9px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              {causeItems[0].summary}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OverviewRail({
  model,
  selectedNodeId,
  runStatus,
  onNavigateToNode,
}: {
  model: ReturnType<typeof buildLineageDagModel>;
  selectedNodeId: string | null;
  runStatus: ConsoleDagRun['status'];
  onNavigateToNode: (nodeId: string | null) => void;
}) {
  const activeNodes = model.nodes.filter((node) => node.isActiveLineage);
  const sideNodes = model.nodes.filter((node) => !node.isActiveLineage).slice(-8);

  return (
    <div className="mt-3 border border-[var(--border)] bg-[rgba(10,10,10,0.38)] px-3 py-2 corner-brackets">
      <div className="flex flex-wrap items-center gap-2">
        <MonoLabel>Lineage rail</MonoLabel>
        {activeNodes.map((node) => (
          <RailDot
            key={node.node.nodeId}
            label={node.node.stepLabel ?? shortNodeId(node.node.nodeId)}
            isCurrent={node.isCurrent}
            isSelected={node.node.nodeId === selectedNodeId}
            tone="active"
            onClick={() => onNavigateToNode(node.node.nodeId)}
          />
        ))}
        {sideNodes.length > 0 && (
          <>
            <span className="mx-1 h-px w-6 bg-[var(--border)]" />
            {sideNodes.map((node) => (
              <RailDot
                key={node.node.nodeId}
                label={getDisplayLabel(node.node, node.branchKind, node.branchIndex, runStatus)}
                isCurrent={false}
                isSelected={node.node.nodeId === selectedNodeId}
                tone={node.branchKind === 'blocked' ? 'blocked' : 'side'}
                onClick={() => onNavigateToNode(node.node.nodeId)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryChip({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="min-w-[120px] border px-3 py-2"
      style={{
        borderColor: emphasis ? 'rgba(0, 240, 255, 0.42)' : 'var(--border)',
        background: emphasis ? 'rgba(0, 240, 255, 0.08)' : 'rgba(15, 19, 31, 0.78)',
      }}
    >
      <MonoLabel>{label}</MonoLabel>
      <div className="mt-1 text-sm text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function JumpButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.30em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-strong)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  );
}

function RailDot({
  label,
  isCurrent,
  isSelected,
  tone,
  onClick,
}: {
  label: string;
  isCurrent: boolean;
  isSelected: boolean;
  tone: 'active' | 'side' | 'blocked';
  onClick: () => void;
}) {
  const background =
    isSelected
      ? 'rgba(244, 179, 65, 0.16)'
      :
    tone === 'active'
      ? isCurrent
        ? 'rgba(0, 240, 255, 0.2)'
        : 'rgba(0, 240, 255, 0.08)'
      : tone === 'blocked'
        ? 'rgba(239, 68, 68, 0.12)'
        : 'rgba(125, 136, 156, 0.12)';

  const borderColor =
    isSelected
      ? 'rgba(244, 179, 65, 0.48)'
      :
    tone === 'active'
      ? isCurrent
        ? 'rgba(0, 240, 255, 0.6)'
        : 'rgba(0, 240, 255, 0.32)'
      : tone === 'blocked'
        ? 'rgba(239, 68, 68, 0.34)'
        : 'rgba(125, 136, 156, 0.3)';

  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      style={{ background, borderColor }}
    >
      {truncateLabel(label)}
    </button>
  );
}

function getNodeBackgroundColor(node: ConsoleDagNode, isActiveLineage: boolean): string {
  if (node.nodeKind === 'blocked_attempt') {
    return isActiveLineage ? 'rgba(80, 24, 31, 0.92)' : 'rgba(52, 24, 30, 0.82)';
  }

  if (node.nodeKind === 'checkpoint') {
    return isActiveLineage ? 'rgba(18, 61, 51, 0.92)' : 'rgba(18, 43, 38, 0.82)';
  }

  return isActiveLineage ? 'rgba(27, 31, 44, 0.96)' : 'rgba(24, 28, 39, 0.82)';
}

function getBranchLabelColor(
  branchKind: 'active' | 'blocked' | 'alternate',
  isActiveLineage: boolean,
): string {
  if (branchKind === 'blocked') return 'var(--error)';
  if (branchKind === 'alternate') return isActiveLineage ? 'var(--accent-strong)' : 'rgba(186, 197, 219, 0.72)';
  return isActiveLineage ? 'var(--accent-strong)' : 'var(--text-muted)';
}

function getNodeBorderColor(
  node: ConsoleDagNode,
  isActiveLineage: boolean,
  isCurrent: boolean,
  isSelected: boolean,
): string {
  if (isSelected) return 'var(--warning)';
  if (isCurrent) return 'var(--accent-strong)';
  if (node.nodeKind === 'blocked_attempt') return isActiveLineage ? 'var(--error)' : 'rgba(239, 68, 68, 0.5)';
  if (node.nodeKind === 'checkpoint') return isActiveLineage ? 'var(--success)' : 'rgba(34, 197, 94, 0.45)';
  return isActiveLineage ? 'rgba(0, 240, 255, 0.55)' : 'rgba(123, 141, 167, 0.45)';
}

// Rules for the 3px left-border richness stripe on a DAG node.
// Evaluated in priority order (highest first); first match wins.
// null color means no stripe (node has no content yet).
const RICHNESS_STRIPE_RULES: readonly { readonly test: (node: ConsoleDagNode) => boolean; readonly color: string }[] = [
  { test: (n) => n.hasFailedValidations, color: 'var(--error)' },
  { test: (n) => n.hasGaps,              color: 'var(--warning)' },
  { test: (n) => n.hasRecap || n.hasArtifacts, color: 'var(--accent)' },
];

function getRichnessStripeColor(node: ConsoleDagNode): string | null {
  return RICHNESS_STRIPE_RULES.find((rule) => rule.test(node))?.color ?? null;
}

function formatNodeKind(nodeKind: ConsoleDagNode['nodeKind']): string {
  switch (nodeKind) {
    case 'blocked_attempt':
      return 'Blocked';
    case 'checkpoint':
      return 'Checkpoint';
    case 'step':
      return 'Step';
  }
}

function formatBranchLabel(
  nodeKind: ConsoleDagNode['nodeKind'],
  branchKind: 'active' | 'blocked' | 'alternate',
  branchIndex: number | null,
): string {
  if (branchKind === 'blocked') {
    return branchIndex ? `Blocked branch ${branchIndex}` : 'Blocked branch';
  }

  if (branchKind === 'alternate') {
    return branchIndex ? `Alt branch ${branchIndex}` : 'Alt branch';
  }

  return formatNodeKind(nodeKind);
}

function formatRunStatus(status: ConsoleDagRun['status']): string {
  switch (status) {
    case 'complete':
      return 'Complete';
    case 'complete_with_gaps':
      return 'Complete with gaps';
    case 'blocked':
      return 'Blocked';
    case 'in_progress':
      return 'In progress';
  }
}

function getDisplayLabel(
  node: ConsoleDagNode,
  branchKind: 'active' | 'blocked' | 'alternate',
  branchIndex: number | null,
  runStatus?: ConsoleDagRun['status'],
): string {
  if (node.stepLabel) return node.stepLabel;
  if (branchKind === 'blocked') return branchIndex ? `Blocked attempt ${branchIndex}` : 'Blocked attempt';
  if (branchKind === 'alternate') return branchIndex ? `Alternate path ${branchIndex}` : 'Alternate path';
  // The preferred tip of a completed run has no step label because the engine's
  // complete state has no pending step -- show "Complete" instead of the raw node ID.
  if (node.isPreferredTip && (runStatus === 'complete' || runStatus === 'complete_with_gaps')) {
    return 'Complete';
  }
  return shortNodeId(node.nodeId);
}

function truncateLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 18)}…` : label;
}

// ---------------------------------------------------------------------------
// LoopBracketOverlay
//
// Renders a vertical amber line with [ LOOP ] and [ // Nx ] MonoLabels
// in the left gutter of the DAG canvas. Positioned absolutely within the
// canvas-sized div so it scrolls with the content.
// ---------------------------------------------------------------------------

function LoopBracketOverlay({
  topY,
  bottomY,
  gutterX,
  iterationCount,
}: {
  topY: number;
  bottomY: number;
  gutterX: number;
  iterationCount: number;
}) {
  const height = bottomY - topY;
  if (height <= 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: gutterX,
        top: topY,
        width: 32,
        height,
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      {/* Vertical amber line -- 3px wide, full height */}
      <div
        style={{
          position: 'absolute',
          left: 14,
          top: 0,
          bottom: 0,
          width: 3,
          background: 'var(--accent)',
          opacity: 0.70,
        }}
      />

      {/* [ LOOP ] label at top */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: -2,
          whiteSpace: 'nowrap',
        }}
      >
        <MonoLabel color="var(--accent)" style={{ fontSize: 9 }}>[ LOOP ]</MonoLabel>
      </div>

      {/* [ // Nx ] label at bottom */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: -2,
          whiteSpace: 'nowrap',
        }}
      >
        <MonoLabel color="var(--accent)" style={{ fontSize: 9 }}>{`[ // ${iterationCount}x ]`}</MonoLabel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edge cause diamond config
//
// Maps EdgeCauseKind to the display character and color used on the diamond.
// ---------------------------------------------------------------------------

const EDGE_CAUSE_CONFIG: Record<EdgeCauseKind, { readonly char: string; readonly color: string }> = {
  condition: { char: 'C', color: '#f4c430' },
  fork:      { char: 'F', color: 'var(--warning)' },
  divergence:{ char: 'D', color: 'var(--error)' },
  advance:   { char: '>', color: 'rgba(0,175,192,0.60)' },
};

// ---------------------------------------------------------------------------
// EdgeCauseDiamond component
//
// Renders a 10x10 rotated square at (x, y) within the canvas-sized div.
// IMPORTANT: diamonds are siblings of the ReactFlow canvas in the same parent div.
// A separate hover-target at z-index > 0 would sit above the entire ReactFlow
// layer and silently swallow node clicks. Instead, mouse handlers are applied
// directly to the diamond visual with pointerEvents:auto. Hit area is small
// (10x10) but only covers edge midpoints, not node centers.
// ---------------------------------------------------------------------------

function EdgeCauseDiamond({
  x,
  y,
  cause,
  onMouseEnter,
  onMouseLeave,
}: {
  x: number;
  y: number;
  cause: { kind: EdgeCauseKind; summary: string };
  onMouseEnter: (event: React.MouseEvent<HTMLDivElement>, summary: string) => void;
  onMouseLeave: () => void;
}) {
  const cfg = EDGE_CAUSE_CONFIG[cause.kind];

  return (
    <div
      style={{
        position: 'absolute',
        left: x - 5,
        top: y - 5,
        width: 10,
        height: 10,
        transform: 'rotate(45deg)',
        background: cfg.color,
        zIndex: 1,
        pointerEvents: 'auto',
        cursor: 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => onMouseEnter(e, cause.summary)}
      onMouseLeave={onMouseLeave}
    >
      {/* Character label (de-rotated to appear upright) */}
      <span
        style={{
          display: 'block',
          transform: 'rotate(-45deg)',
          fontSize: 7,
          lineHeight: 1,
          fontFamily: 'monospace',
          fontWeight: 700,
          color: 'rgba(0,0,0,0.75)',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        {cfg.char}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GhostNodeOverlay (sub-feature D)
// ---------------------------------------------------------------------------

function GhostNodeOverlay({
  x,
  y,
  stepLabel,
  onMouseEnter,
  onMouseLeave,
}: {
  x: number;
  y: number;
  stepLabel: string;
  onMouseEnter: (event: React.MouseEvent<HTMLDivElement>, summary: string) => void;
  onMouseLeave: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: ACTIVE_NODE_WIDTH,
        height: ACTIVE_NODE_HEIGHT,
        opacity: 0.25,
        pointerEvents: 'auto',
        cursor: 'default',
        border: '1px dashed rgba(123, 141, 167, 0.55)',
        background: 'rgba(24, 28, 39, 0.60)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 0,
      }}
      onMouseEnter={(e) => onMouseEnter(e, stepLabel)}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <MonoLabel color="rgba(123, 141, 167, 0.70)">Skipped</MonoLabel>
        <MonoLabel color="rgba(123, 141, 167, 0.55)" className="text-[9px]">[ SKIPPED ]</MonoLabel>
      </div>
      <div
        className="grow px-3 pt-2 text-sm leading-snug"
        style={{
          color: 'rgba(186, 197, 219, 0.65)',
          display: '-webkit-box',
          WebkitLineClamp: 4,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {stepLabel}
      </div>
      <div
        className="flex items-center border-t px-3 py-2"
        style={{ borderColor: 'rgba(255,255,255,0.04)', background: 'rgba(0,0,0,0.12)' }}
      >
        <MonoLabel color="rgba(123, 141, 167, 0.45)" className="text-[11px]">not executed</MonoLabel>
      </div>
    </div>
  );
}

