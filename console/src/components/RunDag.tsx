import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ConsoleDagRun, ConsoleDagNode } from '../api/types';
import { layoutDag } from '../lib/dag-layout';

interface Props {
  run: ConsoleDagRun;
}

const NODE_KIND_STYLES: Record<ConsoleDagNode['nodeKind'], { bg: string; border: string }> = {
  step: { bg: '#1e3a5f', border: '#3b82f6' },
  checkpoint: { bg: '#1a3d2e', border: '#22c55e' },
  blocked_attempt: { bg: '#3d1a1a', border: '#ef4444' },
};

export function RunDag({ run }: Props) {
  const { nodes, edges } = useMemo(() => {
    const positions = layoutDag(run.nodes, run.edges);

    const flowNodes: Node[] = run.nodes.map((node) => {
      const style = NODE_KIND_STYLES[node.nodeKind];
      const pos = positions[node.nodeId] ?? { x: 0, y: 0 };
      return {
        id: node.nodeId,
        position: pos,
        data: {
          label: formatNodeLabel(node),
        },
        style: {
          background: style.bg,
          border: `2px solid ${node.isPreferredTip ? '#fbbf24' : style.border}`,
          borderRadius: node.nodeKind === 'checkpoint' ? '50%' : '8px',
          color: '#fafafa',
          padding: '8px 12px',
          fontSize: '11px',
          fontFamily: 'monospace',
          width: node.nodeKind === 'checkpoint' ? 40 : undefined,
          height: node.nodeKind === 'checkpoint' ? 40 : undefined,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: node.isPreferredTip ? '0 0 12px rgba(251, 191, 36, 0.4)' : 'none',
        },
      };
    });

    const flowEdges: Edge[] = run.edges.map((edge, i) => ({
      id: `e-${i}`,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      style: {
        stroke: edge.edgeKind === 'checkpoint' ? '#22c55e' : '#3b82f6',
        strokeWidth: 2,
      },
      animated: edge.edgeKind === 'acked_step',
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [run]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      colorMode="dark"
    >
      <Background color="#333" gap={20} />
      <Controls />
    </ReactFlow>
  );
}

function formatNodeLabel(node: ConsoleDagNode): string {
  const short = node.nodeId.slice(-8);
  if (node.isPreferredTip) return `* ${short}`;
  if (node.isTip) return `> ${short}`;
  return short;
}
