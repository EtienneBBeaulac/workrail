/**
 * Feature Registry — Closed-Set Compiler Middleware
 *
 * Maps `wr.features.*` IDs to feature definitions. Each feature
 * specifies content to inject into promptBlocks sections.
 *
 * Features are cross-cutting concerns applied at the workflow level.
 * The compiler applies declared features to every step that uses
 * promptBlocks, injecting constraints, procedure steps, etc.
 *
 * Why closed-set: features modify compiled content that becomes part
 * of the workflow hash. User-defined features would break determinism.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { PromptValue } from './prompt-blocks.js';

// ---------------------------------------------------------------------------
// Feature definition types
// ---------------------------------------------------------------------------

/**
 * A feature definition describes content to inject into promptBlocks.
 *
 * Each field maps to a promptBlocks section. Injected content is
 * appended to existing content (never replaces).
 */
export interface FeatureDefinition {
  readonly id: string;
  /** Constraints to append to every step's constraints block. */
  readonly constraints?: readonly PromptValue[];
  /** Procedure steps to append to every step's procedure block. */
  readonly procedure?: readonly PromptValue[];
  /** Verify items to append to every step's verify block. */
  readonly verify?: readonly PromptValue[];
}

export type FeatureResolveError = {
  readonly code: 'UNKNOWN_FEATURE';
  readonly featureId: string;
  readonly message: string;
};

/** Read-only lookup interface for feature resolution. */
export interface FeatureRegistry {
  readonly resolve: (featureId: string) => Result<FeatureDefinition, FeatureResolveError>;
  readonly has: (featureId: string) => boolean;
  readonly knownIds: () => readonly string[];
}

// ---------------------------------------------------------------------------
// Canonical feature definitions (closed set, WorkRail-owned)
// ---------------------------------------------------------------------------

const FEATURE_DEFINITIONS: readonly FeatureDefinition[] = [
  {
    id: 'wr.features.memory_context',
    constraints: [
      [
        { kind: 'ref', refId: 'wr.refs.memory_usage' },
      ],
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Registry constructor
// ---------------------------------------------------------------------------

/** Create the canonical feature registry (frozen, closed-set). */
export function createFeatureRegistry(): FeatureRegistry {
  const byId = new Map(FEATURE_DEFINITIONS.map(f => [f.id, f]));
  const knownIds = FEATURE_DEFINITIONS.map(f => f.id);

  return {
    resolve(featureId: string): Result<FeatureDefinition, FeatureResolveError> {
      const def = byId.get(featureId);
      if (!def) {
        return err({
          code: 'UNKNOWN_FEATURE',
          featureId,
          message: `Unknown feature '${featureId}'. Known features: ${knownIds.join(', ')}`,
        });
      }
      return ok(def);
    },

    has(featureId: string): boolean {
      return byId.has(featureId);
    },

    knownIds(): readonly string[] {
      return knownIds;
    },
  };
}
