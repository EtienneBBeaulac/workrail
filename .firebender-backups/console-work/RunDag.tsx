import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  type Node,
  type Edge,
  type NodeMouseHandler,
  MarkerType,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ConsoleDagRun, ConsoleDagNode } from '../api/types';
import { layoutDag } from '../lib/dag-layout';

interface Props {
  run: ConsoleDagRun;
  onNodeClick?: (nodeId: string) => void;
}

const NODE_KIND_STYLES: Record<
  ConsoleDagNode['nodeKind'],
  { bg: string; border: string; text: string; glow?: string }
> = {
  step: { bg: '#111f38', border: '#67c5ff', text: '#eef8ff', glow: '0 0 24px rgba(103, 197, 255, 0.12)' },
  checkpoint: { bg: '#0f2c26', border: '#36d9a8', text: '#ecfff8', glow: '0 0 20px rgba(54, 217, 168, 0.14)' },
  blocked_attempt: { bg: '#311721', border: '#ff8e9a', text: '#fff1f3', glow: '0 0 24px rgba(255, 142, 154, 0.14)' },
};

const NODE_HEIGHT = 84;
const CHECKPOINT_SIZE = 64;
const STEP_NODE_WIDTH = 224;
const BLOCKED_NODE_WIDTH = 248;

export function RunDag({ run, onNodeClick }: Props) {
  const { nodes, edges } = useMemo(() => {
    const positions = layoutDag(run.nodes, run.edges);

    const flowNodes: Node[] = run.nodes.map((node) => {
      const style = NODE_KIND_STYLES[node.nodeKind];
      const pos = positions[node.nodeId] ?? { x: 0, y: 0 };
      const metrics = getNodeMetrics(node);
      const detail = getNodeDetail(node);

      return {
        id: node.nodeId,
        position: pos,
        data: {
          label: (
            <NodeCard
              node={node}
              title={formatNodeTitle(node)}
              subtitle={detail}
              badge={formatNodeBadge(node)}
            />
          ),
        },
        style: {
          background: style.bg,
          border: `1.5px solid ${node.isPreferredTip ? '#f4be4e' : style.border}`,
          borderRadius: node.nodeKind === 'checkpoint' ? '50%' : '6px',
          color: style.text,
          width: metrics.width,
          height: metrics.height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center' as const,
          boxShadow: node.isPreferredTip
            ? '0 0 32px rgba(244, 190, 78, 0.26), inset 0 0 0 1px rgba(244, 190, 78, 0.2)'
            : style.glow ?? 'none',
          cursor: 'pointer',
          overflow: 'hidden',
          padding: 0,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      };
    });

    const flowEdges: Edge[] = run.edges.map((edge, i) => ({
      id: `e-${i}`,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      type: 'smoothstep',
      style: {
        stroke: edge.edgeKind === 'checkpoint' ? '#36d9a8' : '#67c5ff',
        strokeWidth: edge.edgeKind === 'checkpoint' ? 1.5 : 1.8,
        strokeDasharray: edge.edgeKind === 'checkpoint' ? '4 4' : undefined,
      },
      animated: edge.edgeKind === 'acked_step' && run.status === 'in_progress',
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: edge.edgeKind === 'checkpoint' ? '#36d9a8' : '#67c5ff',
      },
      pathOptions: { borderRadius: 0, offset: 16 },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [run]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => onNodeClick?.(node.id),
    [onNodeClick],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      panOnDrag={false}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      colorMode="dark"
      onNodeClick={handleNodeClick}
      minZoom={0.35}
    >
      <Background color="#1b3358" gap={40} size={1} />
      <MiniMap
        pannable={false}
        zoomable={false}
        nodeStrokeWidth={2}
        maskColor="rgba(2, 8, 22, 0.72)"
        style={{
          background: 'rgba(11, 18, 41, 0.92)',
          border: '1px solid rgba(131, 207, 255, 0.14)',
          width: 180,
          height: 110,
        }}
        nodeColor={(node) => {
          const matched = run.nodes.find((candidate) => candidate.nodeId === node.id);
          return matched ? NODE_KIND_STYLES[matched.nodeKind].border : '#67c5ff';
        }}
        nodeStrokeColor={(node) => {
          const matched = run.nodes.find((candidate) => candidate.nodeId === node.id);
          if (!matched) return '#9bd6ff';
          return matched.isPreferredTip ? '#f4be4e' : '#d9f3ff';
        }}
        nodeClassName="workrail-minimap-node"
      />
      <Controls />
      <Panel position="top-right">
        <DagLegend run={run} />
      </Panel>
    </ReactFlow>
  );
}

function getNodeMetrics(node: ConsoleDagNode): { width: number; height: number } {
  switch (node.nodeKind) {
    case 'checkpoint':
      return { width: CHECKPOINT_SIZE, height: CHECKPOINT_SIZE };
    case 'blocked_attempt':
      return { width: BLOCKED_NODE_WIDTH, height: NODE_HEIGHT };
    case 'step':
      return { width: STEP_NODE_WIDTH, height: NODE_HEIGHT };
  }
}

function formatNodeTitle(node: ConsoleDagNode): string {
  return truncateNodeLabel(node.stepLabel ?? node.nodeId, node.nodeKind === 'checkpoint' ? 18 : 32);
}

function formatNodeBadge(node: ConsoleDagNode): string {
  if (node.isPreferredTip) return 'preferred tip';
  if (node.isTip) return 'tip';
  switch (node.nodeKind) {
    case 'checkpoint':
      return 'checkpoint';
    case 'blocked_attempt':
      return 'blocked';
    case 'step':
      return `#${String(node.createdAtEventIndex).padStart(3, '0')}`;
  }
}

function getNodeDetail(node: ConsoleDagNode): string | null {
  if (node.nodeKind === 'checkpoint') return null;
  if (node.nodeKind === 'blocked_attempt') return 'validation failed';
  if (node.parentNodeId === null) return 'root step';
  return `event #${node.createdAtEventIndex}`;
}

function truncateNodeLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}…`;
}

function NodeCard({
  node,
  title,
  subtitle,
  badge,
}: {
  node: ConsoleDagNode;
  title: string;
  subtitle: string | null;
  badge: string;
}) {
  const fullLabel = node.stepLabel ?? node.nodeId;
  const tooltip = subtitle
    ? `${fullLabel}\n${subtitle}\n${node.nodeId}`
    : `${fullLabel}\n${node.nodeId}`;

  if (node.nodeKind === 'checkpoint') {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center px-1"
        title={tooltip}
      >
        <div className="text-[8px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          {badge}
        </div>
        <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.06em]">
          {title}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col justify-between px-3 py-2 text-left"
      title={tooltip}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[8px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          {badge}
        </span>
        <span className="font-mono text-[9px] text-[var(--text-muted)] opacity-80">
          {node.nodeId.slice(-6)}
        </span>
      </div>
      <div className="text-[12px] font-semibold uppercase tracking-[0.04em] leading-tight">
        {title}
      </div>
      {subtitle && (
        <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
          {subtitle}
        </div>
      )}
    </div>
  );
}

function DagLegend({ run }: { run: ConsoleDagRun }) {
  const stepCount = run.nodes.filter((node) => node.nodeKind === 'step').length;
  const checkpointCount = run.nodes.filter((node) => node.nodeKind === 'checkpoint').length;
  const blockedCount = run.nodes.filter((node) => node.nodeKind === 'blocked_attempt').length;
  const tipCount = run.tipNodeIds.length;

  return (
    <div className="min-w-[240px] border border-[rgba(131,207,255,0.14)] bg-[rgba(11,18,41,0.92)] px-3 py-2 text-left shadow-[0_0_18px_rgba(2,8,22,0.32)] backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          DAG legend
        </span>
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--text-muted)]">
          {run.nodes.length} nodes
        </span>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 border-b border-[rgba(131,207,255,0.08)] pb-2 text-[10px] font-mono uppercase tracking-[0.08em] text-[var(--text-muted)]">
        <span>{stepCount} steps</span>
        <span>{checkpointCount} checkpoints</span>
        <span>{blockedCount} blocked</span>
        <span>{tipCount} tips</span>
      </div>
      <div className="space-y-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
        <LegendRow color="#67c5ff" label="Step" />
        <LegendRow color="#36d9a8" label="Checkpoint" dashed />
        <LegendRow color="#ff8e9a" label="Blocked attempt" />
        <LegendRow color="#f4be4e" label="Preferred tip" glow />
        <LegendRow color="#94a3b8" label="Tip" />
        <LegendRow color="#67c5ff" label="Active path edge" edge />
        <LegendRow color="#36d9a8" label="Checkpoint edge" dashed edge />
      </div>
      <div className="mt-2 border-t border-[rgba(131,207,255,0.08)] pt-2 text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
        Top to bottom flow from root to tip
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
        Click node to inspect details
      </div>
    </div>
  );
}

function LegendRow({
  color,
  label,
  dashed,
  glow,
  edge,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  glow?: boolean;
  edge?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="block shrink-0"
        style={{
          height: edge ? 0 : 10,
          width: edge ? 20 : 18,
          borderTop: edge ? `1.5px ${dashed ? 'dashed' : 'solid'} ${color}` : undefined,
          border: edge ? undefined : `1.5px ${dashed ? 'dashed' : 'solid'} ${color}`,
          boxShadow: glow ? `0 0 10px ${color}55` : 'none',
          background: glow ? `${color}18` : 'transparent',
        }}
      />
      <span>{label}</span>
    </div>
  );
}
