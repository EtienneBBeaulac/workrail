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
  {
    id: 'wr.features.subagent_guidance',
    constraints: [
      'Use the WorkRail Executor as the only subagent model. Do not refer to or rely on named Builder, Researcher, or other identities.',
      'The main agent owns strategy, decisions, synthesis, and final outputs. Subagents provide independent cognitive perspectives only.',
      [
        { kind: 'ref', refId: 'wr.refs.parallelize_cognition_serialize_synthesis' },
      ],
    ],
    procedure: [
      'When delegating to WorkRail Executors, provide each with a clear non-overlapping focus and the shared fact packet or context as primary truth.',
      'After receiving parallel subagent outputs, synthesize them yourself — do not let any single subagent output become the canonical answer without main-agent review.',
    ],
    verify: [
      'All delegated outputs were synthesized by the main agent, not adopted verbatim.',
      'No subagent was given final decision authority over canonical findings, recommendations, or artifacts.',
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
