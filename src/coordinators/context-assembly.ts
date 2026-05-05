import type { ZodType, ZodTypeDef } from 'zod';
import type {
  DiscoveryHandoffArtifactV1,
  ShapingHandoffArtifactV1,
  CodingHandoffArtifactV1,
  PhaseHandoffArtifact,
} from '../v2/durable-core/schemas/artifacts/index.js';

/**
 * Context Assembly -- pure functions for inter-phase context threading.
 *
 * All functions in this module are pure (no I/O, no side effects).
 * They are called by coordinator mode files before each spawnSession() call.
 *
 * Key functions:
 * - extractPhaseArtifact<T>(): validate and extract a typed artifact from artifacts[]
 * - buildContextSummary(): select and render targeted context per target phase
 *
 * WHY pure functions (not methods on a class):
 * Compose with small pure functions. Testable in isolation. No hidden state.
 */

/** Maximum bytes for assembledContextSummary injection into buildSystemPrompt(). */
const MAX_CONTEXT_BYTES = 8192;

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACT PHASE ARTIFACT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract and validate a typed artifact from an artifacts array.
 *
 * Validates at the boundary (Zod safeParse), returns null on failure.
 * Replaces the scattered inline readXxxArtifact() functions in coordinator modes.
 *
 * @param artifacts - Raw artifacts[] from getAgentResult()
 * @param schema - Zod schema to validate against
 * @param kindPredicate - Type guard for the kind discriminant (cheap pre-filter)
 */
