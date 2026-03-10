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

  'wr.refs.notes_first_durability': [
    'Durability rules (notes-first):',
    '- Use output.notesMarkdown as the primary durable record for every step',
    '- Keep execution truth in notes and explicit context variables, not in markdown sidecar files',
    '- Human-facing artifacts (review docs, plans) are for readability only — they are NOT required workflow memory',
    '- If a chat rewind occurs, the durable notes and context variables survive; sidecar files may not',
    '- Always record key decisions, findings, and rationale in notesMarkdown before advancing',
  ].join('\n'),

  'wr.refs.synthesis_under_disagreement': [
    'Synthesis rules when parallel outputs disagree:',
    '- Treat disagreement as first-class work — never handwave contradictory outputs',
    '- If 2+ parallel outputs flag the same issue at the same severity, treat it as validated',
    '- If the same issue is flagged at different severities, default to the higher severity unless the lower-severity position includes specific counter-evidence',
    '- If one output flags an issue and others are silent, investigate it but do not automatically block unless it is clearly critical',
    '- If one output says false positive and another says valid issue, require explicit main-agent adjudication in notes before finalization',
    '- If outputs show material disagreement, findings override any preliminary recommendation until the disagreement is reconciled',
    '- Document every resolved contradiction with its resolution rationale',
  ].join('\n'),

  'wr.refs.parallelize_cognition_serialize_synthesis': [
    'Parallelism rules:',
    '- Parallelize independent cognition: context gathering, hypothesis generation, audit routines, and reviewer families can run simultaneously',
    '- Serialize synthesis: merging parallel outputs, resolving contradictions, making canonical decisions, and writing final artifacts must happen sequentially by the main agent',
    '- Never let a parallel subagent finalize or commit to a canonical answer — the main agent owns synthesis and final decisions',
    '- Prefer one compact targeted bundle over multiple small sequential delegation moments',
    '- When spawning parallel executors, give each a clear, non-overlapping focus area',
  ].join('\n'),

  'wr.refs.adversarial_challenge_rules': [
    'Adversarial challenge rules:',
    '- Actively try to break the current leading position — do not just look for confirming evidence',
    '- For each finding or conclusion, ask: what evidence would disprove this? Is that evidence missing or present?',
    '- If the challenge cannot materially weaken the position, the position is strengthened',
    '- If the challenge reveals a genuine weakness, it must be recorded as a finding and the position must be updated',
    '- Do not soften findings to avoid conflict — severity should reflect actual risk, not social comfort',
    '- Challenge severity inflation as well as severity deflation — false positives waste as much attention as false negatives',
    '- If 2+ independent challengers raise the same serious concern, treat it as blocking by default',
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
