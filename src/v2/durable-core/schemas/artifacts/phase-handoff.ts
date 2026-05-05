import { z } from 'zod';
import type { DiscoveryHandoffArtifactV1 } from './discovery-handoff.js';

/**
 * Phase Handoff Artifact Schemas
 *
 * Typed artifacts for threading structured context between WorkTrain pipeline phases.
 * Each phase emits a handoff artifact at completion; the coordinator accumulates them
 * and calls buildContextSummary() to inject targeted context into the next phase.
 *
 * Pattern follows DiscoveryHandoffArtifactV1 and ReviewVerdictArtifactV1:
 * - Zod schema with .strict() for validation at coordinator read boundary
 * - Kind discriminant for type-guard
 * - CONTRACT_REF constant for outputContract declarations in workflow steps
 * - isX() type guard and parseX() helper
 *
 * WHY .strict(): prevents unknown fields from silently passing validation.
 * WHY z.optional() on arrays: new fields added to V1 schemas must not break
 * existing sessions that predate the field addition.
 */

// ═══════════════════════════════════════════════════════════════════════════
// SHAPING HANDOFF
// ═══════════════════════════════════════════════════════════════════════════

export const SHAPING_HANDOFF_CONTRACT_REF = 'wr.contracts.shaping_handoff' as const;

export const ShapingHandoffArtifactV1Schema = z
  .object({
    kind: z.literal('wr.shaping_handoff'),
    version: z.literal(1),

    /** Absolute path to the current-pitch.md file produced by this shaping session. */
    pitchPath: z.string().min(1),

    /** One sentence: which solution shape was chosen and why. */
    selectedShape: z.string().min(1).max(200),

    /** Time budget, e.g. "Small batch (1-2 days)", "Medium (1 week)". */
    appetite: z.string().min(1).max(100),

    /**
     * Design constraints the coding agent must respect.
     * Things the implementation MUST do or MUST NOT violate.
     * Priority 1 -- never dropped by buildContextSummary() trimming.
     */
    keyConstraints: z.array(z.string().min(1).max(200)).max(8),

    /**
     * Scope traps to avoid during implementation.
     * Things that look useful but are out of appetite.
     */
    rabbitHoles: z.array(z.string().min(1).max(200)).max(6),

    /**
     * Explicitly ruled out during shaping.
     * Prevents the coding agent from accidentally implementing excluded scope.
     * Priority 1 -- never dropped by buildContextSummary() trimming.
     */
    outOfScope: z.array(z.string().min(1).max(200)).max(6),

    /**
     * Verifiable acceptance criteria for the review agent.
     * Each item is a condition the review agent must check explicitly.
     * Priority 1 -- never dropped by buildContextSummary() trimming.
     * Examples: "All existing tests pass", "No new DB columns", "Auth middleware unchanged".
     */
    validationChecklist: z.array(z.string().min(1).max(200)).max(10),
  })
  .strict();

export type ShapingHandoffArtifactV1 = z.infer<typeof ShapingHandoffArtifactV1Schema>;

export function isShapingHandoffArtifact(
  artifact: unknown,
): artifact is { readonly kind: 'wr.shaping_handoff' } {
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === 'wr.shaping_handoff'
  );
}

export function parseShapingHandoffArtifact(
  artifact: unknown,
): ShapingHandoffArtifactV1 | null {
  const result = ShapingHandoffArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CODING HANDOFF
// ═══════════════════════════════════════════════════════════════════════════

export const CODING_HANDOFF_CONTRACT_REF = 'wr.contracts.coding_handoff' as const;

export const CodingHandoffArtifactV1Schema = z
  .object({
    kind: z.literal('wr.coding_handoff'),
    version: z.literal(1),

    /** Git branch containing the changes produced by this coding session. */
    branchName: z.string().min(1),

    /**
     * Architectural decisions made during coding and WHY.
     * The review agent uses these to evaluate intent, not just diff.
     * Priority 1 -- never dropped by buildContextSummary() trimming.
     */
    keyDecisions: z.array(z.string().min(1).max(200)).max(8),

    /**
     * Known gaps, shortcuts, or deliberate limitations.
     * The review agent should not flag these as unexpected findings.
     */
    knownLimitations: z.array(z.string().min(1).max(200)).max(6),

    /**
     * Test files or test names added during this coding session.
     * Priority 3 -- dropped first when buildContextSummary() trims for budget.
     */
    testsAdded: z.array(z.string().min(1).max(200)).max(10),

    /**
     * Primary files changed during this coding session.
     * Orients the review and fix agents without reading the full diff.
     * Included for 'fix' target phase -- fix agent needs to know where to look.
     */
    filesChanged: z.array(z.string().min(1).max(300)).max(20),

    /**
     * Assumptions the original coding agent made that turned out to be wrong,
     * corrected by a subsequent fix/retry agent.
     *
     * WHY optional: populated by fix agents after corrections, NOT by the original
     * coding agent. Original coding sessions should omit this field entirely.
     * Only a re-run fix agent that corrected a prior assumption should populate it.
     *
     * Carries forward: "when WorkTrain is wrong about something, it acknowledges it
     * explicitly so the next session starts with accurate context." (vision requirement)
     */
    correctedAssumptions: z.array(z.object({
      assumed: z.string().min(1).max(200),
      actual: z.string().min(1).max(200),
    })).max(6).optional(),
  })
  .strict();

export type CodingHandoffArtifactV1 = z.infer<typeof CodingHandoffArtifactV1Schema>;

export function isCodingHandoffArtifact(
  artifact: unknown,
): artifact is { readonly kind: 'wr.coding_handoff' } {
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === 'wr.coding_handoff'
  );
}

export function parseCodingHandoffArtifact(
  artifact: unknown,
): CodingHandoffArtifactV1 | null {
  const result = CodingHandoffArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE HANDOFF ARTIFACT -- CLOSED DISCRIMINATED UNION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Closed discriminated union of all phase handoff artifacts.
 *
 * WHY discriminated union: exhaustive switch at every call site. Adding a new
 * phase requires adding a new variant -- the compiler enforces completeness.
 *
 * DiscoveryHandoffArtifactV1 is imported by type only -- its schema lives in
 * discovery-handoff.ts alongside its coordinator-specific renderHandoff() logic.
 */
export type PhaseHandoffArtifact =
  | DiscoveryHandoffArtifactV1
  | ShapingHandoffArtifactV1
  | CodingHandoffArtifactV1;
