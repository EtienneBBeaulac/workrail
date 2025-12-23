import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';

export type NodeKindV2 = 'step' | 'checkpoint';
export type EdgeKindV2 = 'acked_step' | 'checkpoint';

export type ProjectionError =
  | { readonly code: 'PROJECTION_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'PROJECTION_CORRUPTION_DETECTED'; readonly message: string };

export interface RunDagNodeV2 {
  readonly nodeId: string;
  readonly nodeKind: NodeKindV2;
  readonly parentNodeId: string | null;
  readonly workflowHash: string;
  readonly snapshotRef: string;
  readonly createdAtEventIndex: number;
}

export interface RunDagEdgeV2 {
  readonly edgeKind: EdgeKindV2;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly cause: { readonly kind: string; readonly eventId: string };
  readonly createdAtEventIndex: number;
}

export interface RunDagRunV2 {
  readonly runId: string;
  readonly workflowId: string | null;
  readonly workflowHash: string | null;
  readonly nodesById: Readonly<Record<string, RunDagNodeV2>>;
  readonly edges: readonly RunDagEdgeV2[];
  readonly tipNodeIds: readonly string[];
  readonly preferredTipNodeId: string | null;
}

export interface RunDagProjectionV2 {
  readonly runsById: Readonly<Record<string, RunDagRunV2>>;
}

/**
 * Pure projection: build a run DAG view from the append-only domain event log.
 *
 * Locked intent:
 * - deterministic
 * - no IO
 * - fails fast on impossible states
 */
export function projectRunDagV2(events: readonly DomainEventV1[]): Result<RunDagProjectionV2, ProjectionError> {
  // Expect caller to provide events in ascending eventIndex; enforce deterministically.
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({
        code: 'PROJECTION_INVARIANT_VIOLATION',
        message: 'Events must be sorted by eventIndex ascending',
      });
    }
  }

  type MutableRun = {
    runId: string;
    workflowId: string | null;
    workflowHash: string | null;
    nodesById: Record<string, RunDagNodeV2>;
    edges: RunDagEdgeV2[];
    // derived at end
    tipNodeIds: string[];
    preferredTipNodeId: string | null;
  };

  const runs: Record<string, MutableRun> = {};

  const ensureRun = (runId: string): MutableRun => {
    const existing = runs[runId];
    if (existing) return existing;
    const created: MutableRun = {
      runId,
      workflowId: null,
      workflowHash: null,
      nodesById: {},
      edges: [],
      tipNodeIds: [],
      preferredTipNodeId: null,
    };
    runs[runId] = created;
    return created;
  };

  for (const e of events) {
    switch (e.kind) {
      case 'run_started': {
        const runId = e.scope.runId;
        const run = ensureRun(runId);
        // Idempotent-ish: first wins, later must match or it's corruption.
        if (run.workflowHash && run.workflowHash !== e.data.workflowHash) {
          return err({
            code: 'PROJECTION_CORRUPTION_DETECTED',
            message: `run_started workflowHash mismatch for runId=${runId}`,
          });
        }
        run.workflowId = e.data.workflowId;
        run.workflowHash = e.data.workflowHash;
        break;
      }
      case 'node_created': {
        const runId = e.scope.runId;
        const nodeId = e.scope.nodeId;
        const run = ensureRun(runId);

        const existing = run.nodesById[nodeId];
        const node: RunDagNodeV2 = {
          nodeId,
          nodeKind: e.data.nodeKind,
          parentNodeId: e.data.parentNodeId,
          workflowHash: e.data.workflowHash,
          snapshotRef: e.data.snapshotRef,
          createdAtEventIndex: e.eventIndex,
        };

        if (existing) {
          // duplicate node_created is allowed only if identical (replay).
          if (JSON.stringify(existing) !== JSON.stringify(node)) {
            return err({
              code: 'PROJECTION_CORRUPTION_DETECTED',
              message: `node_created conflict for runId=${runId} nodeId=${nodeId}`,
            });
          }
        } else {
          // Enforce that parent (when present) exists earlier in the log.
          if (node.parentNodeId && !run.nodesById[node.parentNodeId]) {
            return err({
              code: 'PROJECTION_INVARIANT_VIOLATION',
              message: `node_created references missing parentNodeId=${node.parentNodeId} (runId=${runId} nodeId=${nodeId})`,
            });
          }
          run.nodesById[nodeId] = node;
        }
        break;
      }
      case 'edge_created': {
        const runId = e.scope.runId;
        const run = ensureRun(runId);

        const edge: RunDagEdgeV2 = {
          edgeKind: e.data.edgeKind,
          fromNodeId: e.data.fromNodeId,
          toNodeId: e.data.toNodeId,
          cause: e.data.cause,
          createdAtEventIndex: e.eventIndex,
        };

        // Enforce edges refer to known nodes.
        const from = run.nodesById[edge.fromNodeId];
        const to = run.nodesById[edge.toNodeId];
        if (!from || !to) {
          return err({
            code: 'PROJECTION_INVARIANT_VIOLATION',
            message: `edge_created references missing node(s) (runId=${runId} from=${edge.fromNodeId} to=${edge.toNodeId})`,
          });
        }

        // Lock: toNodeId.parentNodeId must equal fromNodeId.
        if (to.parentNodeId !== edge.fromNodeId) {
          return err({
            code: 'PROJECTION_CORRUPTION_DETECTED',
            message: `edge_created violates parent linkage (runId=${runId} to.parentNodeId=${String(
              to.parentNodeId
            )} from=${edge.fromNodeId})`,
          });
        }

        run.edges.push(edge);
        break;
      }
      default:
        // ignore other events for this projection
        break;
    }
  }

  // Derive tips + preferred tip deterministically.
  for (const runId of Object.keys(runs)) {
    const run = runs[runId]!;
    const hasOutgoing = new Set(run.edges.map((e) => e.fromNodeId));
    const tips = Object.keys(run.nodesById).filter((id) => !hasOutgoing.has(id)).sort();
    run.tipNodeIds = tips;

    if (tips.length === 0) {
      run.preferredTipNodeId = null;
      continue;
    }

    // Preferred tip policy (locked): choose leaf with highest "last activity" across its reachable history.
    // Reachable history is approximated as the node's ancestor chain (including itself).
    // lastActivity is max EventIndex among events touching any ancestor nodeId, plus edges that touch those nodes.
    const parentById: Record<string, string | null> = {};
    for (const n of Object.values(run.nodesById)) parentById[n.nodeId] = n.parentNodeId;

    const ancestryOf = (leafId: string): Set<string> => {
      const set = new Set<string>();
      let cur: string | null = leafId;
      while (cur) {
        if (set.has(cur)) break;
        set.add(cur);
        cur = parentById[cur] ?? null;
      }
      return set;
    };

    const lastActivityFor = (leafId: string): number => {
      const ancestors = ancestryOf(leafId);
      let max = run.nodesById[leafId]!.createdAtEventIndex;

      for (const e of events) {
        if (e.kind === 'edge_created') {
          if (ancestors.has(e.data.fromNodeId) || ancestors.has(e.data.toNodeId)) {
            if (e.eventIndex > max) max = e.eventIndex;
          }
          continue;
        }
        const nodeId = (e as any).scope?.nodeId as string | undefined;
        if (nodeId && ancestors.has(nodeId)) {
          if (e.eventIndex > max) max = e.eventIndex;
        }
      }

      return max;
    };

    let bestTip = tips[0]!;
    let bestActivity = lastActivityFor(bestTip);

    for (let i = 1; i < tips.length; i++) {
      const tip = tips[i]!;
      const activity = lastActivityFor(tip);
      if (activity > bestActivity) {
        bestTip = tip;
        bestActivity = activity;
      } else if (activity === bestActivity) {
        // Tie-breakers (locked): node_created index, then lexical nodeId.
        const bestCreated = run.nodesById[bestTip]!.createdAtEventIndex;
        const tipCreated = run.nodesById[tip]!.createdAtEventIndex;
        if (tipCreated > bestCreated) {
          bestTip = tip;
        } else if (tipCreated === bestCreated && tip < bestTip) {
          bestTip = tip;
        }
      }
    }

    run.preferredTipNodeId = bestTip;
  }

  const runsById: Record<string, RunDagRunV2> = {};
  for (const [runId, run] of Object.entries(runs)) {
    runsById[runId] = {
      runId,
      workflowId: run.workflowId,
      workflowHash: run.workflowHash,
      nodesById: run.nodesById,
      edges: run.edges,
      tipNodeIds: run.tipNodeIds,
      preferredTipNodeId: run.preferredTipNodeId,
    };
  }

  return ok({ runsById });
}