export function extractPhaseArtifact<T>(
  artifacts: readonly unknown[],
  schema: ZodType<T, ZodTypeDef, unknown>,
  kindPredicate: (a: unknown) => boolean,
): T | null {
  const candidates = artifacts.filter(kindPredicate);
  if (candidates.length === 0) return null;

  const result = schema.safeParse(candidates[0]);
  return result.success ? result.data : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILD CONTEXT SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a targeted context summary string for injection into the next phase's system prompt.
 *
 * Selects only the fields relevant to the target phase -- never a full dump.
 * Applies priority-ordered trimming when output approaches the 8KB cap:
 *   Priority 1 (always included): hard constraints, rationale, acceptance criteria
 *   Priority 2 (included if budget allows): design context, invariants, rabbit holes
 *   Priority 3 (included last, dropped first): orientation aids (file lists, test names)
 *
 * INVARIANT: sections are rendered as complete units. Never truncate mid-array.
 * If a section does not fit, omit it entirely.
 *
 * Per-phase selection table:
 *   shaping:  discovery selectedDirection, rejectedDirections, implementationConstraints,
 *             keyInvariants, keyCodebaseLocations
 *   coding:   discovery implementationConstraints, keyInvariants, keyCodebaseLocations
 *             + shaping selectedShape, appetite, keyConstraints, rabbitHoles, outOfScope
 *   review:   discovery implementationConstraints, keyInvariants
 *             + shaping keyConstraints, outOfScope, validationChecklist
 *             + coding keyDecisions, knownLimitations, filesChanged, correctedAssumptions
 *   fix:      shaping keyConstraints, outOfScope, validationChecklist
 *             + coding keyDecisions, knownLimitations, filesChanged, correctedAssumptions
 *             (fix agent needs filesChanged to know where to look)
 */
export function buildContextSummary(
  priorArtifacts: readonly PhaseHandoffArtifact[],
  targetPhase: 'shaping' | 'coding' | 'review' | 'fix',
): string {
  const discovery = priorArtifacts.find(
    (a): a is DiscoveryHandoffArtifactV1 => a.kind === 'wr.discovery_handoff',
  ) ?? null;
  const shaping = priorArtifacts.find(
    (a): a is ShapingHandoffArtifactV1 => a.kind === 'wr.shaping_handoff',
  ) ?? null;
  const coding = priorArtifacts.find(
    (a): a is CodingHandoffArtifactV1 => a.kind === 'wr.coding_handoff',
  ) ?? null;

  // Build ordered sections: [priority, rendered markdown]
  // Lower priority number = higher importance = never dropped
  type Section = { readonly priority: 1 | 2 | 3; readonly content: string };
  const sections: Section[] = [];

  switch (targetPhase) {
    case 'shaping': {
      if (discovery) {
        // Priority 1: constraints and direction
        if (discovery.implementationConstraints?.length) {
          sections.push({ priority: 1, content: renderList('Implementation Constraints', discovery.implementationConstraints) });
        }
        // Priority 1: selected direction (shaping needs to know what won)
        sections.push({ priority: 1, content: `**Selected Direction:** ${discovery.selectedDirection}` });
        // Priority 2: invariants and rejected directions
        if (discovery.keyInvariants.length) {
          sections.push({ priority: 2, content: renderList('Key Invariants', discovery.keyInvariants) });
        }
        if (discovery.rejectedDirections?.length) {
          sections.push({ priority: 2, content: renderRejectedDirections(discovery.rejectedDirections) });
        }
        // Priority 3: codebase locations
        if (discovery.keyCodebaseLocations?.length) {
          sections.push({ priority: 3, content: renderCodebaseLocations(discovery.keyCodebaseLocations) });
        }
      }
      break;
    }

    case 'coding': {
      if (discovery) {
        // Priority 1: implementation constraints
        if (discovery.implementationConstraints?.length) {
          sections.push({ priority: 1, content: renderList('Implementation Constraints', discovery.implementationConstraints) });
        }
        // Priority 2: invariants
        if (discovery.keyInvariants.length) {
          sections.push({ priority: 2, content: renderList('Key Invariants', discovery.keyInvariants) });
        }
        // Priority 3: codebase locations
        if (discovery.keyCodebaseLocations?.length) {
          sections.push({ priority: 3, content: renderCodebaseLocations(discovery.keyCodebaseLocations) });
        }
      }
      if (shaping) {
        // Priority 1: constraints and out-of-scope
        sections.push({ priority: 1, content: `**Selected Shape:** ${shaping.selectedShape}\n**Appetite:** ${shaping.appetite}` });
        if (shaping.keyConstraints.length) {
          sections.push({ priority: 1, content: renderList('Key Constraints', shaping.keyConstraints) });
        }
        if (shaping.outOfScope.length) {
          sections.push({ priority: 1, content: renderList('Out of Scope', shaping.outOfScope) });
        }
        // Priority 2: rabbit holes
        if (shaping.rabbitHoles.length) {
          sections.push({ priority: 2, content: renderList('Rabbit Holes', shaping.rabbitHoles) });
        }
      }
      break;
    }

    case 'review': {
      if (discovery) {
        if (discovery.implementationConstraints?.length) {
          sections.push({ priority: 1, content: renderList('Implementation Constraints', discovery.implementationConstraints) });
        }
        if (discovery.keyInvariants.length) {
          sections.push({ priority: 2, content: renderList('Key Invariants', discovery.keyInvariants) });
        }
      }
      if (shaping) {
        // Priority 1: validation checklist (spec-as-ground-truth)
        if (shaping.validationChecklist.length) {
          sections.push({ priority: 1, content: renderList('Validation Checklist (check each explicitly)', shaping.validationChecklist) });
        }
        if (shaping.keyConstraints.length) {
          sections.push({ priority: 1, content: renderList('Key Constraints', shaping.keyConstraints) });
        }
        if (shaping.outOfScope.length) {
          sections.push({ priority: 1, content: renderList('Out of Scope', shaping.outOfScope) });
        }
      }
      if (coding) {
        // Priority 1: decisions and corrections
        if (coding.keyDecisions.length) {
          sections.push({ priority: 1, content: renderList('Coding Decisions (WHY)', coding.keyDecisions) });
        }
        if (coding.correctedAssumptions?.length) {
          sections.push({ priority: 1, content: renderCorrectedAssumptions(coding.correctedAssumptions) });
        }
        if (coding.knownLimitations.length) {
          sections.push({ priority: 2, content: renderList('Known Limitations', coding.knownLimitations) });
        }
        // Priority 3: files changed
        if (coding.filesChanged.length) {
          sections.push({ priority: 3, content: renderList('Files Changed', coding.filesChanged) });
        }
      }
      break;
    }

    case 'fix': {
      if (shaping) {
        if (shaping.validationChecklist.length) {
          sections.push({ priority: 1, content: renderList('Validation Checklist', shaping.validationChecklist) });
        }
        if (shaping.keyConstraints.length) {
          sections.push({ priority: 1, content: renderList('Key Constraints', shaping.keyConstraints) });
        }
        if (shaping.outOfScope.length) {
          sections.push({ priority: 1, content: renderList('Out of Scope', shaping.outOfScope) });
        }
      }
      if (coding) {
        if (coding.keyDecisions.length) {
          sections.push({ priority: 1, content: renderList('Coding Decisions (WHY)', coding.keyDecisions) });
        }
        if (coding.correctedAssumptions?.length) {
          sections.push({ priority: 1, content: renderCorrectedAssumptions(coding.correctedAssumptions) });
        }
        if (coding.knownLimitations.length) {
          sections.push({ priority: 2, content: renderList('Known Limitations', coding.knownLimitations) });
        }
        // Priority 3: files changed -- fix agent needs to know WHERE to look
        if (coding.filesChanged.length) {
          sections.push({ priority: 3, content: renderList('Files Changed', coding.filesChanged) });
        }
      }
      break;
    }
  }

  if (sections.length === 0) return '';

  // Apply priority-ordered trimming: always include P1, then P2, then P3
  // INVARIANT: omit a complete section rather than truncating mid-array
  return buildBudgetedOutput(sections);
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERING HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function renderList(heading: string, items: readonly string[]): string {
  return `**${heading}:**\n${items.map((i) => `- ${i}`).join('\n')}`;
}

function renderRejectedDirections(
  directions: readonly { readonly direction: string; readonly reason: string }[],
): string {
  return `**Rejected Directions:**\n${directions.map((d) => `- ${d.direction} -- ${d.reason}`).join('\n')}`;
}

function renderCodebaseLocations(
  locations: readonly { readonly path: string; readonly relevance: string }[],
): string {
  return `**Key Codebase Locations:**\n${locations.map((l) => `- \`${l.path}\` -- ${l.relevance}`).join('\n')}`;
}

function renderCorrectedAssumptions(
  corrections: readonly { readonly assumed: string; readonly actual: string }[],
): string {
  return `**Corrected Assumptions (prior phase was wrong about these):**\n${corrections.map((c) => `- Assumed: ${c.assumed}\n  Actual: ${c.actual}`).join('\n')}`;
}

/**
 * Build output string respecting the 8KB budget.
 * Processes sections in priority order (1 first, 3 last).
 * Omits a complete section if it would exceed the budget -- never truncates mid-section.
 */
function buildBudgetedOutput(
  sections: ReadonlyArray<{ readonly priority: 1 | 2 | 3; readonly content: string }>,
): string {
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  const included: string[] = [];
  let bytesUsed = 0;

  for (const section of ordered) {
    const sectionBytes = Buffer.byteLength(section.content + '\n\n', 'utf8');
    if (bytesUsed + sectionBytes <= MAX_CONTEXT_BYTES) {
      included.push(section.content);
      bytesUsed += sectionBytes;
    }
    // If section doesn't fit, skip it entirely (never truncate mid-section)
  }

  return included.join('\n\n');
}
