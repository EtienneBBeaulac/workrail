import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  shortNodeId,
  SIDE_NODE_HEIGHT,
  SIDE_NODE_WIDTH,
} from '../lib/lineage-dag-layout';

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

  const { nodes, edges } = useMemo(() => {
    const currentIncomingEdgeId = model.currentNodeId
      ? model.edges.find((edge) => edge.toNodeId === model.currentNodeId)?.fromNodeId ?? null
      : null;

    const flowNodes: Node<FlowNodeData>[] = model.nodes.map((positionedNode) => {
      const { node, isActiveLineage, isCurrent } = positionedNode;
      const isSelected = node.nodeId === selectedNodeId;
      const width = isActiveLineage ? ACTIVE_NODE_WIDTH : SIDE_NODE_WIDTH;
      const height = isActiveLineage ? ACTIVE_NODE_HEIGHT : SIDE_NODE_HEIGHT;
      const borderColor = getNodeBorderColor(node, isActiveLineage, isCurrent, isSelected);
      const background = getNodeBackgroundColor(node, isActiveLineage);
      const displayLabel = getDisplayLabel(node, positionedNode.branchKind, positionedNode.branchIndex);

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
  }, [isLiveRun, model.currentNodeId, model.edges, model.nodes, nodeById, selectedNodeId]);

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
        <OverviewRail model={model} selectedNodeId={selectedNodeId} onNavigateToNode={focusNodeInViewport} />
      </div>

      <div
        ref={scrollContainerRef}
        className="relative flex-1 overflow-auto lineage-scroll-surface"
      >
        <div
          style={{
            width: Math.max(model.graphWidth, 960),
            height: Math.max(model.graphHeight, 360),
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
}) {
  const stripeColor = getRichnessStripeColor(node);

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
          <span
            className="font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: getBranchLabelColor(branchKind, isActiveLineage) }}
          >
            {formatBranchLabel(node.nodeKind, branchKind, branchIndex)}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {isSelected && (
              <span
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: 'var(--warning)' }}
              >
                Selected
              </span>
            )}
            {isCurrent && (
              <span
                className="font-mono text-[10px] uppercase tracking-[0.18em]"
                style={{ color: isLiveRun ? 'var(--accent-strong)' : 'var(--text-secondary)' }}
              >
                Current
              </span>
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
        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-secondary)]">
          {stepNumber !== null && totalSteps !== null
            ? `${stepNumber} / ${totalSteps}`
            : `evt ${node.createdAtEventIndex}`}
        </span>
        {node.isTip ? (
          <span
            className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: node.isPreferredTip ? 'var(--warning)' : 'var(--text-muted)' }}
          >
            {node.isPreferredTip ? 'Preferred tip' : 'Tip'}
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-transparent">
            spacer
          </span>
        )}
      </div>
    </div>
  );
}

function OverviewRail({
  model,
  selectedNodeId,
  onNavigateToNode,
}: {
  model: ReturnType<typeof buildLineageDagModel>;
  selectedNodeId: string | null;
  onNavigateToNode: (nodeId: string | null) => void;
}) {
  const activeNodes = model.nodes.filter((node) => node.isActiveLineage);
  const sideNodes = model.nodes.filter((node) => !node.isActiveLineage).slice(-8);

  return (
    <div className="mt-3 border border-[var(--border)] bg-[rgba(10,10,10,0.38)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          Lineage rail
        </span>
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
                label={getDisplayLabel(node.node, node.branchKind, node.branchIndex)}
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
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
        {label}
      </div>
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
      className="border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-strong)] hover:text-[var(--text-primary)]"
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
): string {
  if (node.stepLabel) return node.stepLabel;
  if (branchKind === 'blocked') return branchIndex ? `Blocked attempt ${branchIndex}` : 'Blocked attempt';
  if (branchKind === 'alternate') return branchIndex ? `Alternate path ${branchIndex}` : 'Alternate path';
  return shortNodeId(node.nodeId);
}

function truncateLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 18)}…` : label;
}
