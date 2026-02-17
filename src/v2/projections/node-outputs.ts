import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND, OUTPUT_CHANNEL } from '../durable-core/constants.js';
import type { ProjectionError } from './projection-error.js';

/**
 * Closed set: OutputChannel (recap | artifact).
 *
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (`node_output_appended`)
 *
 * Why closed:
 * - Studio and projections rely on stable channel semantics
 * - Prevents ad-hoc channels that would fragment “current output” logic
 *
 * Values:
 * - `recap`: short human-readable recap (bounded; at most one current per node)
 * - `artifact`: durable artifact references (may have multiple)
 */
export type OutputChannelV2 = 'recap' | 'artifact';

export type OutputPayloadV2 =
  | { readonly payloadKind: 'notes'; readonly notesMarkdown: string }
  | { readonly payloadKind: 'artifact_ref'; readonly sha256: string; readonly contentType: string; readonly byteLength: number };

export interface NodeOutputV2 {
  readonly outputId: string;
  readonly outputChannel: OutputChannelV2;
  readonly payload: OutputPayloadV2;
  readonly supersedesOutputId?: string;
  readonly createdAtEventIndex: number;
}

export interface NodeOutputsViewV2 {
  readonly historyByChannel: Readonly<Record<OutputChannelV2, readonly NodeOutputV2[]>>;
  readonly currentByChannel: Readonly<Record<OutputChannelV2, readonly NodeOutputV2[]>>;
}

export interface NodeOutputsProjectionV2 {
  readonly nodesById: Readonly<Record<string, NodeOutputsViewV2>>;
}

/**
 * Pure projection: derives per-node output history and "current" outputs per channel.
 *
 * Locked: "current" outputs are those not superseded by a later output on the same node.
 * `supersedesOutputId` must be node-scoped + channel-scoped.
 */
export function projectNodeOutputsV2(events: readonly DomainEventV1[]): Result<NodeOutputsProjectionV2, ProjectionError> {
  const byNode: Record<
    string,
    {
      byChannel: Record<OutputChannelV2, NodeOutputV2[]>;
    }
  > = {};

  const ensure = (nodeId: string) => {
    const existing = byNode[nodeId];
    if (existing) return existing;
    const created = { byChannel: { recap: [], artifact: [] } as Record<OutputChannelV2, NodeOutputV2[]> };
    byNode[nodeId] = created;
    return created;
  };

  // Collect history in deterministic order (events are assumed sorted by eventIndex ascending).
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({ code: 'PROJECTION_INVARIANT_VIOLATION', message: 'Events must be sorted by eventIndex ascending' });
    }
  }

  for (const e of events) {
    if (e.kind !== EVENT_KIND.NODE_OUTPUT_APPENDED) continue;

    const nodeId = e.scope.nodeId;
    const out: NodeOutputV2 = {
      outputId: e.data.outputId,
      outputChannel: e.data.outputChannel,
      payload: e.data.payload,
      supersedesOutputId: e.data.supersedesOutputId,
      createdAtEventIndex: e.eventIndex,
    };

    ensure(nodeId).byChannel[out.outputChannel].push(out);
  }

  const nodesById: Record<string, NodeOutputsViewV2> = {};

  for (const [nodeId, record] of Object.entries(byNode)) {
    const historyByChannel: Record<OutputChannelV2, NodeOutputV2[]> = {
      recap: record.byChannel.recap,
      artifact: record.byChannel.artifact,
    };

    const currentByChannel: Record<OutputChannelV2, NodeOutputV2[]> = {
      recap: [],
      artifact: [],
    };

    for (const channel of [OUTPUT_CHANNEL.RECAP, OUTPUT_CHANNEL.ARTIFACT] as const) {
      const history = historyByChannel[channel];

      // Build supersession graph: outputId → what supersedes it
      const supersededBy = new Map<string, string>();
      const outputIdSet = new Set<string>();

      for (const o of history) {
        outputIdSet.add(o.outputId);
        if (o.supersedesOutputId) {
          // Enforce node-scoped + channel-scoped supersedes (projection-level corruption detection).
          if (!outputIdSet.has(o.supersedesOutputId)) {
            return err({
              code: 'PROJECTION_CORRUPTION_DETECTED',
              message: `supersedesOutputId references missing output (nodeId=${nodeId}, channel=${channel}, supersedes=${o.supersedesOutputId})`,
            });
          }
          supersededBy.set(o.supersedesOutputId, o.outputId);
        }
      }

      // Compute transitive closure: mark ALL outputs in supersession chains as superseded
      const transitivelySuperseded = new Set<string>();

      for (const output of history) {
        let cur: string | undefined = output.outputId;
        const visited = new Set<string>();

        // Walk forward through supersession chain (output → what supersedes it)
        while (cur && supersededBy.has(cur)) {
          if (visited.has(cur)) {
            // Cycle in supersession chain - fail-closed
            return err({
              code: 'PROJECTION_INVARIANT_VIOLATION',
              message: `Cycle detected in supersession chain at output: ${cur}`,
            });
          }
          visited.add(cur);
          transitivelySuperseded.add(cur);  // ✅ Mark as superseded
          cur = supersededBy.get(cur);
        }
      }

      // Current outputs = not transitively superseded
      const current = history.filter((o) => !transitivelySuperseded.has(o.outputId));

      // Additional invariant: recap channel should have at most one current output.
      if (channel === OUTPUT_CHANNEL.RECAP && current.length > 1) {
        return err({
          code: 'PROJECTION_CORRUPTION_DETECTED',
          message: `Multiple current recap outputs detected for nodeId=${nodeId}`,
        });
      }

      currentByChannel[channel] = current;
    }

    nodesById[nodeId] = {
      historyByChannel,
      currentByChannel,
    };
  }

  return ok({ nodesById });
}
