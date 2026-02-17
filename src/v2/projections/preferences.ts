import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';
import type { AutonomyV2, RiskPolicyV2 } from '../durable-core/schemas/session/preferences.js';

export type ProjectionError =
  | { readonly code: 'PROJECTION_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'PROJECTION_CORRUPTION_DETECTED'; readonly message: string };

type PreferencesChangedEventV1 = Extract<DomainEventV1, { kind: 'preferences_changed' }>;

export interface EffectivePreferencesV2 {
  readonly autonomy: AutonomyV2;
  readonly riskPolicy: RiskPolicyV2;
}

export interface NodePreferencesV2 {
  readonly nodeId: string;
  readonly effective: EffectivePreferencesV2;
  readonly changesAtThisNode: readonly PreferencesChangedEventV1[];
}

export interface PreferencesProjectionV2 {
  readonly byNodeId: Readonly<Record<string, NodePreferencesV2>>;
}

const defaultPrefs: EffectivePreferencesV2 = { autonomy: 'guided', riskPolicy: 'conservative' };

/**
 * Pure projection: derive effective preference snapshot per node with ancestry propagation.
 *
 * Lock intent:
 * - effective preferences are node-attached
 * - descendants inherit unless overridden
 * - preferences propagate down the ancestry chain
 */
export function projectPreferencesV2(
  events: readonly DomainEventV1[],
  parentByNodeId: Readonly<Record<string, string | null>>
): Result<PreferencesProjectionV2, ProjectionError> {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({ code: 'PROJECTION_INVARIANT_VIOLATION', message: 'Events must be sorted by eventIndex ascending' });
    }
  }

  const changesByNodeId: Record<string, PreferencesChangedEventV1[]> = {};
  for (const e of events) {
    if (e.kind !== EVENT_KIND.PREFERENCES_CHANGED) continue;
    const list = changesByNodeId[e.scope.nodeId] ?? [];
    list.push(e);
    changesByNodeId[e.scope.nodeId] = list;
  }

  const byNodeId: Record<string, NodePreferencesV2> = {};

  // Fail-closed: Return Result to allow cycle detection errors to propagate
  const ancestorChainOf = (nodeId: string): Result<readonly string[], ProjectionError> => {
    const chain: string[] = [];
    let cur: string | null = nodeId;
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) {
        // Fail-closed: cycle detected is an invariant violation, not a silent break
        return err({
          code: 'PROJECTION_INVARIANT_VIOLATION',
          message: `Cycle detected in parent graph at node: ${cur}`,
        });
      }
      visited.add(cur);
      chain.push(cur);
      cur = parentByNodeId[cur] ?? null;
    }
    return ok(chain.reverse()); // root → ... → nodeId
  };

  for (const nodeId of Object.keys(parentByNodeId)) {
    const chainRes = ancestorChainOf(nodeId);
    if (chainRes.isErr()) return err(chainRes.error);
    const chain = chainRes.value;

    // Walk the ancestry chain and apply effective preferences changes in order.
    let effective = defaultPrefs;
    const changesAtThisNode: PreferencesChangedEventV1[] = [];

    for (const ancestor of chain) {
      const changes = changesByNodeId[ancestor] ?? [];
      for (const change of changes) {
        effective = change.data.effective;
        if (ancestor === nodeId) {
          changesAtThisNode.push(change);
        }
      }
    }

    byNodeId[nodeId] = { nodeId, effective, changesAtThisNode };
  }

  return ok({ byNodeId });
}
