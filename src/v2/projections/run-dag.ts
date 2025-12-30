import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';

/**
 * Safely extract nodeId from an event's scope (if present).
 * 
 * Rationale: Some events have scope.nodeId (e.g., node_created), others don't (e.g., edge_created).
 * TypeScript's type narrowing with `in` operator ensures type safety without unsafe casts.
 */
function extractNodeIdFromEvent(e: unknown): string | undefined {
  // Guard: e must be a plain object
  if (typeof e !== 'object' || e === null) return undefined;
  
  // Guard: check if scope property exists and is an object
  if (!('scope' in e)) return undefined;
  const scope = e.scope;
  if (typeof scope !== 'object' || scope === null) return undefined;
  
  // Guard: check if nodeId property exists and is a string
  if (!('nodeId' in scope)) return undefined;
  const nodeId = scope.nodeId;
  return typeof nodeId === 'string' ? nodeId : undefined;
}

/**
 * Closed set: NodeKind (step | checkpoint).
 *
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (`node_created`)
 *
 * Why closed:
 * - Prevents ad-hoc node kinds that would break deterministic projections
 * - Enables exhaustive handling in projections and Studio rendering
 *
 * Values:
 * - `step`: workflow advancement node (created by continue-workflow ack)
 * - `checkpoint`: durable progress marker (created by checkpoint_workflow)
 *
 * Usage:
 * - node_created.data.nodeKind
 */
export type NodeKindV2 = 'step' | 'checkpoint';

/**
 * Closed set: EdgeKind (acked_step | checkpoint).
 *
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (`edge_created`)
 *
 * Why closed:
 * - Prevents edge semantics drift (graph meaning must stay stable)
 * - Enables deterministic traversal and rendering
 *
 * Values:
 * - `acked_step`: parent → child after advancement is recorded
 * - `checkpoint`: parent → checkpoint without advancement
 *
 * Lock: For checkpoint edges, cause.kind must be checkpoint_created.
 *
 * Usage:
 * - edge_created.data.edgeKind
 */
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
    //
    // OPTIMIZATION (O(n) guarantee): We precompute lastActivityByNodeId in a single pass,
    // then compute max-to-root with caching. This is O(E + T*D) instead of O(T*E).
    // - E = event count
    // - T = tip count
    // - D = DAG depth (typically small)
    //
    // Algorithm:
    // 1. First pass: build lastActivityByNodeId[nodeId] = max eventIndex for events touching that node
    // 2. Second phase: for each tip, walk to root computing max(node activities) with caching

    // Step 1: Precompute lastActivityByNodeId in one pass over events.
    const lastActivityByNodeId: Record<string, number> = {};
    for (const n of Object.values(run.nodesById)) {
      lastActivityByNodeId[n.nodeId] = n.createdAtEventIndex;
    }

    for (const e of events) {
      if (e.kind === 'edge_created') {
        const activity = Math.max(
          lastActivityByNodeId[e.data.fromNodeId] ?? -1,
          lastActivityByNodeId[e.data.toNodeId] ?? -1,
          e.eventIndex
        );
        lastActivityByNodeId[e.data.fromNodeId] = activity;
        lastActivityByNodeId[e.data.toNodeId] = activity;
        continue;
      }
      const nodeId = extractNodeIdFromEvent(e);
      if (nodeId && nodeId in run.nodesById) {
        lastActivityByNodeId[nodeId] = Math.max(lastActivityByNodeId[nodeId] ?? -1, e.eventIndex);
      }
    }

    // Step 2: For each tip, compute max activity to root with caching.
    const parentById: Record<string, string | null> = {};
    for (const n of Object.values(run.nodesById)) parentById[n.nodeId] = n.parentNodeId;

    const maxActivityToRootCache: Record<string, number> = {};

    const maxActivityToRoot = (nodeId: string): number => {
      if (nodeId in maxActivityToRootCache) {
        return maxActivityToRootCache[nodeId]!;
      }

      let max = lastActivityByNodeId[nodeId] ?? -1;
      const parentId = parentById[nodeId];
      if (parentId) {
        max = Math.max(max, maxActivityToRoot(parentId));
      }

      maxActivityToRootCache[nodeId] = max;
      return max;
    };

    let bestTip = tips[0]!;
    let bestActivity = maxActivityToRoot(bestTip);

    for (let i = 1; i < tips.length; i++) {
      const tip = tips[i]!;
      const activity = maxActivityToRoot(tip);
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
