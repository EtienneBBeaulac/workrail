/**
 * Ref Registry — Closed-Set Canonical Snippet Resolution
 *
 * Maps `wr.refs.*` IDs to canonical text content. All refs are
 * WorkRail-owned and resolved at compile time. Unknown IDs fail fast.
 *
 * Why closed-set: refs are part of the compiled workflow hash.
 * User-defined refs would break determinism across environments.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';

// ---------------------------------------------------------------------------
// Ref registry types
// ---------------------------------------------------------------------------

export type RefResolveError = {
  readonly code: 'UNKNOWN_REF';
  readonly refId: string;
  readonly message: string;
};

/** Read-only lookup interface for ref resolution. */
export interface RefRegistry {
  readonly resolve: (refId: string) => Result<string, RefResolveError>;
  readonly has: (refId: string) => boolean;
  readonly knownIds: () => readonly string[];
}

// ---------------------------------------------------------------------------
// Canonical ref content (closed set, WorkRail-owned)
// ---------------------------------------------------------------------------

const REF_CONTENT = {
  'wr.refs.memory_usage': [
    'If Memory MCP tools are available (memory_briefing, memory_store, memory_query):',
    '- Query Memory for relevant prior knowledge about this workspace before beginning work',
    '- After completing significant work, store key discoveries and decisions',
    '- Use descriptive topics and titles so future sessions can find them',
    '- Do not block on Memory failures — it is advisory, not load-bearing',
  ].join('\n'),

  'wr.refs.memory_store': [
    'If Memory MCP tools are available (memory_store):',
    '- Store the key findings from this phase with a descriptive topic and title',
    '- Include file paths, decisions made, and rationale',
    '- Do not block on Memory failures — continue regardless',
  ].join('\n'),

  'wr.refs.memory_query': [
    'If Memory MCP tools are available (memory_briefing, memory_query):',
    '- Check Memory for prior context relevant to this task',
    '- Use workspace-scoped queries to find related past work',
    '- Do not block on Memory failures — proceed without prior context if unavailable',
  ].join('\n'),
} as const satisfies Record<string, string>;

type KnownRefId = keyof typeof REF_CONTENT;

// ---------------------------------------------------------------------------
// Registry constructor
// ---------------------------------------------------------------------------

/** Create the canonical ref registry (frozen, closed-set). */
export function createRefRegistry(): RefRegistry {
  const knownIds = Object.keys(REF_CONTENT) as readonly KnownRefId[];

  return {
    resolve(refId: string): Result<string, RefResolveError> {
      const content = REF_CONTENT[refId as KnownRefId];
      if (content === undefined) {
        return err({
          code: 'UNKNOWN_REF',
          refId,
          message: `Unknown ref '${refId}'. Known refs: ${knownIds.join(', ')}`,
        });
      }
      return ok(content);
    },

    has(refId: string): boolean {
      return refId in REF_CONTENT;
    },

    knownIds(): readonly string[] {
      return knownIds;
    },
  };
}
