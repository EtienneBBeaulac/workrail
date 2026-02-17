import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';

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
export type NodeKindV2 = 'step' | 'checkpoint' | 'blocked_attempt';

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

import type { ProjectionError } from './projection-error.js';

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

export type WorkflowIdentity =
  | { readonly kind: 'no_workflow' }
  | { readonly kind: 'with_workflow'; readonly workflowId: string; readonly workflowHash: string };

export interface RunDagRunV2 {
  readonly runId: string;
  readonly workflow: WorkflowIdentity;
  readonly nodesById: Readonly<Record<string, RunDagNodeV2>>;
  readonly edges: readonly RunDagEdgeV2[];
  readonly tipNodeIds: readonly string[];
  readonly preferredTipNodeId: string | null;
}

export interface RunDagProjectionV2 {
  readonly runsById: Readonly<Record<string, RunDagRunV2>>;
}

/**
 * Precompute last activity timestamp (eventIndex) for each node in the DAG.
 *
 * Algorithm:
 * 1. Initialize with node creation timestamps
 * 2. Update with edge creation events (touches both fromNode and toNode)
 * 3. Update with any event that has nodeId in scope
 *
 * @param run - The run containing nodes to compute activity for
 * @param events - All events in the session
 * @returns Map from nodeId to max eventIndex touching that node
 */
function computeLastActivityByNodeId(
  run: { readonly nodesById: Record<string, RunDagNodeV2> },
  events: readonly DomainEventV1[]
): Record<string, number> {
  const lastActivityByNodeId: Record<string, number> = {};
  
  // Initialize with node creation timestamps
  for (const n of Object.values(run.nodesById)) {
    lastActivityByNodeId[n.nodeId] = n.createdAtEventIndex;
  }

  // Update with events touching nodes
  for (const e of events) {
    if (e.kind === EVENT_KIND.EDGE_CREATED) {
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

  return lastActivityByNodeId;
}

/**
 * Select the preferred tip from multiple tips using a 4-phase algorithm.
 *
 * Locked algorithm phases:
 * 1. **Max activity to root**: Choose tip(s) with highest ancestor activity
 * 2. **Tie-breaker: creation eventIndex**: Among tied tips, prefer latest created
 * 3. **Tie-breaker: lexicographic nodeId**: Among still-tied tips, prefer smallest nodeId
 *
 * The activity-to-root is computed with caching to ensure O(T*D) complexity
 * where T = tip count, D = DAG depth.
 *
 * @param tips - Array of tip nodeIds (nodes with no outgoing edges)
 * @param nodesById - Map of all nodes in the run
 * @param lastActivityByNodeId - Precomputed activity timestamps per node
 * @returns The nodeId of the preferred tip
 */
function selectPreferredTip(
  tips: readonly string[],
  nodesById: Record<string, RunDagNodeV2>,
  lastActivityByNodeId: Record<string, number>
): string {
  // Build parent lookup for traversal
  const parentById: Record<string, string | null> = {};
  for (const n of Object.values(nodesById)) {
    parentById[n.nodeId] = n.parentNodeId;
  }

  // Cache for max activity from node to root
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

  // Phase 1: Find tip(s) with max activity
  let bestTip = tips[0]!;
  let bestActivity = maxActivityToRoot(bestTip);

  for (let i = 1; i < tips.length; i++) {
    const tip = tips[i]!;
    const activity = maxActivityToRoot(tip);
    if (activity > bestActivity) {
      bestTip = tip;
      bestActivity = activity;
    } else if (activity === bestActivity) {
      // Phase 2: Tie-breaker by node creation eventIndex
      const bestCreated = nodesById[bestTip]!.createdAtEventIndex;
      const tipCreated = nodesById[tip]!.createdAtEventIndex;
      if (tipCreated > bestCreated) {
        bestTip = tip;
      } else if (tipCreated === bestCreated) {
        // Phase 3: Tie-breaker by lexicographic nodeId
        if (tip < bestTip) {
          bestTip = tip;
        }
      }
    }
  }

  return bestTip;
}

/**
 * Derive tip nodes and select the preferred tip for a run.
 *
 * A "tip" is a node with no outgoing edges (a leaf in the DAG).
 * The "preferred tip" is the single tip chosen by the selection algorithm.
 *
 * @param run - Mutable run to derive tips for
 * @param events - All events in the session
 * @returns Object with tipNodeIds array and preferredTipNodeId (or null if no tips)
 */
function deriveTipsAndPreferredTip(
  run: {
    readonly nodesById: Record<string, RunDagNodeV2>;
    readonly edges: readonly RunDagEdgeV2[];
  },
  events: readonly DomainEventV1[]
): { tipNodeIds: string[]; preferredTipNodeId: string | null } {
  // Find all tips: nodes with no outgoing edges
  const hasOutgoing = new Set(run.edges.map((e) => e.fromNodeId));
  const tips = Object.keys(run.nodesById).filter((id) => !hasOutgoing.has(id)).sort();

  if (tips.length === 0) {
    return { tipNodeIds: [], preferredTipNodeId: null };
  }

  if (tips.length === 1) {
    return { tipNodeIds: tips, preferredTipNodeId: tips[0]! };
  }

  // Multiple tips: use selection algorithm
  const lastActivity = computeLastActivityByNodeId(run, events);
  const preferred = selectPreferredTip(tips, run.nodesById, lastActivity);

  return { tipNodeIds: tips, preferredTipNodeId: preferred };
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

  const toWorkflowIdentity = (run: MutableRun): WorkflowIdentity => {
    if (run.workflowId !== null && run.workflowHash !== null) {
      return { kind: 'with_workflow', workflowId: run.workflowId, workflowHash: run.workflowHash };
    }
    return { kind: 'no_workflow' };
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
      case EVENT_KIND.RUN_STARTED: {
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
      case EVENT_KIND.NODE_CREATED: {
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
      case EVENT_KIND.EDGE_CREATED: {
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
    const derived = deriveTipsAndPreferredTip(run, events);
    run.tipNodeIds = derived.tipNodeIds;
    run.preferredTipNodeId = derived.preferredTipNodeId;
  }

  const runsById: Record<string, RunDagRunV2> = {};
  for (const [runId, run] of Object.entries(runs)) {
    runsById[runId] = {
      runId,
      workflow: toWorkflowIdentity(run),
      nodesById: run.nodesById,
      edges: run.edges,
      tipNodeIds: run.tipNodeIds,
      preferredTipNodeId: run.preferredTipNodeId,
    };
  }

  return ok({ runsById });
}
